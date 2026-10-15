import test from 'node:test';
import assert from 'node:assert/strict';
import {drawioSession} from './helpers/drawio-browser-session.mjs';

function fixture(){
  return {
    schema_version:1,diagram_type:'architecture',
    meta:{title:'Boundary title offset',output:'diagram.html',quality_profile:'standard'},
    components:[
      {id:'a',type:'backend',label:'Source',pos:[200,200],size:[180,80]},
      {id:'b',type:'backend',label:'Target',pos:[600,200],size:[180,80]},
    ],
    boundaries:[{kind:'region',label:'智能体运行时',wraps:['a','b'],pad:80}],
    connections:[{id:'ab',from:'a',to:'b',label:'request',fromSide:'right',toSide:'left'}],
  };
}

const probe=`(()=>{
  const c=g.model.getCell('boundary-0'); if(!c) return null;
  const s=g.view.getState(c); if(!s) return null;
  const b=g.cellRenderer.getLabelBounds(s);
  const toDiag=(x,y)=>({
    x:x/g.view.scale-g.view.translate.x,
    y:y/g.view.scale-g.view.translate.y,
  });
  const lb={
    x:b.x/g.view.scale-g.view.translate.x,
    y:b.y/g.view.scale-g.view.translate.y,
    w:b.width/g.view.scale,
    h:b.height/g.view.scale,
  };
  const bb=s.text?.boundingBox;
  const glyph=bb?{
    x:bb.x/g.view.scale-g.view.translate.x,
    y:bb.y/g.view.scale-g.view.translate.y,
    w:bb.width/g.view.scale,
    h:bb.height/g.view.scale,
  }:null;
  const handler=g.selectionCellsHandler.getHandler(c);
  const hs=handler?.labelShape;
  let handle=null, handleVsGlyph=null;
  if(hs){
    const cx=hs.bounds.x+hs.bounds.width/2, cy=hs.bounds.y+hs.bounds.height/2;
    handle={...toDiag(cx,cy), w:hs.bounds.width/g.view.scale, h:hs.bounds.height/g.view.scale};
    if(glyph){
      const gcx=glyph.x+glyph.w/2, gcy=glyph.y+glyph.h/2;
      const dx=handle.x-gcx, dy=handle.y-gcy;
      handleVsGlyph={dx,dy,dist:Math.hypot(dx,dy)};
    }
  }
  return {
    offset:c.geometry.offset?{x:c.geometry.offset.x,y:c.geometry.offset.y}:{x:0,y:0},
    labelBounds:lb,
    glyph,
    handle,
    handleVsGlyph,
    whiteSpace:String(g.getCellStyle(c).whiteSpace||''),
    movableLabel:String(g.getCellStyle(c).movableLabel||''),
    labelMovableOk:g.isLabelMovable(c),
  };
})()`;

async function setOffsetField(b,name,val){
  return b.evaluate(`(()=>{
    const l=[...document.querySelectorAll('aside label')].find(x=>x.textContent.includes(${JSON.stringify(name)}));
    if(!l) throw Error('missing field '+${JSON.stringify(name)});
    const i=l.querySelector('input'); i.value=${JSON.stringify(String(val))};
    i.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
}

async function waitOffset(b, expected){
  await b.until(async()=>{
    const shot=await b.snapshot();
    const got=shot.boundaries[0].labelOffset;
    if(expected==null) return got==null;
    return Array.isArray(got) && got[0]===expected[0] && got[1]===expected[1];
  });
  // Allow draw.io reload+snap to settle after JSON update.
  await b.sleep(500);
}

test('draw.io boundary title offset is snap-plus-authored and [0,0] clears',{timeout:180000},async t=>{
  const b=await drawioSession(t,fixture()); if(!b) return;
  await b.native(`g.setSelectionCell(g.model.getCell('boundary-0'))`);
  await b.sleep(200);
  const before=await b.native(probe);
  assert.ok(before,'boundary-0 must exist');
  assert.equal(before.movableLabel,'1','group titles must set movableLabel for canvas drag');
  assert.equal(before.labelMovableOk,true,'isLabelMovable must be true for boundary titles');
  assert.notEqual(before.whiteSpace,'wrap','boundary titles must not use whiteSpace=wrap');
  assert.ok(before.glyph,'text boundingBox must be available for handle proximity check');
  assert.ok(before.handleVsGlyph && before.handleVsGlyph.dist < 40,
    `yellow handle must sit near title glyph, dist=${before.handleVsGlyph?.dist}`);
  const snap={x:before.offset.x,y:before.offset.y};
  t.diagnostic('snap baseline '+JSON.stringify(before));

  await setOffsetField(b,'标题水平偏移',80);
  // Immediate draw.io move must not wait on route-preview refresh (BUG2).
  await b.until(async()=>{
    const mid=await b.native(probe);
    return mid && Math.abs(mid.offset.x-(snap.x+80))<1.5;
  });
  const midImmediate=await b.native(probe);
  assert.ok(Math.abs(midImmediate.offset.x-(snap.x+80))<1.5,
    `immediate geometry.offset.x should be snap+80 (${snap.x}+80), got ${midImmediate.offset.x}`);
  assert.ok(Math.abs(midImmediate.offset.y-snap.y)<1.5,
    `immediate geometry.offset.y should stay at snap (${snap.y}), got ${midImmediate.offset.y}`);
  assert.ok(Math.abs(midImmediate.labelBounds.x-(before.labelBounds.x+80))<2,
    `immediate labelBounds.x should move +80 from ${before.labelBounds.x}, got ${midImmediate.labelBounds.x}`);
  assert.ok(Math.abs(midImmediate.labelBounds.y-before.labelBounds.y)<2,
    `immediate labelBounds.y must not jump when only H changes (${before.labelBounds.y} vs ${midImmediate.labelBounds.y})`);

  await waitOffset(b,[80,0]);
  const mid=await b.native(probe);
  assert.ok(Math.abs(mid.offset.x-(snap.x+80))<1.5,
    `settled geometry.offset.x should be snap+80 (${snap.x}+80), got ${mid.offset.x}`);
  assert.ok(Math.abs(mid.offset.y-snap.y)<1.5,
    `settled geometry.offset.y should stay at snap (${snap.y}), got ${mid.offset.y}`);
  assert.ok(Math.abs(mid.labelBounds.x-(before.labelBounds.x+80))<2,
    `settled labelBounds.x should move +80 from ${before.labelBounds.x}, got ${mid.labelBounds.x}`);
  assert.ok(mid.handleVsGlyph && mid.handleVsGlyph.dist < 40,
    `after H=80 handle must stay near glyph, dist=${mid.handleVsGlyph?.dist}`);

  await setOffsetField(b,'标题垂直偏移',40);
  await b.until(async()=>{
    const v=await b.native(probe);
    return v && Math.abs(v.offset.y-(snap.y+40))<1.5;
  });
  const withV=await b.native(probe);
  assert.ok(Math.abs(withV.offset.x-(snap.x+80))<1.5,'H stays while V changes');
  assert.ok(Math.abs(withV.offset.y-(snap.y+40))<1.5,
    `immediate geometry.offset.y should be snap+40 (${snap.y}+40), got ${withV.offset.y}`);
  assert.ok(Math.abs(withV.labelBounds.y-(before.labelBounds.y+40))<2,
    `immediate labelBounds.y should move +40 from ${before.labelBounds.y}, got ${withV.labelBounds.y}`);

  await setOffsetField(b,'标题水平偏移',0);
  await setOffsetField(b,'标题垂直偏移',0);
  await waitOffset(b,null);
  const afterClear=await b.native(probe);
  assert.ok(Math.abs(afterClear.offset.x-snap.x)<1.5,'reset to 0 restores snap offset x');
  assert.ok(Math.abs(afterClear.offset.y-snap.y)<1.5,'reset to 0 restores snap offset y');
  assert.ok(Math.abs(afterClear.labelBounds.x-before.labelBounds.x)<2,'label returns to snapped default x');
  assert.ok(Math.abs(afterClear.labelBounds.y-before.labelBounds.y)<2,'label returns to snapped default y');
});

test('draw.io canvas drag of group title updates labelOffset relatively',{timeout:180000},async t=>{
  const b=await drawioSession(t,fixture()); if(!b) return;
  await b.native(`g.setSelectionCell(g.model.getCell('boundary-0'))`);
  await b.sleep(200);
  const before=await b.native(probe);
  const snap={x:before.offset.x,y:before.offset.y};
  assert.ok(before.handleVsGlyph && before.handleVsGlyph.dist < 40,
    `drag test requires handle near glyph, dist=${before.handleVsGlyph?.dist}`);
  const at=await b.native(`(()=>{
    const c=g.model.getCell('boundary-0');
    g.setSelectionCell(c);
    const handler=g.selectionCellsHandler.getHandler(c);
    if(!handler?.labelShape?.node) throw Error('missing label handle');
    const r=handler.labelShape.node.getBoundingClientRect(), fr=f.getBoundingClientRect();
    return [r.x+r.width/2+fr.x, r.y+r.height/2+fr.y];
  })()`);
  await b.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:at[0],y:at[1]});
  await b.call('Input.dispatchMouseEvent',{type:'mousePressed',x:at[0],y:at[1],button:'left',clickCount:1});
  for(let i=1;i<=8;i++){
    await b.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:at[0]+50*i/8,y:at[1],button:'left',buttons:1});
  }
  await b.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:at[0]+50,y:at[1],button:'left',clickCount:1});
  await b.until(async()=>{
    const shot=await b.snapshot();
    return Array.isArray(shot.boundaries[0].labelOffset) && Math.abs(shot.boundaries[0].labelOffset[0])>15;
  });
  const after=await b.snapshot();
  const offset=after.boundaries[0].labelOffset;
  assert.ok(Array.isArray(offset),'canvas title drag must write labelOffset');
  assert.ok(offset[0]>15,'dragged title should gain positive horizontal labelOffset, got '+offset[0]);
  assert.ok(Math.abs(offset[1])<12,'horizontal drag should not invent a large vertical offset, got '+offset[1]);
  await b.sleep(400);
  const geo=await b.native(probe);
  assert.ok(Math.abs(geo.offset.x-(snap.x+offset[0]))<3,
    `after drag, geometry.offset.x≈snap+labelOffset (${snap.x}+${offset[0]}), got ${geo.offset.x}`);
  await b.screenshot('boundary-title-drag');
});
