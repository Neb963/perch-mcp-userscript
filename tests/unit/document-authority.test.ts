import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** T0 document-only proofs. These do not qualify runtime or provider behavior. */
const cases: readonly [string, string, readonly string[]][] = [
  ['S00-001','CLIENT_SPEC.md', ['accepted [v0.3 implementation specification](docs/v0.3/PERCH-MCP-V0.3-IMPLEMENTATION-SPEC.md)', 'public v2 contract contains 19 tools', 'Operator activates it']],
  ['S00-002','AGENTS.md',['revision 3 authority','repair/v0.3-conformance','leave the repair PR unmerged','Production and preview endpoint calls, live browser/provider testing']],
  ['S00-004','docs/PROTOCOL.md',['Implementation specification §§2–4','Target resolution','Browser version skew','Legacy Grant readers remain fixed','Historical v1 protocol and v0.2.0 compatibility']],
  ['S00-006','docs/CONNECTORS.md',['A Connector is the OAuth principal at the exact resource URL','v2 Grant authorizes only Workspaces assigned to that Connector','Explicitly assign each intended Workspace','Multiple conversations using one Connector share its authority']],
  ['S00-007','docs/SETUP.md',['This describes the v0.3 operator rollout contract','Only the Operator can deploy','Reauthorize one Connector with the new consent screen','Keep the existing bindings, names, pairing and OAuth KV']],
  ['S00-008','docs/EVIDENCE.md',['v0.3 authority and baseline','offline qualification','at that exact head','Each phase records tests and limitations','source-equivalent v0.2.0 run supplies a baseline']],
  ['S00-009','docs/TEST_PLAN.md',['| T0 |','| T1 |','| T2 |','| T5 |','| OWNER-01–04 |','Record `DEFERRED_OWNER` during this task','Treat the standard image content and verified stored-source readback as separate acceptance checks']],
];
for (const [id, path, assertions] of cases) {
  test(id+' documented authority',()=>{
    const body=readFileSync(resolve(process.cwd(),path),'utf8');
    for (const needle of assertions) assert.ok(body.includes(needle),id+' missing '+JSON.stringify(needle));
  });
}
test('S00-005 tools authority lists exactly 19 canonical v2 tools before historical v1 catalog',()=>{
  const body=readFileSync(resolve(process.cwd(),'docs/TOOLS.md'),'utf8');
  const section=body.split('## Historical v1 tool catalog')[0]!;
  assert.ok(section.includes('The table describes the v2 contract during development'));
  assert.ok(body.includes('## Historical v1 tool catalog'));
  assert.deepEqual(section.split('\n').filter(line=>line.startsWith('| `')).map(line=>line.split('`')[1]),[
    'read','write','delete','rename','list_files','page_eval','page_refresh',
    'preview_diagnostics','set_viewport_size','capture_page_image','execute_js',
    'fetch_url','fetch_generator','workspace_status','generator_info',
    'save_generator','operation_status','cancel_operation','batch',
  ]);
});
