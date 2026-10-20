import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {extractSemantic, compareSemantics} from '../draft/semantic.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const nodes = ids => ids.map(id => ({id, type: 'backend', label: id}));
const edge = (from, to, label) => ({from, to, ...(label ? {label} : {})});
const base = (components, connections, boundaries) => ({schema_version: 1, diagram_type: 'architecture',
  meta: {title: 'Cross topology', output: 'diagram.html'}, components: nodes(components), connections,
  ...(boundaries ? {boundaries} : {})});
const fixtures = [
  ['chain', base(['a', 'b', 'c'], [edge('a','b'),edge('b','c')]),
    {schemaVersion:1,question:'Follow a chain',bands:[['a','b','c']],mainPath:['a','b','c']}],
  ['branch', base(['a','b','c','aux'], [edge('a','b'),edge('b','c'),edge('b','aux')]),
    {schemaVersion:1,question:'A chain with an auxiliary branch',bands:[['a','b','c'],['aux']],mainPath:['a','b','c'],branches:[{node:'aux',anchor:'b'}]}],
  ['hub', base(['hub','a','b','c'], ['a','b','c'].map(id=>edge('hub',id))),
    {schemaVersion:1,question:'A compact hub serves three peers',bands:[['hub'],['a','b','c']],mainPath:['hub','b']}],
  ['feedback', base(['a','b','c','d'], [edge('a','b'),edge('b','c'),edge('c','d'),edge('d','a','return')]),
    {schemaVersion:1,question:'A real four-step feedback cycle',bands:[['a','b'],['d','c']],mainPath:['a','b','c','d'],feedbackEdges:[{from:'d',to:'a',corridor:'left'}]}],
  ['long-label-nested-boundaries', base(['source','parser','worker'], [edge('source','parser','完整数据帧与触发条件'),edge('parser','worker','validated payload')],
    [{kind:'region',label:'Application',wraps:['parser','worker']},{kind:'region',label:'Processing',wraps:['worker']}])],
];
for (const [name, source, intent] of fixtures) test(`real draft CLI preserves ${name} topology and complete labels`, {timeout:120000}, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-quality-topology-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100}));
  const input=path.join(dir,'semantic.json'),plan=path.join(dir,'intent.json'),output=path.join(dir,'candidate.json');
  fs.writeFileSync(input,JSON.stringify(source));
  if(intent)fs.writeFileSync(plan,JSON.stringify(intent));
  const result=spawnSync(process.execPath,[path.join(root,'bin/archify.mjs'),'draft','architecture',input,output,
    ...(intent?['--intent',plan]:[]),'--json'],{cwd:dir,encoding:'utf8',timeout:110000,windowsHide:true,maxBuffer:8_000_000,
    env:{...process.env,ARCHIFY_UPDATE_CHECK_DISABLED:'1'}});
  assert.ifError(result.error); assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  const receipt=JSON.parse(result.stdout); assert.equal(receipt.ok,true);
  const candidate=JSON.parse(fs.readFileSync(output));
  assert.equal(compareSemantics(source,candidate).equivalent,true);
  assert.ok(receipt.attempts.find(a=>a.id===receipt.selected).artifactPassed);
  assert.equal(receipt.visualReview,'not-requested');
});

test('existing production fixture geometry remains an explicit no-draft boundary', () => {
  const frozen=JSON.parse(fs.readFileSync(path.join(root,'examples/web-app.architecture.json')));
  const extracted=extractSemantic(frozen);
  assert.ok(extracted.removed.length>0);
  assert.deepEqual(extractSemantic(frozen).semantic,extracted.semantic);
  assert.equal(compareSemantics(extracted.semantic,frozen).equivalent,true);
});
