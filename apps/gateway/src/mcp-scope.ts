import {parseDevelopmentCall} from '../../../packages/contracts/src/development-v2.js';
import {MAX_BODY,parseBody} from './common.js';

/** A validated v2 tools/call performs fresh Registry authorization inside
 * mcpDevelopment. Every other message retains the outer generic Grant check.
 * This is only request classification; never a cached or delegated authority. */
export async function isScopedDevelopmentCall(request:Request):Promise<boolean> {
  if(request.method!=='POST') return false;
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return false;
  try {
    const body=await parseBody(request.clone(),MAX_BODY);
    if(body.jsonrpc!=='2.0'||body.method!=='tools/call')return false;
    const params=body.params;
    if(!params||typeof params!=='object'||Array.isArray(params))return false;
    const values=params as Record<string,unknown>;
    if(typeof values.name!=='string')return false;
    parseDevelopmentCall(values.name,values.arguments??{});
    return true;
  }catch{return false;}
}
