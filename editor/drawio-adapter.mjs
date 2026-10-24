import {architectureNodeBox} from './shared/architecture-position.mjs';
import {componentTextGeometry} from './shared/text-style.mjs';
// Data bridge only. Pointer, keyboard, handles, guides and context menus run in
// the unmodified draw.io EditorUi/Graph vendored from the user's desktop build.
export function createDrawioAdapter(frame, callbacks) {
  let api, imported, signature, suppress=false, selectedSignature, seeded=false;
  const lastTitleSnap=new Map();
  const nodes=new Map(), edges=new Map(), boundaries=new Map(), baseline=new Map();
  let fontHighlights=[];
  const copy=value=>structuredClone(value);
  const round=n=>Math.round(n*1000)/1000;
  const style=(entries)=>Object.entries(entries).map(([k,v])=>`${k}=${v}`).join(';')+';';
  const geometryKey=spec=>JSON.stringify({...spec,
    components:spec.components.map(({label,sublabel,tag,...node})=>node),
    boundaries:(spec.boundaries||[]).map(({label,...boundary})=>boundary),
    connections:(spec.connections||[]).map(({label,...edge})=>edge)},
    (key,value)=>['font_sizes','font_size','labelColor'].includes(key)?undefined:value);
  function absolute(cell) {
    const g=cell.geometry;let x=g.x,y=g.y,p=cell.parent;
    while(p?.geometry){x+=p.geometry.x;y+=p.geometry.y;p=p.parent;}
    return [round(x),round(y),round(g.width),round(g.height)];
  }
  function side(port) {
    const [x,y]=port;
    return [[x,'left'],[1-x,'right'],[y,'top'],[1-y,'bottom']].sort((a,b)=>a[0]-b[0])[0][1];
  }
  function port(node,point) {
    const [x,y,w,h]=absolute(node);
    // Relative port precision must match the frozen absolute route. Rounding a
    // fraction to 0.001 can move an endpoint by 0.18px on a 180px-wide box.
    return [(round(point.x)-x)/w,(round(point.y)-y)/h].map(n=>Math.max(0,Math.min(1,n)));
  }
  const cellLabel=c=>String(c.value??'');
  const edgeState=cell=>{
    const g=cell.geometry;
    return {label:cellLabel(cell),from:cell.source?.archifyId,to:cell.target?.archifyId,
      points:(g.points||[]).map(p=>[p.x,p.y]),style:cell.style,x:g.x,y:g.y,
      offset:g.offset?[g.offset.x,g.offset.y]:null,
      terminals:[cell.source?.geometry?absolute(cell.source):null,cell.target?.geometry?absolute(cell.target):null],
      parentOrigin:cell.parent?.geometry?absolute(cell.parent).slice(0,2):[0,0]};
  };
  function capture() {
    baseline.clear();
    for(const [id,c]of nodes) baseline.set(c,JSON.stringify({box:absolute(c),label:cellLabel(c),parent:c.parent.id}));
    for(const [id,c]of boundaries)baseline.set(c,JSON.stringify({box:absolute(c),label:cellLabel(c),offset:c.geometry.offset?[c.geometry.offset.x,c.geometry.offset.y]:[0,0]}));
    for(const [id,c]of edges)baseline.set(c,JSON.stringify(edgeState(c)));
  }
  function changed() {
    if(suppress||!imported)return;
    const {graph,ui}=api,model=graph.model,next=copy(imported);
    // Bind authored objects to cells before filtering changes their array indices.
    const edgeCells=new Map((next.connections||[]).map((e,i)=>[e,edges.get(e.id||'edge-'+i)]));
    const boundaryCells=new Map((next.boundaries||[]).map((b,i)=>[b,boundaries.get(i)]));
    for(const c of Object.values(model.cells)){
      if(!c.vertex||c.archifyKind==='boundary'||c.archifyDecoration||[...nodes.values()].includes(c))continue;
      const original=next.components.find(n=>n.id===c.archifyId);
      const box=absolute(c),id='component-'+crypto.randomUUID();
      const n=original?copy(original):{type:'backend',label:cellLabel(c)||'模块'};
      n.id=id;n.pos=box.slice(0,2);n.size=box.slice(2);next.components.push(n);
      c.archifyId=id;c.archifyKind='node';nodes.set(id,c);
      baseline.set(c,JSON.stringify({box,label:cellLabel(c),parent:c.parent.id}));
    }
    next.components=next.components.filter(n=>model.contains(nodes.get(n.id)));
    for(const n of next.components){
      const c=nodes.get(n.id),previous=JSON.parse(baseline.get(c));
      const box=absolute(c);
      if(JSON.stringify(box)!==JSON.stringify(previous.box)){n.pos=box.slice(0,2);n.size=box.slice(2);}
      if(cellLabel(c)!==previous.label)n.label=cellLabel(c);
      if(c.parent.id!==previous.parent){
        for(const [i,b]of (next.boundaries||[]).entries()){
          if(boundaries.get(i)?.id===previous.parent)b.wraps=b.wraps.filter(id=>id!==n.id);
          if(boundaries.get(i)===c.parent&&!b.wraps.includes(n.id))b.wraps.push(n.id);
        }
      }
    }
    next.boundaries=(next.boundaries||[]).flatMap((b,i)=>{
      const c=boundaryCells.get(b);if(!model.contains(c))return [];
      const previous=JSON.parse(baseline.get(c)),box=absolute(c);
      if(JSON.stringify(box)!==JSON.stringify(previous.box))b.bounds=box;
      if(cellLabel(c)!==previous.label)b.label=cellLabel(c);
      const offset=c.geometry.offset?[c.geometry.offset.x,c.geometry.offset.y]:[0,0];
      // geometry.offset is draw.io's label shift; formal HTML adds labelOffset to
      // the composed title rail. Convert through the load-time baseline so a
      // title snapped to the official SVG does not rewrite JSON until dragged.
      if(JSON.stringify(offset)!==JSON.stringify(previous.offset)){
        const base=b.labelOffset||[0,0];
        const next=[round(base[0]+offset[0]-previous.offset[0]),round(base[1]+offset[1]-previous.offset[1])];
        // [0,0] is not authored — delete so formal layout keeps rail/slide defaults.
        if(next[0]===0&&next[1]===0)delete b.labelOffset; else b.labelOffset=next;
      }
      b.wraps=b.wraps.filter(id=>next.components.some(n=>n.id===id));
      return b.wraps.length?[b]:[];
    });
    if(!Object.hasOwn(imported,'boundaries')&&!next.boundaries.length)delete next.boundaries;
    next.connections=(next.connections||[]).filter(e=>model.contains(edgeCells.get(e)))
      .filter(e=>next.components.some(n=>n.id===e.from)&&next.components.some(n=>n.id===e.to));
    // Newly drawn connections are native draw.io cells. Existing component
    // metadata, source citations and IDs stay in the Archify model.
    for(const c of Object.values(model.cells)){
      if(!c.edge||[...edges.values()].includes(c))continue;
      if(!c.source?.archifyId||!c.target?.archifyId)continue;
      const id='connection-'+crypto.randomUUID();c.archifyKind='edge';c.archifyId=id;edges.set(id,c);
      const edge={id,from:c.source.archifyId,to:c.target.archifyId,label:cellLabel(c)};next.connections.push(edge);edgeCells.set(edge,c);
    }
    for(const [i,e]of next.connections.entries()){
      const c=edgeCells.get(e);if(!c)continue;
      const previous=baseline.has(c)?JSON.parse(baseline.get(c)):null;
      const now=edgeState(c);if(previous&&JSON.stringify(now)===JSON.stringify(previous))continue;
      const state=graph.view.getState(c);
      if(!state||!c.source?.archifyId||!c.target?.archifyId)continue;
      e.from=c.source.archifyId;e.to=c.target.archifyId;e.label=cellLabel(c);
      const differs=fields=>!previous||fields.some(key=>JSON.stringify(previous[key])!==JSON.stringify(now[key]));
      const geometryChanged=differs(['from','to','points','terminals','parentOrigin']);
      const labelMoved=geometryChanged||differs(['x','y','offset']);
      const points=state.absolutePoints.filter(Boolean).map(p=>({
        x:round(p.x/graph.view.scale-graph.view.translate.x),
        y:round(p.y/graph.view.scale-graph.view.translate.y)}));
      if(graph.getCellStyle(c).edgeStyle){
        // draw.io quantizes rendered screen points. Join collinear coordinate
        // runs before persisting, so sub-pixel screen rounding does not turn a
        // native orthogonal segment into a diagonal in diagram coordinates.
        const epsilon=0.5/graph.view.scale;
        for(let pass=0;pass<3;pass++){
          for(let j=0;j<points.length-1;j++){
            const a=points[j],b=points[j+1];
            if(Math.abs(a.y-b.y)<epsilon){if(j===points.length-2)a.y=b.y;else b.y=a.y;}
            if(Math.abs(a.x-b.x)<epsilon){if(j===points.length-2)a.x=b.x;else b.x=a.x;}
          }
        }
      }
      if(geometryChanged&&points.length>=2){
        e.fromPort=port(c.source,points[0]);e.toPort=port(c.target,points.at(-1));
        e.fromSide=side(e.fromPort);e.toSide=side(e.toPort);
        e.via=points.slice(1,-1).map(p=>[round(p.x),round(p.y)]);
        e.route=graph.getCellStyle(c).edgeStyle?'orthogonal-h':'straight';
      }
      if(labelMoved&&state.absoluteOffset&&e.label){
        e.labelAt=[round(state.absoluteOffset.x/graph.view.scale-graph.view.translate.x),
          round(state.absoluteOffset.y/graph.view.scale-graph.view.translate.y)];
        delete e.labelDx;delete e.labelDy;delete e.labelSegment;
      }
    }
    if(!Object.hasOwn(imported,'connections')&&!next.connections.length)delete next.connections;
    if(JSON.stringify(next)===JSON.stringify(imported))return;
    // Keep native routes intact while reindexing surviving cells.
    nodes.forEach((c,id)=>{if(!model.contains(c))nodes.delete(id);});
    edges.clear();boundaries.clear();
    for(const [i,e]of (next.connections||[]).entries()){
      const c=edgeCells.get(e),id=e.id||'edge-'+i;c.archifyId=id;edges.set(id,c);
    }
    for(const [i,b]of (next.boundaries||[]).entries()){
      const c=boundaryCells.get(b);c.archifyId=i;boundaries.set(i,c);
    }
    imported=copy(next);signature=JSON.stringify(next);seeded=true;capture();
    ui.editor.setModified(false); // The parent owns persistence and unload warnings.
    callbacks.change(next);
  }
  function updateNodeText(node,cell,scale=1) {
    const {graph}=api,model=graph.model,sizes=componentTextGeometry(node,scale).sizes;
    model.setValue(cell,node.label);
    graph.setCellStyles('fontSize',sizes.label,[cell]);
    const decorated=Boolean(node.sublabel||node.tag);
    graph.setCellStyles('verticalAlign',decorated?'top':'middle',[cell]);
    graph.setCellStyles('spacingTop',decorated?'8':'0',[cell]);
    for(const [key,fraction]of [['sublabel',0.58],['tag',0.84]]){
      let child=(cell.children||[]).find(c=>c.archifyTextField===key);
      if(!node[key]){if(child)model.remove(child);continue;}
      if(!child){
        child=graph.insertVertex(cell,null,node[key],0,fraction,cell.geometry.width,0,style({
          shape:'text',fillColor:'none',strokeColor:'none',fontColor:'#526b83',
          fontSize:sizes[key],whiteSpace:'wrap',html:0,
          resizable:0,movable:0,selectable:0,editable:0,connectable:0}),true);
        child.archifyDecoration=true;child.archifyTextField=key;child.setConnectable(false);
      }else{model.setValue(child,node[key]);graph.setCellStyles('fontSize',sizes[key],[child]);}
    }
  }
  function patchText(spec,key) {
    const {graph,ui}=api,model=graph.model;
    suppress=true;model.beginUpdate();
    try{
      for(const n of spec.components)updateNodeText(n,nodes.get(n.id),spec.meta.font_scale??1);
      for(const [i,b]of (spec.boundaries||[]).entries()){
        const c=boundaries.get(i);model.setValue(c,b.label);
        graph.setCellStyles('fontSize',b.font_sizes?.label??9*(spec.meta.font_scale??1),[c]);
      }
      for(const [i,e]of (spec.connections||[]).entries()){
        const c=edges.get(e.id||'edge-'+i);
        model.setValue(c,e.label||'');
        graph.setCellStyles('fontSize',e.font_sizes?.label??8*(spec.meta.font_scale??1),[c]);
        graph.setCellStyles('fontColor',e.labelColor||'#526b83',[c]);
      }
    }finally{model.endUpdate();suppress=false;}
    imported=copy(spec);signature=key;capture();ui.editor.setModified(false);
  }
  function load(spec,routes,scene,sceneOffsets) {
    if(!api||!spec)return;
    const key=JSON.stringify(spec);
    if(key===signature && (seeded||!routes))return;
    // A text, type-size or color edit must not discard native routes or automatic
    // label anchors. Patch the existing cells, including when undoing that edit.
    if(imported&&seeded&&geometryKey(imported)===geometryKey(spec)){
      patchText(spec,key);return;
    }
    // Incomplete rebuilds (no official routes and/or scene) must not keep seeded=true,
    // or a later load(routes,scene) for the same spec early-returns and skips title snap.
    seeded=Boolean(routes&&scene);
    const {graph,ui}=api,w=frame.contentWindow,model=graph.model;
    const remembered=graph.getSelectionCells().map(c=>[c.archifyKind,c.archifyId]);
    suppress=true;model.beginUpdate();
    try{
      graph.clearSelection();graph.removeCells(graph.getChildCells(graph.getDefaultParent(),true,true));
      nodes.clear();edges.clear();boundaries.clear();baseline.clear();
      const parent=graph.getDefaultParent();
      for(const [i,b]of (spec.boundaries||[]).entries()){
        const rect=scene?.querySelector('[data-composition-frame-id="'+i+'"]');
        const members=b.wraps.map(id=>spec.components.find(n=>n.id===id)).filter(Boolean).map(n=>architectureNodeBox(n,spec));
        if(!members.length)continue;
        const pad=b.pad??30;
        const x=Math.min(...members.map(n=>n.x))-pad,
          y=Math.min(...members.map(n=>n.y))-pad;
        const fallback=[x,y,Math.max(...members.map(n=>n.x+n.w))+pad-x,
          Math.max(...members.map(n=>n.y+n.h))+pad-y];
        const box=b.bounds||(rect?['x','y','width','height'].map(k=>Number(rect.getAttribute(k))):fallback);
        const cell=graph.insertVertex(parent,'boundary-'+i,b.label,...box,style({
          rounded:1,arcSize:10,fillColor:'none',strokeColor:'#647c98',dashed:1,
          container:1,collapsible:0,recursiveResize:0,connectable:0,movableLabel:1,
          align:'left',verticalAlign:'top',spacing:12,fontSize:b.font_sizes?.label??9*(spec.meta.font_scale??1),
          fontColor:'#526b83',html:0}));
        cell.archifyKind='boundary';cell.archifyId=i;cell.setConnectable(false);boundaries.set(i,cell);
      }
      for(const n of spec.components){
        const {x,y,w:width,h}=architectureNodeBox(n,spec),box=[x,y,width,h];
        // The innermost containing frame owns movement. Overlapping semantic
        // wraps remain in JSON; they are not silently changed by import.
        const owner=[...boundaries].filter(([i,c])=>(spec.boundaries[i].wraps||[]).includes(n.id))
          .filter(([i,c])=>{const g=c.geometry;return box[0]>=g.x&&box[1]>=g.y&&box[0]+box[2]<=g.x+g.width&&box[1]+box[3]<=g.y+g.height;})
          .sort((a,b)=>a[1].geometry.width*a[1].geometry.height-b[1].geometry.width*b[1].geometry.height)[0]?.[1];
        if(owner){box[0]-=owner.geometry.x;box[1]-=owner.geometry.y;}
        const sizes=componentTextGeometry(n,spec.meta.font_scale??1).sizes;
        const c=graph.insertVertex(owner||parent,'node-'+n.id,n.label,...box,style({
          rounded:1,arcSize:12,whiteSpace:'wrap',html:0,fillColor:'#eaf3fd',strokeColor:'#739cc3',
          fontColor:'#172f48',fontSize:sizes.label,rotation:0}));
        c.archifyKind='node';c.archifyId=n.id;nodes.set(n.id,c);
        updateNodeText(n,c,spec.meta.font_scale??1);
      }
      for(const [i,e]of (spec.connections||[]).entries()){
        const r=routes?.get(i),id=e.id||'edge-'+i;
        const entries={edgeStyle:e.route==='straight'?'none':'orthogonalEdgeStyle',rounded:1,
          html:0,endArrow:'block',endFill:1,strokeColor:e.variant==='emphasis'?'#087e61':'#2679bd',
          strokeWidth:(e.width||1.5)*(spec.meta.line_scale||1),fontColor:e.labelColor||'#526b83',
          fontSize:e.font_sizes?.label??8*(spec.meta.font_scale??1),labelBackgroundColor:'none'};
        const points=r?.points;
        for(const [field,node,p]of [['exit',nodes.get(e.from),e.fromPort],['entry',nodes.get(e.to),e.toPort]]){
          if(!node)continue;
          const point=p||(points?.length?port(node,{x:points[field==='exit'?0:points.length-1][0],y:points[field==='exit'?0:points.length-1][1]}):null);
          if(point){entries[field+'X']=point[0];entries[field+'Y']=point[1];entries[field+'Perimeter']=0;}
        }
        const c=graph.insertEdge(parent,'edge-'+id,e.label||'',nodes.get(e.from),nodes.get(e.to),style(entries));
        c.archifyKind='edge';c.archifyId=id;
        const g=c.geometry.clone();
        const origin=c.parent.geometry?absolute(c.parent).slice(0,2):[0,0];
        g.points=(e.via||points?.slice(1,-1)||[]).map(p=>new w.mxPoint(p[0]-origin[0],p[1]-origin[1]));
        model.setGeometry(c,g);edges.set(id,c);
      }
    } finally {model.endUpdate();suppress=false;}
    graph.view.validate();
    // Formal HTML composes the title rail (layoutBoundaryTitles / slideTitleOffRoutes)
    // then adds labelOffset. draw.io native titles sit at align/verticalAlign top-left
    // + spacing 12. Always snap to the rail, then add authored labelOffset so inspector
    // numbers and canvas title drags stay WYSIWYG. The official scene mask is the final
    // title (rail + offset baked when the scene was captured). Recover the rail with
    // sceneOffsets (offsets at capture time) when provided -- same as SVG's
    // renderedBoundaryOffsets -- otherwise assume the mask embeds the current add.
    // Keep last snap S0 so labelOffset-only redraws with scene=null still apply S0+add.
    const authoredOffset=b=>{
      const o=b.labelOffset;
      if(!Array.isArray(o)||(Number(o[0])===0&&Number(o[1])===0))return [0,0];
      return [Number(o[0])||0,Number(o[1])||0];
    };
    const applyTitleOffset=(i,sx,sy,add)=>{
      const c=boundaries.get(i);if(!c)return;
      const g=c.geometry.clone();
      g.offset=new w.mxPoint(sx+add[0],sy+add[1]);
      model.setGeometry(c,g);
      lastTitleSnap.set(i,[sx,sy]);
    };
    if(scene){
      suppress=true;model.beginUpdate();
      try{for(const [i,b]of (spec.boundaries||[]).entries()){
        const c=boundaries.get(i);if(!c)continue;
        const mask=scene.querySelector('[data-graph-role="structural-frame-label"][data-composition-frame-id="'+i+'"] [data-graph-role="structural-frame-label-mask"]');
        if(!mask)continue;
        const g=c.geometry.clone();g.offset=new w.mxPoint(0,0);model.setGeometry(c,g);
      }}finally{model.endUpdate();suppress=false;}
      graph.view.validate();
      suppress=true;model.beginUpdate();
      try{for(const [i,b]of (spec.boundaries||[]).entries()){
        const c=boundaries.get(i);if(!c)continue;
        const mask=scene.querySelector('[data-graph-role="structural-frame-label"][data-composition-frame-id="'+i+'"] [data-graph-role="structural-frame-label-mask"]');
        if(!mask)continue;
        const add=authoredOffset(b);
        const baked=Array.isArray(sceneOffsets?.[i])?[Number(sceneOffsets[i][0])||0,Number(sceneOffsets[i][1])||0]:add;
        // Mask embeds baked offset; rail = mask - baked. Then offset = (rail-cur)+add.
        const targetX=Number(mask.getAttribute('x'))-baked[0],targetY=Number(mask.getAttribute('y'))-baked[1];
        const s=graph.view.getState(c);if(!s)continue;
        const bounds=graph.cellRenderer.getLabelBounds(s);
        const curX=bounds.x/graph.view.scale-graph.view.translate.x;
        const curY=bounds.y/graph.view.scale-graph.view.translate.y;
        applyTitleOffset(i,round(targetX-curX),round(targetY-curY),add);
      }}finally{model.endUpdate();suppress=false;}
      graph.view.validate();
    }else if(lastTitleSnap.size){
      // No official scene this frame (e.g. routeKey changed on labelOffset-only edit).
      // Re-apply last snap S0 + current add so inspector H/V move draw.io immediately.
      suppress=true;model.beginUpdate();
      try{for(const [i,b]of (spec.boundaries||[]).entries()){
        const snap=lastTitleSnap.get(i);if(!snap)continue;
        applyTitleOffset(i,snap[0],snap[1],authoredOffset(b));
      }}finally{model.endUpdate();suppress=false;}
      graph.view.validate();
    }
    // Position edge labels in the same diagram coordinates as the official SVG.
    suppress=true;model.beginUpdate();
    try{for(const [i,e]of (spec.connections||[]).entries()){
      const c=edges.get(e.id||'edge-'+i),s=graph.view.getState(c),r=routes?.get(i);
      const at=e.labelAt||(r?.labelBox?[r.labelBox.x+r.labelBox.width/2,r.labelBox.y+r.labelBox.height/2]:null);
      if(s&&at){const g=c.geometry.clone();g.offset=new w.mxPoint(at[0]-s.absoluteOffset.x/graph.view.scale+graph.view.translate.x,
        at[1]-s.absoluteOffset.y/graph.view.scale+graph.view.translate.y);model.setGeometry(c,g);}
    }}finally{model.endUpdate();suppress=false;}
    imported=copy(spec);signature=key;capture();
    ui.editor.setModified(false);
    graph.setSelectionCells(remembered.map(([kind,id])=>kind==='node'?nodes.get(id):kind==='edge'?edges.get(id):boundaries.get(id)).filter(Boolean));
    if(!selectedSignature && graph.container.clientWidth>64 && graph.container.clientHeight>64){
      selectedSignature='fit';graph.minFitScale=0.1;graph.maxFitScale=2;graph.fit(30);
    }
  }
  const ready=new Promise((resolve,reject)=>{
    const receive=event=>{
      if(event.source!==frame.contentWindow||event.origin!==location.origin)return;
      if(event.data?.type==='archify-drawio-error'){window.removeEventListener('message',receive);reject(Error(event.data.message));}
      if(event.data?.type!=='archify-drawio-ready')return;
      window.removeEventListener('message',receive);api=frame.contentWindow.archifyDrawio;
      const {graph,ui}=api,w=frame.contentWindow;
      graph.setAllowDanglingEdges(false);
      graph.model.addListener(w.mxEvent.CHANGE,()=>{if(!suppress){graph.view.validate();changed();}});
      graph.getSelectionModel().addListener(w.mxEvent.CHANGE,()=>{
        if(suppress)return;
        const cells=graph.getSelectionCells();callbacks.select(cells.map(c=>({kind:c.archifyKind,id:c.archifyId})).filter(c=>c.kind));
      });
      for(const [name,fn]of [['undo',callbacks.undo],['redo',callbacks.redo],['save',callbacks.save]]){
        if(ui.actions.get(name))ui.actions.get(name).funct=fn;
      }
      // Boundary titles: VertexHandler places the movableLabel diamond at cell-center +
      // geometry.offset, which is far from a short title. After native redrawHandles,
      // move the yellow handle onto the measured text boundingBox center (glyph).
      const VH=w.mxVertexHandler;
      if(VH&&!VH.prototype._archifyBoundaryLabelHandle){
        VH.prototype._archifyBoundaryLabelHandle=true;
        const origRedrawHandles=VH.prototype.redrawHandles;
        VH.prototype.redrawHandles=function(){
          origRedrawHandles.apply(this,arguments);
          if(this.state?.cell?.archifyKind!=='boundary'||!this.labelShape)return;
          const bb=this.state.text?.boundingBox;
          if(!bb||!(bb.width>0)||!(bb.height>0))return;
          this.moveSizerTo(this.labelShape,bb.x+bb.width/2,bb.y+bb.height/2);
        };
      }
      // Native labels are plain text; Archify's source evidence is never HTML.
      resolve();
    };window.addEventListener('message',receive);
  });
  function invalidate(nextSpec){
    signature=undefined;
    // Text-only history keeps native cells and route anchors. Geometry history
    // still needs a fresh official scene and boundary-title snap on next load.
    if(!nextSpec||!imported||geometryKey(imported)!==geometryKey(nextSpec)){
      seeded=false;lastTitleSnap.clear();
    }
  }
  return {ready,load,invalidate,
    select(kind,id){if(!api)return;const c=kind==='node'?nodes.get(id):kind==='edge'?edges.get(id):boundaries.get(id);suppress=true;api.graph.setSelectionCell(c||null);suppress=false;},
    focus(id){if(api&&nodes.has(id))api.graph.scrollCellToVisible(nodes.get(id),true);},
    fit(){api?.graph.fit(30);},zoom(factor){if(api)api.graph.zoom(1/factor);},
    setEnabled(value){api?.graph.setEnabled(value);},
    unsupportedIssues(){
      if(!api||!imported)return [];
      const g=api.graph,issues=[];
      for(const [i,e]of (imported.connections||[]).entries()){
        const c=edges.get(e.id||'edge-'+i);if(!c)continue;const s=g.getCellStyle(c);
        if(s.curved==1)issues.push('曲线');
        if(s.endArrow!=='block'||s.startArrow&&s.startArrow!=='none')issues.push('自定义箭头');
        if(Number(s.fontSize)!==(e.font_sizes?.label??8*(imported.meta.font_scale??1))||s.fontColor!==(e.labelColor||'#526b83'))issues.push('原生文字样式（请使用 Archify 属性面板）');
        if(s.strokeColor!==(e.variant==='emphasis'?'#087e61':'#2679bd'))issues.push('原生线条颜色');
      }
      for(const [id,c]of nodes){const s=g.getCellStyle(c);if(Number(s.rotation||0)!==0)issues.push('旋转模块');}
      return [...new Set(issues)];
    },
    theme(value){api?.ui.setDarkMode(value==='dark');},
    previewFonts(category){
      for(const h of fontHighlights)h.destroy();fontHighlights=[];
      if(!api||!category||!imported)return;
      const w=frame.contentWindow,g=api.graph;
      const cells=category.startsWith('node-')?[...nodes].filter(([id])=>imported.components.find(n=>n.id===id)?.[category.slice(5)]).map(([,c])=>c)
        :category==='edge-label'?[...edges.values()].filter(c=>cellLabel(c))
        :category==='boundary-label'?[...boundaries.values()]:[];
      for(const c of cells){const state=g.view.getState(c);if(!state)continue;
        const h=new w.mxCellHighlight(g,'#d17a00',3);h.highlight(state);fontHighlights.push(h);}
    },
    panTo(x,y){if(!api)return;const g=api.graph,s=g.view.scale,tr=g.view.translate;
      g.container.scrollLeft=(x+tr.x)*s-g.container.clientWidth/2;
      g.container.scrollTop=(y+tr.y)*s-g.container.clientHeight/2;},
    get graph(){return api?.graph;},get ui(){return api?.ui;}};
}
