import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// The tests exercise actual SQLite/workerd handlers and deny every outbound request.
// Retain their failure exit status; never manufacture results from theoretical chunk counts.
const stdout = execFileSync(process.execPath, ['--import','tsx','--test','--test-reporter=spec','tests/integration/binary-media.test.ts'], {
  encoding:'utf8', timeout:60000, maxBuffer:4*1024*1024, env:{...process.env,NO_COLOR:'1'},
});
const measurements = stdout.split(/\r?\n/).filter(line=>line.startsWith('{"kind":"o06-')).map(line=>JSON.parse(line) as Record<string,unknown>);
for (const kind of ['o06-payload-rows','o06-music-point-read','o06-maintenance-backfill'])
  assert.equal(measurements.filter(row=>row.kind===kind).length,1,'Missing or duplicate real-runtime media measurement: '+kind);
const report = {
  source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  sourceDirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0,
  runtime:'Miniflare4.20260730.0/workerd1.20260730.1',
  fixture:'Pinned local SQLite, synthetic clocks, deterministic PNG-signature bytes/fake audio; all outbound denied.',
  scope:'Physical payload rows exclude metadata/index maintenance. Point reads exclude MCP/OAuth ingress. Maintenance includes bounded discovery and dirty reconciliation, with canonical legacy records retained.',
  unavailable:'Production billing, physical hibernation, real Firefox and provider media: DEFERRED_LIVE',
  measurements,
};
const output=process.argv[2]??'/tmp/perch-media-benchmark.json';
await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,measurements}));
