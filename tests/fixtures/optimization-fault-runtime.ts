// Test-only composition around the actual gateway. Never a release entrypoint.
import {AsyncLocalStorage} from 'node:async_hooks';
import measuredWorker, {Registry as MeasuredRegistry,Workspace as MeasuredWorkspace} from './optimization-runtime.js';
import type {DurableObjectState,DurableObjectStorage} from '@cloudflare/workers-types';
import type {Env} from '../../apps/gateway/src/common.js';

const clocks=new AsyncLocalStorage<number>();
const realNow=Date.now.bind(Date);
Date.now=()=>clocks.getStore()??realNow();
interface Plan {
  now?:number; sqlPattern?:string; sqlSkip:number; sqlFailures:number;
  alarmFailures:number; sqlFaults:number; alarmFaults:number; starts:number;
  dropAckPath?:string; dropAcks:number; droppedAcks:number;
}
function stateWithFaults(state:DurableObjectState,plan:Plan):DurableObjectState {
  const sql=new Proxy(state.storage.sql,{get(target,key) {
    if(key==='exec')return (query:string,...args:(string|number|null|ArrayBuffer)[])=>{
      if(plan.sqlFailures>0&&new RegExp(plan.sqlPattern??'(?!)','i').test(query)) {
        if(plan.sqlSkip>0)plan.sqlSkip--;
        else {plan.sqlFailures--;plan.sqlFaults++;throw new Error('exceeded allowed rows written in durable objects free tier');}
      }
      return target.exec(query,...args);
    };
    const value=Reflect.get(target,key,target);
    return typeof value==='function'?value.bind(target):value;
  }});
  const storage=new Proxy(state.storage,{get(target,key) {
    if(key==='sql')return sql;
    if(key==='setAlarm')return (...args:Parameters<DurableObjectStorage['setAlarm']>)=>{
      if(plan.alarmFailures>0){plan.alarmFailures--;plan.alarmFaults++;throw new Error('fixture setAlarm unavailable');}
      return target.setAlarm(...args);
    };
    const value=Reflect.get(target,key,target);
    return typeof value==='function'?value.bind(target):value;
  }});
  return new Proxy(state,{get(target,key){
    if(key==='storage')return storage;
    const value=Reflect.get(target,key,target);
    return typeof value==='function'?value.bind(target):value;
  }});
}
type Inner=MeasuredRegistry|MeasuredWorkspace;
class FixtureObject {
  private readonly plan:Plan={sqlSkip:0,sqlFailures:0,alarmFailures:0,sqlFaults:0,alarmFaults:0,starts:1,dropAcks:0,droppedAcks:0};
  private readonly state:DurableObjectState;
  private inner:Inner;
  private cumulativeMetrics:Record<string,number>={};
  private grantRevocation?: {beforeAuthorization: number; grantId: string; revision: number; adminCredential: string};
  constructor(state:DurableObjectState,private readonly env:Env,private readonly kind:'registry'|'workspace') {
    this.state=stateWithFaults(state,this.plan);
    this.inner=this.create();
  }
  private create():Inner {
    return this.kind==='registry'?new MeasuredRegistry(this.state,this.env):new MeasuredWorkspace(this.state,this.env);
  }
  async fetch(request:Request):Promise<Response> {
    const path=new URL(request.url).pathname;
    if(path==='/__fixture_faults') {
      if(request.method==='POST') {
        const body=await request.json() as Partial<Plan>&{clearAlarm?:boolean};
        if(body.clearAlarm===true)await this.state.storage.deleteAlarm();
        if(body.now!==undefined)this.plan.now=body.now;
        if(body.sqlPattern!==undefined)this.plan.sqlPattern=body.sqlPattern;
        this.plan.sqlSkip=body.sqlSkip??0;
        this.plan.sqlFailures=body.sqlFailures??0;
        this.plan.alarmFailures=body.alarmFailures??0;
        this.plan.dropAckPath=body.dropAckPath;this.plan.dropAcks=body.dropAcks??0;
      }
      return Response.json(this.plan);
    }
    if(path==='/__fixture_metrics') {
      const current=await (await this.inner.fetch(request)).json() as Record<string,number>;
      return Response.json(Object.fromEntries(Object.entries(current).map(([key,value])=>[key,value+(this.cumulativeMetrics[key]??0)])));
    }
    if(path==='/__fixture_restart') {
      const current=await (await this.inner.fetch(new Request('https://internal/__fixture_metrics'))).json() as Record<string,number>;
      for(const [key,value] of Object.entries(current))this.cumulativeMetrics[key]=(this.cumulativeMetrics[key]??0)+value;
      this.inner=this.plan.now===undefined?this.create():clocks.run(this.plan.now,()=>this.create());this.plan.starts++;
      return Response.json({starts:this.plan.starts});
    }
    if(path==='/__fixture_alarm_if_due') {
      const deadline=await this.state.storage.getAlarm();
      const now=this.plan.now??realNow();
      if(deadline===null||deadline>now)return Response.json({fired:false,deadline});
      // Platform alarm delivery consumes its deadline before the callback.
      // This scheduler action is fixture administration, not a product call.
      await this.state.storage.deleteAlarm();
      try {await this.alarm();return Response.json({fired:true,deadline});}
      catch{return Response.json({fired:true,failed:true,deadline},{status:503});}
    }
    if(path==='/__fixture_alarm') {
      try {await this.alarm();return Response.json({ok:true});}
      catch{return Response.json({ok:false},{status:503});}
    }
    if (path === '/__fixture_revoke_before_authorization' && this.kind === 'registry') {
      if (request.method === 'POST') {
        this.grantRevocation = await request.json() as NonNullable<FixtureObject['grantRevocation']>;
      }
      return Response.json({armed: this.grantRevocation !== undefined});
    }
    const revocation = this.grantRevocation;
    if (path === '/internal/authorize' && revocation && --revocation.beforeAuthorization === 0) {
      this.grantRevocation = undefined;
      const revoke = await this.inner.fetch(new Request(
        'https://internal/api/v1/admin/grants/' + revocation.grantId + '/revoke', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json', Authorization: 'Bearer ' + revocation.adminCredential,
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({expectedRevision: revocation.revision}),
        },
      ));
      if (!revoke.ok) throw new Error('Synthetic Registry revocation failed.');
    }
    const run=()=>this.inner.fetch(request);
    const response=await (this.plan.now===undefined?run():clocks.run(this.plan.now,run));
    if(response.ok&&path===this.plan.dropAckPath&&this.plan.dropAcks>0) {
      this.plan.dropAcks--;this.plan.droppedAcks++;
      return Response.json({code:'GATEWAY_DEGRADED',message:'Synthetic lost acknowledgement'},{status:503});
    }
    return response;
  }
  async alarm():Promise<void> {
    const run=()=>this.inner.alarm();
    return this.plan.now===undefined?run():clocks.run(this.plan.now,run);
  }
}
export class Registry extends FixtureObject {
  constructor(state:DurableObjectState,env:Env){super(state,env,'registry');}
}
export class Workspace extends FixtureObject {
  constructor(state:DurableObjectState,env:Env){super(state,env,'workspace');}
}
export default measuredWorker;
