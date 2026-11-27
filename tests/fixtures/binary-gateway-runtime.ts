/** Test-only Worker: reconstruct one Workspace runtime around unchanged SQLite to model a compatible deployment. */
import worker, { Workspace as CandidateWorkspace } from '../../apps/gateway/src/index.js';
import type { Env } from '../../apps/gateway/src/common.js';
import type { DurableObjectState, WebSocket as DurableSocket } from '@cloudflare/workers-types';
export { Registry } from '../../apps/gateway/src/index.js';
export class Workspace {
  private candidate: CandidateWorkspace;
  constructor(private state: DurableObjectState, private env: Env) { this.candidate = new CandidateWorkspace(state,env); }
  private record(key:string):unknown {
    const rows = this.state.storage.sql.exec<{value:string}>('SELECT value FROM records WHERE key=? ORDER BY part',key).toArray();
    return rows.length ? JSON.parse(rows.map(row=>row.value).join('')) : undefined;
  }
  async fetch(request:Request):Promise<Response> {
    const path=new URL(request.url).pathname;
    if(path==='/__fixture_runtime') {
      const body=await request.json() as {mode?:string;binary?:boolean};
      if(body.mode!==undefined) {
        if(!['legacy','prepare','native'].includes(body.mode))throw new Error('Invalid fixture mode');
        this.env.CANONICAL_STORAGE_MODE=body.mode as 'legacy'|'prepare'|'native';
      }
      if(body.binary!==undefined)this.env.BINARY_PAYLOADS_ENABLED=body.binary?'true':'false';
      this.candidate=new CandidateWorkspace(this.state,this.env);
      return Response.json({ok:true});
    }
    if(path==='/__fixture_media') {
      const body=await request.json() as {operationId:string};
      const manifest=this.record('image/manifest/'+body.operationId+'/0') as {payloadFormat?:string}|undefined;
      const native=this.state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='media_payloads_v1'").toArray().length;
      return Response.json({schema:this.record('schema'),format:manifest?.payloadFormat??'LEGACY',binaryRows:native?this.state.storage.sql.exec<{count:number}>('SELECT count(*) count FROM media_payloads_v1').one().count:0});
    }
    return this.candidate.fetch(request);
  }
  alarm():Promise<void>{return this.candidate.alarm();}
  webSocketMessage(socket:DurableSocket,message:string|ArrayBuffer):void{this.candidate.webSocketMessage(socket,message);}
  webSocketClose(socket:DurableSocket,code:number,reason:string,clean:boolean):void{this.candidate.webSocketClose(socket,code,reason,clean);}
  webSocketError(socket:DurableSocket,error:unknown):void{this.candidate.webSocketError(socket,error);}
}
export default worker;
