import {ApiError,bearer,MAX_BODY,type Env} from './common.js';
const TAB=new Set(['claim','rebind-proof','poll','heartbeat','reply','release','permit','segment','operator-restore','image','music','music-result','ticket','socket']);
const OAUTH=new Set(['/authorize','/authorize/complete','/token','/register','/revoke']);
/** Shape checks only. Authoritative credentials, grants and leases stay in their existing boundaries. */
export function validateIngress(request:Request,env:Pick<Env,'PUSH_NOTIFICATIONS_ENABLED'>):void {
  const path=new URL(request.url).pathname, method=request.method;
  const tab=path.startsWith('/api/v1/tab/'), admin=path.startsWith('/api/v1/admin/');
  const mcp=/^\/mcp\/[A-Za-z0-9_-]{1,128}$/.test(path);
  const metadata=path==='/.well-known/oauth-authorization-server'||path==='/.well-known/openid-configuration'||
    path==='/.well-known/oauth-protected-resource'||/^\/\.well-known\/oauth-protected-resource\/mcp\/[A-Za-z0-9_-]{1,128}$/.test(path);
  let methods:string[];
  if(['/live','/health','/setup'].includes(path)||metadata)methods=['GET','HEAD'];
  else if(tab) {
    const action=path.slice('/api/v1/tab/'.length);
    if(!TAB.has(action)||(action==='socket'&&env.PUSH_NOTIFICATIONS_ENABLED!=='true'))
      throw new ApiError('NOT_FOUND','Route not found.',404);
    methods=action==='socket'?['GET']:['POST'];
  } else if(admin)methods=['GET','POST','PATCH','PUT'];
  else if(mcp)methods=['GET','POST','DELETE'];
  else if(OAUTH.has(path))methods=path==='/authorize'?['GET','POST']:['POST'];
  else throw new ApiError('NOT_FOUND','Route not found.',404);
  if(!methods.includes(method))throw new ApiError('INVALID_INPUT','Method is not supported for this route.',405);
  if((tab&&path!=='/api/v1/tab/socket')||
      (admin&&!['/api/v1/admin/pair','/api/v1/admin/recover'].includes(path)))bearer(request);
  if(tab&&path!=='/api/v1/tab/socket'||admin&&['POST','PATCH','PUT'].includes(method)) {
    if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))
      throw new ApiError('INVALID_INPUT','JSON Content-Type required.',415);
    const size=request.headers.get('Content-Length');
    const max=path.startsWith('/api/v1/admin/resources')?12*1024*1024:MAX_BODY;
    if(size!==null&&(!/^\d+$/.test(size)||!Number.isSafeInteger(Number(size))||Number(size)>max))
      throw new ApiError('LIMIT_EXCEEDED','Request body exceeds transport limit.',413);
  }
}
/** Bounded per-isolate protection for allocations before credentials can be verified.
 * No account-wide rate guarantee; terminal/reporting/recovery routes are exempt. */
export class IngressAdmission {
  private minute=-1;
  private lastNow=0;
  private counts={socket:0,registration:0,bootstrap:0};
  check(request:Request,now=Date.now()):void {
    const path=new URL(request.url).pathname;
    const category=path==='/api/v1/tab/socket'?'socket':
      path==='/register'&&request.method==='POST'?'registration':
      ['/api/v1/tab/claim','/api/v1/tab/rebind-proof','/api/v1/admin/pair'].includes(path)&&request.method==='POST'?'bootstrap':undefined;
    if(!category)return;
    this.lastNow=Math.max(this.lastNow,now);
    const minute=Math.floor(this.lastNow/60000);
    if(minute!==this.minute){this.minute=minute;this.counts={socket:0,registration:0,bootstrap:0};}
    const cap=category==='registration'?30:120;
    if(this.counts[category]>=cap)
      throw new ApiError('QUOTA_EXCEEDED','Local ingress admission limit reached; retry after this minute.',429);
    this.counts[category]++;
  }
}
/** Fixed category sampling before an auxiliary Registry RPC, never an OAuth permission gate. */
export class OAuthAuditAdmission {
  private minute=-1; private lastNow=0; private seen=new Set<string>();
  allow(route:string,method:string,originClass:string,status:number,code:string,now=Date.now()):boolean {
    if(!['authorize','authorize_complete','token','register'].includes(route)||
        !['GET','POST'].includes(method)||
        !['missing','null','same','perchance','chatgpt','other'].includes(originClass)||
        (method==='GET'&&code==='PENDING_OR_INFO'))return false;
    this.lastNow=Math.max(this.lastNow,now);
    const minute=Math.floor(this.lastNow/60000);
    if(minute!==this.minute){this.minute=minute;this.seen.clear();}
    const kind=['CALLBACK_REDIRECT_ISSUED','CALLBACK_RECOVERY_AVAILABLE','TOKEN_EXCHANGE_SUCCEEDED',
      'REDIRECT_ISSUED','PENDING_OR_INFO'].includes(code)?code:'ERROR';
    const key=[route,method,originClass,Math.floor(status/100),kind].join('/');
    if(this.seen.size>=12||this.seen.has(key))return false;
    this.seen.add(key);return true;
  }
}
