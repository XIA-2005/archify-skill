import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {drawioSession} from './helpers/drawio-browser-session.mjs';

test('opening, reloading and saving a fitted legacy font preserves the candidate', {timeout:120000}, async t => {
  const candidate = {schema_version:1,diagram_type:'architecture',
    meta:{title:'Legacy fitted font',output:'diagram.html',quality_profile:'standard',font_scale:1.25},
    components:[{id:'control',type:'backend',label:'Control',
      sublabel:'Sorting_Task / Auto_Packaging_Process',pos:[200,160],size:[240,88]}]};
  const b = await drawioSession(t,candidate); if(!b)return;
  assert.deepEqual(await b.snapshot(),candidate,'Loading must not quantize 10.4px into an invalid 10.5px override');
  assert.equal(await b.native(`g.getCellStyle(g.model.getCell('node-control').children.find(c=>c.archifyTextField==='sublabel')).fontSize`),10.4);
  assert.equal(await b.evaluate(`document.getElementById('save').textContent.includes('●')`),false,'Opening is not an edit');
  await b.evaluate(`document.getElementById('reload').click()`);
  await b.until(()=>b.evaluate(`document.getElementById('message').textContent.includes('已加载')`));
  assert.deepEqual(await b.snapshot(),candidate);
  await b.evaluate(`document.getElementById('save').click()`);
  await b.until(()=>b.evaluate(`document.getElementById('message').textContent.includes('JSON 已保存')`));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.dir,'candidate.json'),'utf8')),candidate);
});
