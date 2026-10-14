import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChromeVisualBrowser, findChrome } from '../bin/visual-check.mjs';

// Exercise production exports and decode their bytes, rather than checking only
// that one corner happens to be transparent (which misses a baked-in grid).
const artifact = path.resolve(process.argv[2]);
const evidence = path.resolve(process.argv[3]);
fs.mkdirSync(evidence, { recursive: true });
const chrome = findChrome();
assert.ok(chrome, 'Chrome is required; transparency must be decoded in a browser');
const browser = new ChromeVisualBrowser(chrome);
const records = [];
try {
  const session = await browser.sessionPromise;
  const send = (method, params = {}) => browser.cdp.send(method, params, session);
  const run = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    return result.result?.value;
  };
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.exportBlobs=[];window.downloadBlobs=[];
    const create=URL.createObjectURL.bind(URL);
    URL.createObjectURL=blob=>{exportBlobs.push(blob);return create(blob);};
    HTMLAnchorElement.prototype.click=function(){if(this.download)downloadBlobs.push(exportBlobs.at(-1));};
    window.alert=message=>{throw Error(message);};
  ` });
  for (const theme of ['light', 'dark']) {
    const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
    await send('Page.navigate', { url: pathToFileURL(artifact).href + '?theme=' + theme });
    await loaded;
    await run('document.fonts.ready');
    await run('Archify.exportMenu.open();document.querySelector(\'[data-action="transparent-background"]\').click()');
    for (const format of ['gif', 'png', 'webp', 'svg', 'svg-light', 'svg-dark', 'webm', 'jpeg']) {
      if (format === 'webm' && !await run('typeof VideoEncoder!=="undefined"')) continue;
      const result = await run(`(async()=>{
        const start=exportBlobs.length;
        await Archify.exportMenu.run(${JSON.stringify(format)},{scale:1,duration:250,fps:8});
        if(document.documentElement.hasAttribute('data-last-export-error'))throw Error(document.documentElement.getAttribute('data-last-export-error'));
        const svgBlob=exportBlobs.slice(start).find(b=>b.type.startsWith('image/svg+xml'));
        const doc=new DOMParser().parseFromString(await svgBlob.text(),'image/svg+xml');
        const grids=doc.querySelectorAll('rect[fill="url(#grid)"]').length;
        const canvasBackgrounds=doc.querySelectorAll('.c-bg-rect').length;
        const bitmap=new Image(),svgUrl=URL.createObjectURL(svgBlob);
        await new Promise((resolve,reject)=>{bitmap.onload=resolve;bitmap.onerror=()=>reject(Error('SVG decode failed'));bitmap.src=svgUrl;});
        const c=document.createElement('canvas');c.width=bitmap.naturalWidth;c.height=bitmap.naturalHeight;
        const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);URL.revokeObjectURL(svgUrl);
        const blank=ctx.getImageData(0,0,100,30).data;
        let blankPainted=0;for(let p=3;p<blank.length;p+=4)if(blank[p])blankPainted++;
        const blob=downloadBlobs.at(-1);
        let frames=1,decodedBlankPainted=null,opaque=0,transparent=0;
        if(${JSON.stringify(format)}==='gif'){
          const decoder=new ImageDecoder({data:await blob.arrayBuffer(),type:'image/gif'});
          await decoder.tracks.ready;frames=decoder.tracks.selectedTrack.frameCount;
          for(let f=0;f<frames;f++){
            const {image}=await decoder.decode({frameIndex:f});ctx.clearRect(0,0,c.width,c.height);ctx.drawImage(image,0,0);image.close();
            const pixels=ctx.getImageData(0,0,c.width,c.height).data;
            if(!f)for(let p=3;p<pixels.length;p+=4){if(pixels[p]===255)opaque++;if(pixels[p]===0)transparent++;}
            const strip=ctx.getImageData(0,0,100,30).data;decodedBlankPainted??=0;
            for(let p=3;p<strip.length;p+=4)if(strip[p])decodedBlankPainted++;
          }
          decoder.close();
        }else if(['png','webp','jpeg'].includes(${JSON.stringify(format)})){
          const b=await createImageBitmap(blob);c.width=b.width;c.height=b.height;ctx.drawImage(b,0,0);b.close();
          const pixels=ctx.getImageData(0,0,c.width,c.height).data;
          for(let p=3;p<pixels.length;p+=4){if(pixels[p]===255)opaque++;if(pixels[p]===0)transparent++;}
        }
        return {grids,canvasBackgrounds,blankPainted,decodedBlankPainted,frames,opaque,transparent,bytes:blob.size};
      })()`);
      records.push({ theme, format, ...result });
      if (format === 'jpeg') {
        assert.equal(result.grids, 1, 'opaque JPEG keeps the normal grid');
        assert.equal(result.transparent, 0);
      } else {
        assert.equal(result.grids, 0, `${theme} ${format}: transparent export retained its grid`);
        assert.equal(result.canvasBackgrounds, 0, `${theme} ${format}: retained background`);
        assert.equal(result.blankPainted, 0, `${theme} ${format}: SVG background pixels are painted`);
        if (format === 'gif') { assert.equal(result.frames, 2); assert.equal(result.decodedBlankPainted, 0); }
        if (['gif','png','webp'].includes(format)) { assert.ok(result.opaque > 100); assert.ok(result.transparent > 100); }
      }
    }
    await run('Archify.exportMenu.open();document.querySelector(\'[data-action="transparent-background"]\').click();Archify.exportMenu.run("gif",{scale:1,duration:250,fps:8})');
    assert.equal(await run(`exportBlobs.findLast(b=>b.type.startsWith('image/svg+xml')).text().then(s=>new DOMParser().parseFromString(s,'image/svg+xml').querySelectorAll('rect[fill="url(#grid)"]').length)`), 1, 'opaque GIF retains the grid');
  }
  console.log(JSON.stringify({ passed: true, records }));
} finally {
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify(records, null, 2));
  await browser.close();
}
