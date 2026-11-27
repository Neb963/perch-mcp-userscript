import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { zipSync } from 'fflate';
import { developmentToolDefinitions } from '../packages/contracts/src/development-v2.js';

const exampleTarget = 'w2.exampleWorkspace.12.8';
const examples = {
  discover: {tool:'workspace_status',arguments:{}},
  select: {tool:'read',arguments:{target:exampleTarget,files:[{path:'main.pjs'},{path:'src/asset.png',encoding:'base64'}]}},
  inspect: {tool:'operation_status',arguments:{target:exampleTarget,operationKey:'k2.1795790000000.550e8400-e29b-41d4-a716-446655440000'}},
  batch: {tool:'batch',arguments:{target:exampleTarget,actions:[{tool:'list_files',args:{directories:['src']}},
    {tool:'read',args:{files:[{path:'main.pjs'}]}}]}},
};

export async function buildAgentKnowledge(output: string, version: string, tree: string) {
  const outputDir = output + '/perch-agent-knowledge';
  const files: Record<string, Uint8Array> = {};
  const add = async (path: string, contents: Uint8Array) => {
    await mkdir(dirname(outputDir + '/' + path),{recursive:true});
    await writeFile(outputDir + '/' + path,contents);
    files[path] = contents;
  };
  const encode = (value: string) => new TextEncoder().encode(value);
  for (const path of ['START-HERE.md','AGENT-INSTRUCTIONS.md'])
    await add(path,await readFile('docs/v0.3/agent-knowledge/'+path));
  const skills = (await readdir('packages/resources/skills')).sort();
  if (skills.length!==11) throw new Error('Expected the eleven repository-authored Perchance skills.');
  for (const name of skills) {
    const path = 'skills/' + name + '/SKILL.md';
    const skill = await readFile('packages/resources/'+path,'utf8');
    await add(path,encode(skill.replace('Use list_skills/skill to discover plugin-specific constraints.',
      'Read the relevant plugin-specific Markdown skill from this package.')));
  }
  await add('references/public-source-review.md',await readFile('packages/resources/documentation/public-source-review.md'));
  await add('references/engineering.md',await readFile('packages/resources/instructions/engineering.md'));
  await add('workflows/generator-development.md',await readFile('docs/v0.3/agent-knowledge/GENERATOR-DEVELOPMENT.md'));
  const docs = ['# Perch MCP contract v2', '',
    'Use the canonical Target returned by discovery. Replace example keys with current issuedAt milliseconds and a new UUIDv4 for each effectful intent.',
    'If a result is uncertain, retrieve the original Operation and inspect exact current state before proposing a new one.',
    '', '## Examples', '', '```json', JSON.stringify(examples,null,2), '```', '',
  ];
  for (const definition of developmentToolDefinitions)
    docs.push('## ' + definition.name,'',definition.description,'','```json',JSON.stringify(definition.inputSchema,null,2),'```','');
  await add('TOOL-REFERENCE.md',encode(docs.join('\n')));
  await add('tool-schemas.json',encode(JSON.stringify({contractVersion:2,tools:developmentToolDefinitions},null,2)+'\n'));
  const entries = Object.keys(files).sort().map(path=>({path,bytes:files[path]!.length,
    sha256:createHash('sha256').update(files[path]!).digest('hex')}));
  await add('manifest.json',encode(JSON.stringify({packageVersion:version,contractVersion:2,sourceTree:tree,entries},null,2)+'\n'));
  await writeFile(output+'/perch-agent-knowledge.zip',zipSync(files,{level:9,mtime:new Date('2000-01-01T00:00:00Z')}));
}
