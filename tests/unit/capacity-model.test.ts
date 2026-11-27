import {test} from 'node:test';
import assert from 'node:assert/strict';
import {capacityModel} from '../../scripts/capacity-model.js';
function fixture(): Parameters<typeof capacityModel>[0] {
  const area=()=>({requests:0,sqlReads:0,sqlWrites:0,kvGet:0,kvPut:0,kvDelete:0,kvList:0,
    alarmGet:0,alarmSet:0,alarmDelete:0,alarmInvocations:0,sqlFailures:0,wallMs:0,responseBytes:0});
  const usage=()=>({worker:area(),registry:area(),workspace:area()});
  return {source:'synthetic-sha',runtime:'fixture-runtime',fixture:'deterministic-accounting-only',
    startup:usage(),oauth:usage(),rows:[
      {path:'http-idle',history:0,wallMs:1,usage:{...usage(),workspace:{...area(),sqlReads:10,requests:1}}},
      {path:'full-mcp-lifecycle',history:0,wallMs:1,usage:{...usage(),workspace:{...area(),sqlReads:80,sqlWrites:20,requests:4}}},
      {path:'full-mcp-lifecycle',history:1000,wallMs:1,usage:{...usage(),workspace:{...area(),sqlReads:90,sqlWrites:30,requests:4}}},
    ]};
}
test('capacity projection uses worst measured coefficient and reports assumptions separately',()=>{
  const result=capacityModel(fixture());
  assert.equal(result.measuredCoefficients.lifecycle.distribution.sqlWrites?.max,30);
  const normal=result.projections.find(row=>row.workload.name==='one-editor-8h-200')!;
  assert.equal(normal.measuredCoefficientPortion.sqlWrites,6000);
  assert.ok(normal.modeledSubtotal.sqlWrites!>6000,'cleanup/background/retry are not hidden');
  assert.equal(normal.migrationIncluded,false);
  assert.ok(result.missingEvidence.some(row=>row.includes('omits migration')));
  assert.equal(result.measuredCoefficients.lifecycle.distribution.logs,undefined,'unmetered logs cannot be measured zero');
  assert.equal(normal.capacityClaim,'ESTIMATE_ONLY_NOT_ACCOUNT_HEADROOM');
});
test('push projection removes ordinary idle polls and separates raw WS and billable-equivalent messages',()=>{
  const result=capacityModel(fixture(),{transport:'push'});
  const idle=result.projections[0]!;
  assert.equal(idle.counts.polls,0);
  assert.ok(idle.modeledSubtotal.wsIncomingRaw!>0);
  assert.equal(idle.modeledSubtotal.wsBillableMessageEquivalent,idle.modeledSubtotal.wsIncomingRaw!/20);
  assert.equal(result.projections.find(row=>row.workload.editors===50)?.stressOnly,true);
});
test('capacity projection rejects missing counters, SQL failures and invalid assumptions',()=>{
  const missing=fixture();delete missing.rows[0]!.usage.workspace!.sqlWrites;
  assert.throws(()=>capacityModel(missing),/dimension is absent/);
  const failed=fixture();failed.rows[0]!.usage.workspace!.sqlFailures=1;
  assert.throws(()=>capacityModel(failed),/failed SQL sample/);
  assert.throws(()=>capacityModel(fixture(),{pollSeconds:0}),/Invalid capacity/);
});
test('explicit migration costs enter subtotal and reserve is not labeled measured consumption',()=>{
  const result=capacityModel(fixture(),{migration:{sqlReads:1234,sqlWrites:456}});
  const idle=result.projections[0]!;
  assert.equal(idle.migrationIncluded,true);
  assert.ok(idle.modeledSubtotal.sqlReads!>=1234);
  assert.equal(idle.utilization.sqlWrites?.unrelatedReserveFraction,0.2);
  assert.ok(idle.utilization.sqlWrites!.fractionIncludingReserve>idle.utilization.sqlWrites!.modeledFraction);
});

test('supplied SDK refresh measurements replace assumed refresh coefficients and retain provenance',()=>{
  const input=fixture(),usage=structuredClone(input.rows[0]!.usage);
  for(const area of Object.values(usage))for(const key of Object.keys(area))area[key]=0;
  Object.assign(usage.worker!,{requests:1,kvGet:2,kvPut:2});
  Object.assign(usage.registry!,{requests:3,sqlReads:23,sqlWrites:2});
  const audit=structuredClone(usage);for(const area of Object.values(audit))for(const key of Object.keys(area))area[key]=0;
  Object.assign(audit.registry!,{requests:1,sqlReads:5,sqlWrites:5});
  const result=capacityModel(input,{}, {source:'measured-refresh-sha',sourceDirty:false,samples:[{wallMs:1,usage}],auditCoefficient:{accepted:true,usage:audit}});
  assert.equal(result.assumptions.oauthRefresh.kvWrites,2);
  assert.equal(result.assumptions.oauthRefresh.sqlReads,28);
  assert.equal(result.assumptions.oauthRefresh.sqlWrites,7);
  assert.equal(result.assumptions.oauthRefresh.doRequests,4);
  assert.equal(result.measuredCoefficients.oauthRefresh?.source,'measured-refresh-sha');
  const normal=result.projections.find(row=>row.workload.name==='one-editor-8h-200')!;
  assert.equal(normal.counts.refreshes,32);
  assert.equal(normal.modeledComponents.background.kvWrites,64);
});
