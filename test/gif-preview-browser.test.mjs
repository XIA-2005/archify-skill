import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChromeVisualBrowser, findChrome } from '../bin/visual-check.mjs';

const skillRoot = fileURLToPath(new URL('../', import.meta.url));
const chrome = process.env.ARCHIFY_CHROME ? findChrome() : null;

test('GIF preview shares speed settings, paints motion and releases replaced sessions', {
  skip: chrome ? false : 'Set ARCHIFY_CHROME for GIF preview browser coverage.',
  timeout: 120000,
}, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-gif-preview-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const browser = new ChromeVisualBrowser(chrome);
  t.after(() => browser.close());
  const session = await browser.sessionPromise;
  const send = (method, params = {}) => browser.cdp.send(method, params, session);
  const run = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    return result.result?.value;
  };
  for (const [mode, fixture] of [
    ['architecture', 'web-app.architecture.json'], ['workflow', 'agent-tool-call.workflow.json'],
    ['sequence', 'cache-miss-request.sequence.json'], ['dataflow', 'product-analytics.dataflow.json'],
    ['lifecycle', 'agent-run.lifecycle.json'],
  ]) {
    const output = path.join(scratch, mode + '.html');
    execFileSync(process.execPath, [path.join(skillRoot, `renderers/${mode}/render-${mode}.mjs`), path.join(skillRoot, 'examples', fixture), output]);
    const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
    await send('Page.navigate', { url: pathToFileURL(output).href });
    await loaded;
    await run(`document.fonts.ready`);
    assert.equal(await run(`Archify.motion.motionDurationMs()`), 4000);
    await run(`window.previewUrls=new Set();window.previewErrors=[];
      const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
      URL.createObjectURL=blob=>{const url=create(blob);previewUrls.add(url);return url};
      URL.revokeObjectURL=url=>{previewUrls.delete(url);return revoke(url)};
      addEventListener('error',e=>previewErrors.push(e.message));
      window.untilPreview=async predicate=>{const end=performance.now()+10000;while(!predicate()){if(performance.now()>end)throw Error('preview did not settle');await new Promise(r=>setTimeout(r,20));}};
      Archify.exportMenu.open();`);
    assert.equal(await run(`document.getElementById('export-gif-flow').value`), 'relay', mode + ' defaults to relay');
    const title = await run(`(()=>{const title=document.querySelector('[data-action="preview-gif"] strong');title.scrollIntoView({block:'nearest'});return {text:title.textContent,width:title.getBoundingClientRect().width};})()`);
    assert.ok(title.width > 40 && title.text.trim(), JSON.stringify(title));
    await run(`window.firstPreview=Archify.motion.previewGif();untilPreview(()=>document.documentElement.dataset.gifPreview==='open')`);
    assert.equal(await run(`document.documentElement.dataset.gifPreviewDurationMs`), '4000');
    assert.equal(await run(`document.documentElement.dataset.gifPreviewFlow`), 'relay');
    const motion = await run(`(async()=>{const canvas=document.querySelector('.archify-gif-preview canvas'),ctx=canvas.getContext('2d');const first=ctx.getImageData(0,0,canvas.width,canvas.height).data;await new Promise(r=>setTimeout(r,300));const next=ctx.getImageData(0,0,canvas.width,canvas.height).data;return first.some((v,i)=>v!==next[i]);})()`);
    assert.equal(motion, true, mode + ' preview must paint changing frames');
    for (const duration of [2000, 6000]) {
      await run(`(()=>{const speed=document.getElementById('export-flow-speed');speed.value='${duration}';speed.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      assert.equal(await run(`document.documentElement.dataset.gifPreviewDurationMs`), String(duration));
      assert.equal(await run(`Archify.motion.motionDurationMs()`), duration);
    }
    if (mode === 'architecture') {
      await run(`(()=>{const mode=document.getElementById('export-gif-flow');mode.value='simultaneous';mode.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      assert.equal(await run(`document.documentElement.dataset.gifPreviewFlow`), 'simultaneous');
      await run(`(()=>{const mode=document.getElementById('export-gif-flow');mode.value='relay';mode.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      assert.equal(await run(`document.documentElement.dataset.gifPreviewFlow`), 'relay');
      const timing = await run(`(()=>{
        const p=Archify.motionGovernor.exportTimeline();
        return p.edges.map(e=>({from:e.element.getAttribute('data-edge-from'),to:e.element.getAttribute('data-edge-to'),start:e.start,land:e.start+e.travel}));
      })()`);
      const first = timing.find(e=>e.from==='users'&&e.to==='cdn');
      const next = timing.find(e=>e.from==='cdn'&&e.to==='lb');
      assert.ok(first && next && next.start >= first.land, 'the same page timeline hands off between adjacent edges');
      // Decode actual worker-encoded frames: the downstream midpoint must be
      // unchanged before departure, and visibly lit during that hop.
      const pixels = await run(`(async()=>{
        const p=Archify.motionGovernor.exportTimeline(),edge=p.edges.find(e=>e.element.getAttribute('data-edge-id')==='api-sql');
        const blob=await Archify.motion.recordGif({flowMode:'relay',duration:6000,fps:12,scale:'1'});
        const decoder=new ImageDecoder({data:await blob.arrayBuffer(),type:'image/gif'});await decoder.tracks.ready;
        const count=decoder.tracks.selectedTrack.frameCount;
        const before=Math.floor(edge.start*0.5/p.cycle*count),during=Math.ceil((edge.start+edge.travel*0.5)/p.cycle*count);
        const progress=(during/count*p.cycle-edge.start)/edge.travel;
        const pt=edge.element.getPointAtLength(edge.element.getTotalLength()*(progress-0.08));
        const vb=document.querySelector('.diagram-container > svg').viewBox.baseVal;
        const frames=[];
        for(const index of [0,before,during]) {
          const {image}=await decoder.decode({frameIndex:index});
          const canvas=document.createElement('canvas');canvas.width=image.displayWidth;canvas.height=image.displayHeight;
          const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
          const x=Math.round((pt.x-vb.x)*canvas.width/vb.width),y=Math.round((pt.y-vb.y)*canvas.height/vb.height);
          frames.push([...ctx.getImageData(x-2,y-2,5,5).data]);image.close();canvas.width=canvas.height=0;
        }
        decoder.close();
        const delta=(a,b)=>a.reduce((sum,v,i)=>sum+Math.abs(v-b[i]),0);
        return {count,before,during,early:delta(frames[0],frames[1]),late:delta(frames[0],frames[2])};
      })()`);
      assert.equal(pixels.count, 72);
      assert.ok(pixels.before > 0 && pixels.during > pixels.before, JSON.stringify(pixels));
      assert.ok(pixels.early < 60, 'downstream signal stays dark before its turn: ' + JSON.stringify(pixels));
      assert.ok(pixels.late > 100, 'encoded GIF lights the downstream signal on its turn: ' + JSON.stringify(pixels));
    }
    const evidence = process.env.ARCHIFY_PREVIEW_EVIDENCE;
    if (evidence && mode === 'architecture') {
      fs.mkdirSync(evidence, { recursive: true });
      for (const theme of ['dark', 'light']) {
        await run(`document.documentElement.setAttribute('data-theme','${theme}')`);
        const screenshot = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(evidence, `gif-preview-${theme}.png`), Buffer.from(screenshot.data, 'base64'));
      }
    }
    await run(`window.oldCanvas=document.querySelector('.archify-gif-preview canvas');window.secondPreview=Archify.motion.previewGif();untilPreview(()=>document.documentElement.dataset.gifPreview==='open')`);
    assert.equal(await run(`oldCanvas.width`), 0, 'replacing a preview releases its canvas');
    assert.deepEqual(await run(`firstPreview`), { preview: true, durationMs: 6000 });
    await run(`document.querySelector('.archify-gif-preview [data-preview-close]').click();secondPreview`);
    assert.deepEqual(await run(`({dialogs:document.querySelectorAll('.archify-gif-preview').length,urls:previewUrls.size,errors:previewErrors})`), { dialogs: 0, urls: 0, errors: [] });
  }
  const staticFile = path.join(scratch, 'static.html');
  fs.writeFileSync(staticFile, fs.readFileSync(path.join(scratch, 'architecture.html'), 'utf8').replace(' data-animation="trace"', ''));
  const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
  await send('Page.navigate', { url: pathToFileURL(staticFile).href });
  await loaded;
  await run(`document.fonts.ready`);
  assert.equal(await run(`Archify.motionGovernor.capable`), false);
  await run(`Archify.exportMenu.open()`);
  assert.deepEqual(await run(`(()=>{const item=document.getElementById('export-gif-flow');return {value:item.value,relayDisabled:item.querySelector('option[value="relay"]').disabled};})()`),
    { value: 'simultaneous', relayDisabled: true });
  assert.equal(await run(`(async()=>{const gif=await Archify.motion.recordGif({duration:500,fps:12,scale:'1'});return gif.type==='image/gif'&&gif.size>0})()`), true);
});
