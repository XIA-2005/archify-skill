import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {findChrome} from '../bin/visual-check.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
for(const [type,file] of Object.entries({erd:'orders.erd.json',class:'payments.class.json',
  tree:'payment-platform.tree.json',timeline:'payment-incident.timeline.json',waterfall:'checkout-request.waterfall.json'})){
  test(`${type} delivers checked HTML, captures and an editor bound to the candidate`,{timeout:240000},async t=>{
    if(!findChrome()){t.skip('Chrome required');return;}
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'archify-new-type-'));
    let pid;
    try{
      const candidate=JSON.parse(fs.readFileSync(path.join(root,'examples',file),'utf8'));
      candidate.meta.output='diagram.html';
      const input=path.join(dir,'candidate.json');
      fs.writeFileSync(input,JSON.stringify(candidate));
      const run=spawnSync(process.execPath,[path.join(root,'editor/deliver.mjs'),type,input,'diagram.html','--json'],
        {cwd:dir,encoding:'utf8',windowsHide:true,timeout:220000,maxBuffer:16_000_000});
      let receipt;try{receipt=JSON.parse(run.stdout);}catch{}
      pid=receipt?.editor?.pid||receipt?.editorPid;
      assert.equal(run.status,0,run.stderr+'\n'+run.stdout);
      assert.equal(receipt.ok,true);
      assert.equal(receipt.diagramType,type);
      assert.equal(receipt.editor.capability,'schema-form-json-renderer-preview');
      assert.equal(receipt.visualReview,'pending-image-inspection');
      for(const theme of ['light','dark'])assert.ok(receipt.screenshots.some(s=>s.theme===theme&&fs.existsSync(s.path)));
      assert.match(fs.readFileSync(path.join(dir,'diagram.html'),'utf8'),/<svg\b/);
      assert.equal((await fetch(receipt.editor.url)).status,200);
      const loaded=await(await fetch(receipt.editor.url+'api/spec')).json();
      assert.deepEqual(loaded.candidate,candidate);
      assert.equal(loaded.expectedHash,createHash('sha256').update(fs.readFileSync(input)).digest('hex'));
    }finally{
      if(pid){
        if(process.platform==='win32')spawnSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        else try{process.kill(pid,'SIGTERM');}catch{}
      }
      fs.rmSync(dir,{recursive:true,force:true,maxRetries:6,retryDelay:180});
    }
  });
}
