// Test-only entrypoint. Never included in release or deployed Worker.
import { AsyncLocalStorage } from 'node:async_hooks';
import worker, { Registry as BaseRegistry, Workspace as BaseWorkspace } from '../../apps/gateway/src/index.js';
import type { DurableObjectState, DurableObjectStorage, ExecutionContext, WebSocket as DurableSocket } from '@cloudflare/workers-types';
import type { Env } from '../../apps/gateway/src/common.js';

function metrics() {
  return { requests: 0, kvGet: 0, kvPut: 0, kvDelete: 0, kvList: 0,
    alarmGet: 0, alarmSet: 0, alarmDelete: 0, alarmInvocations: 0,
    sqlReads: 0, sqlWrites: 0, sqlStatements: 0, sqlFailures: 0, responseBytes: 0,
    wallMs: 0, coldStarts: 1, wsAccepted: 0, wsIncoming: 0, wsIncomingBytes: 0, wsCloseEvents: 0 };
}
type Metrics = ReturnType<typeof metrics>;
// Explicitly requested, request-local synthetic authority trace; never deployed.
// Refuse to truncate evidence: the test must see every statement and lookup.
interface DiscoveryTrace { statements: Array<{sql:string;key:string|null}>; workspaceLookups:number; }
const discoveryTrace = new AsyncLocalStorage<DiscoveryTrace>();
function discoveryEnv(env:Env):Env {
  const ns=env.WORKSPACES;
  const workspaces=new Proxy(ns,{get(target,key) {
    const value=Reflect.get(target,key,target);
    if(typeof value!=='function')return value;
    return (...args:unknown[])=>{
      const trace=discoveryTrace.getStore();
      if(trace && (key==='get'||key==='getByName'))trace.workspaceLookups++;
      return value.apply(target,args);
    };
  }});
  return {...env,WORKSPACES:workspaces};
}
function wrappedStorage(storage: DurableObjectStorage, m: Metrics): DurableObjectStorage {
  const sql = new Proxy(storage.sql, { get(target, key) {
    if (key !== 'exec') return Reflect.get(target, key, target);
    return (...args: Parameters<typeof storage.sql.exec>) => {
      m.sqlStatements++;
      const trace=discoveryTrace.getStore();
      if(trace) {
        if(trace.statements.length>=128)throw new Error('FIXTURE_DISCOVERY_TRACE_OVERFLOW');
        const [sql,key]=args;
        trace.statements.push({sql,key:typeof key==='string'?key:null});
      }
      let cursor: ReturnType<typeof storage.sql.exec>;
      try { cursor = target.exec(...args); } catch (error) { m.sqlFailures++; throw error; }
      return new Proxy(cursor, { get(c, property) {
        if (property === 'toArray') return () => {
          try { return c.toArray(); }
          finally { m.sqlReads += c.rowsRead; m.sqlWrites += c.rowsWritten; }
        };
        const value = Reflect.get(c, property, c);
        return typeof value === 'function' ? value.bind(c) : value;
      }});
    };
  }});
  return new Proxy(storage, { get(target, key) {
    if (key === 'sql') return sql;
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => {
      if (key === 'getAlarm') m.alarmGet++;
      if (key === 'setAlarm') m.alarmSet++;
      if (key === 'deleteAlarm') m.alarmDelete++;
      return value.apply(target, args);
    };
  }});
}
function wrappedState(state: DurableObjectState, m: Metrics): DurableObjectState {
  const storage = wrappedStorage(state.storage, m);
  return new Proxy(state, {get(target,key) {
    if (key === 'storage') return storage;
    if (key === 'acceptWebSocket') return (...args: Parameters<DurableObjectState['acceptWebSocket']>) => {
      const value = target.acceptWebSocket(...args); m.wsAccepted++; return value;
    };
    const value=Reflect.get(target,key,target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
}
const workerMetrics = metrics();
export class Registry extends BaseRegistry {
  private fixtureMetrics: Metrics;
  constructor(state: DurableObjectState, env: Env) {
    const m=metrics(); super(wrappedState(state,m),discoveryEnv(env)); this.fixtureMetrics=m;
  }
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/__fixture_metrics') return Response.json(this.fixtureMetrics);
    this.fixtureMetrics.requests++;
    const at=performance.now();
    try {
      if(new URL(request.url).pathname==='/internal/v2/discover'&&request.headers.get('X-Fixture-Discovery-Trace')==='1') {
        const trace:DiscoveryTrace={statements:[],workspaceLookups:0};
        const response=await discoveryTrace.run(trace,()=>super.fetch(request));
        const result=await response.json() as Record<string,unknown>;
        return Response.json({...result,fixtureTrace:trace},{status:response.status});
      }
      return await super.fetch(request);
    } finally {this.fixtureMetrics.wallMs+=performance.now()-at;}
  }
  async alarm(): Promise<void> {this.fixtureMetrics.alarmInvocations++; return super.alarm();}
}
export class Workspace extends BaseWorkspace {
  private fixtureMetrics: Metrics;
  private readonly rawState:DurableObjectState;
  constructor(state: DurableObjectState, env: Env) {
    const m=metrics(); super(wrappedState(state,m),env); this.fixtureMetrics=m;
    this.rawState=state;
  }
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/__fixture_metrics') return Response.json(this.fixtureMetrics);
    if (new URL(request.url).pathname === '/__fixture_expire_operation') {
      if(request.method!=='POST')return Response.json({code:'METHOD_NOT_ALLOWED'},{status:405});
      const body=await request.json() as {operationId?:unknown};
      if(typeof body.operationId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(body.operationId))
        return Response.json({code:'INVALID_INPUT'},{status:400});
      const old=Date.now()-1,key='operation/'+body.operationId;
      // Test-only fault injection. The deployed Worker cannot access this route.
      // Force exactly one native DISPATCHED operation past its own deadline;
      // production must refuse a late RUNNING ack and retain a truthful
      // UNKNOWN/noneffective receipt, not rely on a global cleanup scan.
      const changed=this.rawState.storage.sql.exec<{key:string}>(
        "UPDATE operation_native_v2 SET deadline=?,due=? WHERE key=? AND phase='DISPATCHED' AND terminal IS NULL RETURNING key",
        old,old,key).toArray();
      return Response.json({changed:changed.length});
    }
    this.fixtureMetrics.requests++;
    const at=performance.now();
    try {return await super.fetch(request);}
    finally {this.fixtureMetrics.wallMs+=performance.now()-at;}
  }
  async alarm(): Promise<void> {this.fixtureMetrics.alarmInvocations++; return super.alarm();}
  webSocketMessage(socket: DurableSocket, message: string | ArrayBuffer): void {
    this.fixtureMetrics.wsIncoming++;
    this.fixtureMetrics.wsIncomingBytes += typeof message === 'string' ? new TextEncoder().encode(message).byteLength : message.byteLength;
    super.webSocketMessage(socket, message);
  }
  webSocketClose(socket: DurableSocket, code: number, reason: string, clean: boolean): void {
    this.fixtureMetrics.wsCloseEvents++;
    super.webSocketClose(socket, code, reason, clean);
  }
  webSocketError(socket: DurableSocket, error: unknown): void {super.webSocketError(socket, error);}
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if(new URL(request.url).pathname==='/__fixture_metrics') return Response.json(workerMetrics);
    workerMetrics.requests++;
    const wrappedKV=new Proxy(env.OAUTH_KV,{get(target,key) {
      const value=Reflect.get(target,key,target);
      if(typeof value!=='function')return value;
      return (...args:unknown[])=>{
        if(key==='get'||key==='getWithMetadata')workerMetrics.kvGet++;
        if(key==='put')workerMetrics.kvPut++;
        if(key==='delete')workerMetrics.kvDelete++;
        if(key==='list')workerMetrics.kvList++;
        return value.apply(target,args);
      };
    }});
    const at=performance.now();
    try {
      const result=await worker.fetch(request,{...env,OAUTH_KV:wrappedKV},ctx);
      if(result.status!==101)workerMetrics.responseBytes+=(await result.clone().arrayBuffer()).byteLength;
      return result;
    } finally {workerMetrics.wallMs+=performance.now()-at;}
  },
};
