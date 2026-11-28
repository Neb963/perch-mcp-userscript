import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
function includes(file: string, clauses: readonly string[]): void {
  const text=read(file);
  for (const phrase of clauses) assert.ok(text.includes(phrase), file + ': missing '+JSON.stringify(phrase));
}

test('S00-003 architecture authority and boundaries',()=>{
  includes('docs/DESIGN.md',[
    'v0.3 implementation specification','| Worker ingress |','| Registry |',
    '| Workspace Durable Object |','| Trusted userscript controller |',
    '| Native editor / saved source |','| Operator manager |','| Client |',
    'Only the Registry can grant authority.',
    'SourceRevision, LocalRevision, PreviewRevision and SavedRevision',
    '## Historical v0.1 architecture and v0.2.0 design amendments',
  ]);
});

test('S00-010 historical authority remains labeled and readable',()=>{
  for(const [file,heading] of [
    ['docs/DESIGN.md','## Historical v0.1 architecture and v0.2.0 design amendments'],
    ['docs/PROTOCOL.md','## Historical v1 protocol and v0.2.0 compatibility details'],
    ['docs/TOOLS.md','## Historical v1 tool catalog'],
    ['docs/SETUP.md','## Historical installation and operator setup for v0.1–v0.2.0'],
    ['docs/HANDOFF.md','## Historical v0.1 handoff'],
  ] as const) includes(file,[heading]);
  includes('docs/v0.3/REMEDIATION-AUTHORITY.md',['Preserve unaffected requirements.','The original specification remains available with its original hash.']);
});

test('S00-011 canonical legacy disposition covers 52 unique names and permissions',()=>{
  const body=read('docs/v0.3/TOOL-DISPOSITION.md');
  const rows=body.split('## Permission disposition')[0]!.split('\n')
    .filter(line=>line.startsWith('| `'))
    .map(line=>line.split('|').slice(1,4).map(s=>s.trim()));
  assert.equal(rows.length,52);
  assert.equal(new Set(rows.map(r=>r[0])).size,52);
  assert.ok(rows.every(r=>/^Retain\.|^Retire\./.test(r[2]!)));
  for(const needle of [
    'v2 keeps or redefines 16, retires 36, and adds `rename`, `delete`, and `batch`.',
    'The baseline schema marks music as a browser tool',
    'v1 compatibility only under the original pinned scope',
    'READ_RESOURCES | Retire from active v2 policy',
    'New CAPTURE_PREVIEW',
  ])assert.ok(body.includes(needle));
});

test('S00-012 explicitly preserves original non-superseded authority',()=>{
  includes('docs/v0.3/REMEDIATION-AUTHORITY.md',[
    'Apply its explicit owner amendments first','Preserve unaffected requirements.',
    'Audit findings F01–F27 and original acceptance A01–A34 remain in scope.',
  ]);
  includes('docs/verification/v0.3-remediation/REQUIREMENT-TRACEABILITY.md',[
    '[Specification §§0–5](SPEC-00-05.md)','[Specification §§6–11, 13](SPEC-06-13.md)',
    '[Acceptance A01–A34](ACCEPTANCE-TRACEABILITY.md)','[Findings and amendments](AUDIT-TRACEABILITY.md)',
  ]);
});

test('S00-013 exact R00 baseline provenance and divergences',()=>{
  includes('docs/verification/v0.3-remediation/BASELINE.md',[
    '298f3b9619335364c668a69b6f04570ae530fcab',
    'c07b3e7e25ea0e4d063ee11435cc58e3d524059b',
    '57f26a63c26bd59e01cfa1e3460c3a703d1a0104',
    '46048905489','574 tests with zero failures',
    '| F01 |','| F02 |','| F03 |','| F04 |','| F05 |',
    '| F16 |','| F17 |','| F21 |','| F25–F27 |',
  ]);
});

test('S00-015 tracked phases, commits, verification and blockers',()=>{
  includes('todo.md',[
    '## R00–R05 v0.3 conformance remediation',
    '### R03','### R04','### R05',
    '0c4a44e9c1006f329f2efe3cf9813a712c1c4425',
    '187','44','S07-023','BLOCKED','No live',
  ]);
});

test('S00-016 A01–A34 have exact §12 authority and atomic trace headings',()=>{
  const spec=read('docs/v0.3/PERCH-MCP-V0.3-IMPLEMENTATION-SPEC.md');
  const matrix=read('docs/verification/v0.3-remediation/ACCEPTANCE-TRACEABILITY.md');
  const prefix=matrix.split('## Atomic cases')[0]!;
  for(const t of ['unified specification §12','audit revision 3','T01','T13'])assert.ok(prefix.includes(t));
  const specLines=spec.split('\n'),matrixLines=matrix.split('\n');
  for(let n=1;n<=34;n++){
    const id='A'+String(n).padStart(2,'0');
    assert.equal(specLines.filter(l=>l.startsWith('| '+id+' |')).length,1,id+' specification row');
    assert.equal(matrixLines.filter(l=>l==='### '+id).length,1,id+' trace section');
    const section=matrix.split('### '+id+'\n')[1]!.split(/\n### A\d\d/)[0]!;
    assert.ok(section.includes('| '+id+'-'),id+' atomic case');
  }
});

test('S02-049 agent never silently chooses stale or first Target',()=>{
  includes('docs/v0.3/agent-knowledge/AGENT-INSTRUCTIONS.md',[
    'Keep the user-selected Target for every operation.',
    'Do not follow stale Targets or silently choose the first Workspace.',
    'A new generation means a different assignment or Binding.',
  ]);
  includes('docs/v0.3/agent-knowledge/START-HERE.md',[
    'Ask the operator which Target to use.','If it is ambiguous, clarify before execution.',
  ]);
});

test('S02-101 stale catalog recovery documents exact bounded client procedure',()=>{
  includes('docs/CONNECTORS.md',[
    '### Stale MCP tool catalog after v2 activation (Operator/client procedure)',
    'Stop all new tool effects.','reconcile existing operations with their original Operation ID and operationKey',
    'disconnect the existing Connector session and reconnect the **same resource URL**',
    'explicitly approve the **v2 Connector OAuth consent**',
    'Compare the refreshed tool catalog against the 19 names in `docs/TOOLS.md`',
    'use its **current explicit Target**',
    'disconnect and remove/re-add that Connector in the client',
    'do not silently downgrade or switch endpoints.',
  ]);
});

test('S04-016 a new operationKey means new intent; uncertain effects never replay',()=>{
  includes('docs/v0.3/agent-knowledge/AGENT-INSTRUCTIONS.md',[
    'Generate a fresh operationKey for one explicit effectful intent.',
    'Preserve it across transport retries and reconcile a lost result with operation_status by key.',
    'A new key is a new operation.','Do not repeat uncertain effects.',
  ]);
});

test('S04-080 batch publication segments and separate final Save are explicit',()=>{
  includes('docs/v0.3/agent-knowledge/AGENT-INSTRUCTIONS.md',[
    'Across native publication, preview, and network segments',
    'a later failure does not roll back earlier completed segments.',
    'completed, failed, skipped and uncertain actions',
    'do not claim cross-segment atomicity.',
    '`save_generator` is excluded from `batch` and is a separate explicit final Save',
  ]);
  includes('docs/v0.3/agent-knowledge/GENERATOR-DEVELOPMENT.md',[
    'use a separate Operation.','Report exact published effects and unresolved outcomes.',
  ]);
});
