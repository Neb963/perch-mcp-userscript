// Test-only outer waitUntil barrier; never bundled into the release entrypoint.
import measuredWorker from './optimization-runtime.js';
import type {ExecutionContext} from '@cloudflare/workers-types';
import type {Env} from '../../apps/gateway/src/common.js';
export {Registry,Workspace} from './optimization-runtime.js';
const pending=new Set<Promise<unknown>>();
export default {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response> {
    if(new URL(request.url).pathname==='/__fixture_flush') {
      let waves=0;
      while(pending.size) {
        if(++waves>8)throw new Error('Synthetic waitUntil tasks did not settle.');
        await Promise.allSettled([...pending]);
      }
      return Response.json({settled:true});
    }
    const context=new Proxy(ctx,{get(target,key) {
      if(key==='waitUntil')return (value:Promise<unknown>)=>{
        const task=Promise.resolve(value);pending.add(task);
        void task.finally(()=>pending.delete(task)).catch(()=>{});
        return target.waitUntil(task);
      };
      const value=Reflect.get(target,key,target);
      return typeof value==='function'?value.bind(target):value;
    }});
    return measuredWorker.fetch(request,env,context);
  },
};
