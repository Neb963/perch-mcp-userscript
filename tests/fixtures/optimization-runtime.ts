// Test-only entrypoint. Never included in release or deployed Worker.
import worker, { Registry as BaseRegistry, Workspace as BaseWorkspace } from '../../apps/gateway/src/index.js';
import type { DurableObjectState, DurableObjectStorage, ExecutionContext } from '@cloudflare/workers-types';
import type { Env } from '../../apps/gateway/src/common.js';

function metrics() {
  return { requests: 0, kvGet: 0, kvPut: 0, kvDelete: 0, kvList: 0,
    alarmGet: 0, alarmSet: 0, alarmDelete: 0, alarmInvocations: 0,
    sqlReads: 0, sqlWrites: 0, sqlStatements: 0, sqlFailures: 0, responseBytes: 0,
    wallMs: 0, coldStarts: 1 };
}
type Metrics = ReturnType<typeof metrics>;
function wrappedStorage(storage: DurableObjectStorage, m: Metrics): DurableObjectStorage {
  const sql = new Proxy(storage.sql, { get(target, key) {
    if (key !== 'exec') return Reflect.get(target, key, target);
    return (...args: Parameters<typeof storage.sql.exec>) => {
      m.sqlStatements++;
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
    const value=Reflect.get(target,key,target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
}
const workerMetrics = metrics();
export class Registry extends BaseRegistry {
  private fixtureMetrics: Metrics;
  constructor(state: DurableObjectState, env: Env) {
    const m=metrics(); super(wrappedState(state,m),env); this.fixtureMetrics=m;
  }
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/__fixture_metrics') return Response.json(this.fixtureMetrics);
    this.fixtureMetrics.requests++;
    const at=performance.now();
    try { return await super.fetch(request); }
    finally {this.fixtureMetrics.wallMs+=performance.now()-at;}
  }
  async alarm(): Promise<void> {this.fixtureMetrics.alarmInvocations++; return super.alarm();}
}
export class Workspace extends BaseWorkspace {
  private fixtureMetrics: Metrics;
  constructor(state: DurableObjectState, env: Env) {
    const m=metrics(); super(wrappedState(state,m),env); this.fixtureMetrics=m;
  }
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/__fixture_metrics') return Response.json(this.fixtureMetrics);
    this.fixtureMetrics.requests++;
    const at=performance.now();
    try {return await super.fetch(request);}
    finally {this.fixtureMetrics.wallMs+=performance.now()-at;}
  }
  async alarm(): Promise<void> {this.fixtureMetrics.alarmInvocations++; return super.alarm();}
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
