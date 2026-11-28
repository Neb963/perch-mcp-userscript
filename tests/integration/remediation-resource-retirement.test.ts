import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCapacityHarness} from './gateway-capacity-harness.js';

const admin='/api/v1/admin';

test('UI-LIB-01 v2 fresh installation refuses legacy Resource authoring without lazy initialization', async()=>{
  const h=await createCapacityHarness(0,{DEVELOPMENT_CONTRACT_V2_ENABLED:'true'});
  try {
    const state=await h.get(admin+'/state');
    await h.request(admin+'/connectors',{expectedRevision:state.revision,label:'Clean v2 Connector'});
    const pairing=h.syntheticPairing();
    const denied=async(path:string, expectedCode:string, expectedStatus:number)=>{
      const response=await h.mf.dispatchFetch('https://capacity.test'+path,{
        headers:{Authorization:'Bearer '+pairing.adminCredential},
      });
      assert.equal(response.status,expectedStatus);
      const body=await response.json() as {code?:string};
      assert.equal(body.code,expectedCode);
    };
    await denied(admin+'/resources','UPGRADE_REQUIRED',410);
    await denied(admin+'/resources/export','NOT_FOUND',404);
    await assert.rejects(h.request(admin+'/resources/import',{expectedRevision:1,items:[]}),/UPGRADE_REQUIRED/);
    await denied(admin+'/resources/export','NOT_FOUND',404);
  } finally {await h.close();}
});

test('UI-LIB-01 historical Resource bytes remain exportable but no longer mutable after v2 adoption',async()=>{
  const h=await createCapacityHarness(0,{DEVELOPMENT_CONTRACT_V2_ENABLED:'true'});
  try {
    const legacy=await h.get(admin+'/resources');
    assert.ok((legacy.items as unknown[]).length>0);
    const state=await h.get(admin+'/state');
    await h.request(admin+'/connectors',{expectedRevision:state.revision,label:'v2'});
    const pairing=h.syntheticPairing();
    const response=await h.mf.dispatchFetch('https://capacity.test'+admin+'/resources/export',{
      headers:{Authorization:'Bearer '+pairing.adminCredential},
    });
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),'application/zip');
    const bytes=new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length>80);
    assert.equal(bytes[0],80);
    assert.equal(bytes[1],75);
    const denial=await h.mf.dispatchFetch('https://capacity.test'+admin+'/resources',{
      headers:{Authorization:'Bearer '+pairing.adminCredential},
    });
    assert.equal(denial.status,410);
    assert.equal((await denial.json() as {code?:string}).code,'UPGRADE_REQUIRED');
    await assert.rejects(h.request(admin+'/resources/import',{expectedRevision:1,items:[]}),/UPGRADE_REQUIRED/);
  } finally {await h.close();}
});
