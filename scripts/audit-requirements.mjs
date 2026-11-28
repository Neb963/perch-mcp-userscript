#!/usr/bin/env node
// R05 release gate. Parsing never upgrades a requirement status: only direct
// evidence in the authority matrix can do that. A passing code suite is not a
// substitute for an individually verified specification requirement.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
const base='docs/verification/v0.3-remediation/';
const matrices=['SPEC-00-05.md','SPEC-06-13.md','ACCEPTANCE-TRACEABILITY.md','AUDIT-TRACEABILITY.md'];
const allowed=new Set(['NOT_STARTED','IMPLEMENTED_UNVERIFIED','PASS','FAIL','DEFERRED_OWNER','BLOCKED_FEASIBILITY','SUPERSEDED_BY_OWNER_AMENDMENT']);
function cells(line){
  const out=[];let buf='',slashes=0;
  for (let i=0;i<line.length;i++){
    const c=line[i];
    if(c==='|'&&slashes%2===0){out.push(buf.trim());buf='';slashes=0;continue;}
    buf+=c;slashes=c==='\\'?slashes+1:0;
  }
  out.push(buf.trim());
  if(out[0]==='')out.shift();
  if(out.at(-1)==='')out.pop();
  if(out.length>12){
    const n=out.length;
    return [...out.slice(0,6),out.slice(6,n-5).join('|'),...out.slice(-5)];
  }
  return out;
}
const rows=[],badRows=[],badEvidence=[],seen=new Set();
for(const matrix of matrices){
 const body=readFileSync(resolve(base+matrix),'utf8');
 for(const [i,line] of body.split(/\r?\n/).entries()){
  if(!line.startsWith('| ')||!line.endsWith(' |'))continue;
  const c=cells(line);
  if(c.length!==12){
    if(c.length>2&&c[0]!=='Requirement ID'&&!/^[-: ]+$/.test(c[0]))
      badRows.push({matrix,line:i+1,columns:c.length});
    continue;
  }
  const [id,authority,requirement,finding,phase,implementation,verification,expected,actual,evidence,status,commit]=c;
  if(id==='Requirement ID'||id==='---')continue;
  if(!/^[A-Z][A-Za-z0-9_.-]{2,128}$/.test(id)){badRows.push({matrix,line:i+1,id});continue;}
  if(seen.has(id))badRows.push({matrix,line:i+1,id,reason:'DUPLICATE_ID'});
  seen.add(id);
  if(!allowed.has(status))badRows.push({matrix,line:i+1,id,status,reason:'UNKNOWN_STATUS'});
  if(status==='PASS'&&(commit==='Pending'||!commit||/\bpending\b|not verified|unverified/i.test(actual)||/\bpending\b/i.test(evidence)))
    badEvidence.push({matrix,line:i+1,id,reason:'PASS_LACKS_CONCRETE_EVIDENCE'});
  rows.push({id,matrix,phase,finding,status,actual,evidence,commit});
 }
}
const counts=Object.fromEntries([...allowed].map(s=>[s,rows.filter(x=>x.status===s).length]));
const unresolved=rows.filter(x=>!['PASS','DEFERRED_OWNER','SUPERSEDED_BY_OWNER_AMENDMENT'].includes(x.status));
const byPhase=Object.fromEntries([...new Set(rows.map(r=>r.phase))].sort().map(p=>[p,
  {total:rows.filter(x=>x.phase===p).length,unresolved:unresolved.filter(x=>x.phase===p).length}]));
const report={schemaVersion:1,authority:matrices,checkedAtCommit:process.env.GITHUB_SHA??null,
  total:rows.length,counts,byPhase,
  releaseEligible:!badRows.length&&!badEvidence.length&&!unresolved.length,
  unresolved:unresolved.map(({id,matrix,phase,status})=>({id,matrix,phase,status})),
  badRows,badEvidence};
const outAt=process.argv.indexOf('--out');
if(outAt!==-1){
 const path=process.argv[outAt+1];
 if(!path)throw Error('--out requires path');
 mkdirSync(dirname(resolve(path)),{recursive:true});
 writeFileSync(resolve(path),JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify({total:report.total,counts:report.counts,byPhase:report.byPhase,
 releaseEligible:report.releaseEligible,badRows:badRows.length,badEvidence:badEvidence.length}));
if(!rows.length||badRows.length||badEvidence.length)process.exitCode=1;
if(process.argv.includes('--strict')&&!report.releaseEligible)process.exitCode=1;
