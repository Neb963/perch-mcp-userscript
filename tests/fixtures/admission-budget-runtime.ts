// Test-only fixed fault actions; never an exported release RPC.
import worker,{Registry,Workspace as FaultWorkspace} from './optimization-fault-runtime.js';
import {SqlRecords} from '../../apps/gateway/src/sql.js';
import {ADMISSION_BUDGET_KEY,admissionBudgetPolicy,zeroBudget,type BudgetState} from '../../apps/gateway/src/admission-budget.js';
import type {DurableObjectState} from '@cloudflare/workers-types';
import type {Env} from '../../apps/gateway/src/common.js';
export {Registry};
export class Workspace extends FaultWorkspace {
  private readonly fixtureState:DurableObjectState;
  constructor(state:DurableObjectState,private readonly fixtureEnv:Env){super(state,fixtureEnv);this.fixtureState=state;}
  async fetch(request:Request):Promise<Response> {
    if(new URL(request.url).pathname!=='/__fixture_budget')return super.fetch(request);
    const db=new SqlRecords(this.fixtureState.storage);
    if(request.method==='POST') {
      const body=await request.json() as {action:string;ratio?:number;now?:number};
      if(body.action==='saturate') {
        const state=db.get<BudgetState>(ADMISSION_BUDGET_KEY);
        if(!state)return Response.json({error:'Fixture budget is not initialized'},{status:409});
        state.reserved=zeroBudget();state.reserved.sqlWrites=Math.ceil(admissionBudgetPolicy(this.fixtureEnv).caps.sqlWrites*(body.ratio??1));
        db.put(ADMISSION_BUDGET_KEY,state);
      } else if(body.action==='corrupt') {
        const state=db.get<BudgetState>(ADMISSION_BUDGET_KEY);
        db.put(ADMISSION_BUDGET_KEY,{...state,reserved:{...state.reserved,sqlWrites:'corrupt'}});
      } else if(body.action==='delete') db.delete(ADMISSION_BUDGET_KEY);
      else if(body.action==='clock'&&typeof body.now==='number'&&Number.isSafeInteger(body.now)) {
        // Seed the fixture lease as if it had been claimed at this synthetic
        // instant; preserve every identity, Epoch, permission and secret digest.
        const lease=db.get<Record<string,unknown>>('lease');
        db.put('lease',{...lease,claimedAt:body.now,expiresAt:body.now+180000});
        await super.fetch(new Request('https://internal/__fixture_faults',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({now:body.now})}));
      } else return Response.json({error:'Unknown fixed fixture action'},{status:400});
    }
    return Response.json({state:db.get<BudgetState>(ADMISSION_BUDGET_KEY)??null});
  }
}
export default worker;
