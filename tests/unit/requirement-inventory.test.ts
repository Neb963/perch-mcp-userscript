import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('R05 requirement ledger accounts for every atomic clause without inventing PASS',()=>{
  const output=mkdtempSync(join(tmpdir(),'perch-requirements-'));
  try {
    const file=join(output,'report.json');
    execFileSync(process.execPath,['scripts/audit-requirements.mjs','--out',file]);
    const report=JSON.parse(readFileSync(file,'utf8')) as {
      checkedAtCommit:string;checkedAtTree:string;
      total:number;counts:Record<string,number>;badRows:unknown[];badEvidence:unknown[];
      unresolved:{id:string;status:string}[];releaseEligible:boolean;
    };
    const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
    const tree=execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
    assert.equal(report.checkedAtCommit,head,'Inventory must report the actual checked out source');
    assert.equal(report.checkedAtTree,tree,'Inventory must report the exact source tree');
    assert.ok(report.total>=1300,'Never silently discard atomic requirements');
    assert.deepEqual(report.badRows,[],'No duplicate IDs or malformed matrix rows');
    assert.deepEqual(report.badEvidence,[],'No PASS without exact evidence and commit');
    assert.equal(Object.values(report.counts).reduce((a,b)=>a+b,0),report.total);
    assert.equal(report.unresolved.length,report.total-(report.counts.PASS??0)-
      (report.counts.DEFERRED_OWNER??0)-(report.counts.SUPERSEDED_BY_OWNER_AMENDMENT??0));
    const mismatched=spawnSync(process.execPath,['scripts/audit-requirements.mjs'],{
      encoding:'utf8',env:{...process.env,PERCH_EXPECTED_COMMIT:'0'.repeat(40)}});
    assert.notEqual(mismatched.status,0,'Wrong PR checkout must fail closed');
    const strict=spawnSync(process.execPath,['scripts/audit-requirements.mjs','--strict'],{encoding:'utf8'});
    assert.equal(strict.status,report.releaseEligible?0:1);
  } finally {rmSync(output,{recursive:true,force:true});}
});
