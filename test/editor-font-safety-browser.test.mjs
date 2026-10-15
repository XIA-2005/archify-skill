import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {startEditor} from './editor-test-helpers.mjs';
import {ChromeVisualBrowser, findChrome} from '../bin/visual-check.mjs';

const candidate = () => ({schema_version:1, diagram_type:'architecture',
  meta:{title:'字体测试', output:'diagram.html', quality_profile:'standard'},
  components:[{id:'a', type:'backend', label:'模块', pos:[200,160], size:[220,84]}],
  cards:[{title:'说明', dot:'cyan', items:['正常内容']}]});
// Synthetic local marker only; no external resources or project data.
const marker = '12px"><svg id="font-regression-marker" onload="window.fontRegressionEvent=true"></svg><i style="font-size:12';

test('editor rejects invalid font candidates on initial load, reload and client import', {timeout:180000}, async t => {
  const chrome=findChrome(); if(!chrome){t.skip('Chrome required');return;}
  const source=candidate();
  const {base,input,server}=await startEditor(t,source);
  t.after(()=>{server.stdout.destroy();server.stderr.destroy();});
  let browser=new ChromeVisualBrowser(chrome);t.after(()=>browser.close());
  let sid=await browser.sessionPromise;
  const call=(method,params={})=>browser.cdp.send(method,params,sid);
  const run=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    assert.equal(r.exceptionDetails,undefined);return r.result?.value;};
  const until=async (expression,timeout=30000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await run(expression))return;await new Promise(r=>setTimeout(r,50));}assert.fail('Editor did not settle');};
  const clean=async()=>assert.deepEqual(await run(`({element:!!document.getElementById('font-regression-marker'),event:window.fontRegressionEvent===true})`),{element:false,event:false});
  await call('Page.navigate',{url:base});
  await until(`document.querySelector('#card-preview h3')?.textContent==='说明'`);
  for(const field of ['title','items']){
    const bad=candidate();bad.cards[0].font_sizes=field==='title'?{title:marker}:{items:[marker]};
    fs.writeFileSync(input,JSON.stringify(bad));
    assert.equal((await fetch(new URL('api/spec',base))).status,422);
    // Also exercise the browser boundary independently of the server check.
    await run(`window.originalFontFetch ||= window.fetch;window.fetch=async(url,...args)=>String(url).includes('api/spec')?new Response(${JSON.stringify(JSON.stringify({candidate:bad,expectedHash:'synthetic'}))},{status:200,headers:{'Content-Type':'application/json'}}):window.originalFontFetch(url,...args);document.getElementById('reload').click()`);
    await until(`document.getElementById('message').classList.contains('error')`);
    await clean();
    assert.equal(await run(`document.querySelector('#card-preview h3').textContent`),'说明');
    await run(`window.fetch=window.originalFontFetch`);
  }
  // Use a separate browser session so this is an initial load, with no draft
  // history or unsaved-changes dialog from the previous editor document.
  await browser.close();browser=new ChromeVisualBrowser(chrome);
  sid=await browser.sessionPromise;
  await call('Page.navigate',{url:base});
  await until(`document.getElementById('message')?.classList.contains('error')`);await clean();
  const valid=candidate();valid.meta.font_sizes={title:72,subtitle:6};
  valid.cards[0].items.push('默认字号');
  valid.cards[0].font_sizes={title:6,items:[13.5,null]};
  fs.writeFileSync(input,JSON.stringify(valid));
  await run(`document.getElementById('reload').click()`);
  await until(`document.querySelector('#card-preview li')?.style.fontSize==='13.5px'`);
  assert.equal(await run(`document.getElementById('diagram-title').style.fontSize`),'72px');
  assert.equal(await run(`document.querySelector('#card-preview h3').style.fontSize`),'6px');
  await clean();
  const current=await (await fetch(new URL('api/spec',base))).json();
  const post=async(endpoint,body)=>fetch(new URL('api/'+endpoint,base),{method:'POST',
    headers:{Origin:new URL(base).origin,'Content-Type':'application/json','X-Archify-Editor':'1'},body:JSON.stringify(body)});
  const preview=await post('image-preview',current.candidate);
  assert.equal(preview.status,200,JSON.stringify(await preview.json()));
  const response=await post('save',{candidate:current.candidate,expectedHash:current.expectedHash});
  const saved=await response.json();
  assert.equal(response.status,200,saved.message);assert.equal(saved.ok,true);
  assert.deepEqual(JSON.parse(fs.readFileSync(input,'utf8')),valid);
});
