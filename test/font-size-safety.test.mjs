import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import {assertFontFields, assertFontSizes} from '../renderers/shared/font-size.mjs';
import {renderCards, applyTemplate} from '../renderers/shared/utils.mjs';
import {renderLegend} from '../renderers/shared/legend.mjs';
import {startEditor} from './editor-test-helpers.mjs';

const common=JSON.parse(fs.readFileSync(new URL('../schemas/common.schema.json',import.meta.url),'utf8'));
const ajv=new Ajv2020({strict:false});ajv.addSchema(common);
const schema=ajv.compile({$ref:common.$id+'#/$defs/fontSizes'});
const invalid=['12','6e0','1e309','12px','',{},[],null,true,NaN,Infinity,-Infinity,5.5,72.5,12.25];
const valid=[6,6.5,13,13.5,71.5,72,JSON.parse('6e0')];
const card=sizes=>[{dot:'cyan',title:'中文 <title>',items:['中文 <item>'],font_sizes:sizes}];

test('font acceptance matches the CLI schema without coercion',()=>{
  for(const key of ['label','sublabel','tag','title','subtitle','legend_title','items']){
    for(const value of [...invalid,...valid]){
      const sizes={[key]:key==='items'?[value]:value};
      const accepted=schema(sizes);
      if(accepted)assert.doesNotThrow(()=>assertFontSizes(sizes));
      else assert.throws(()=>assertFontSizes(sizes),{code:'INVALID_FONT_SIZE'});
    }
  }
  for(const sizes of [null,[],12,'12',{items:'12'},{items:null},{unknown:12}]){
    assert.equal(schema(sizes),false);assert.throws(()=>assertFontSizes(sizes));
  }
  assert.doesNotThrow(()=>assertFontFields({cards:card({items:[null,6,72]})}));
  assert.doesNotThrow(()=>assertFontSizes({}));
});

test('shared HTML card, heading and legend output reject invalid explicit sizes',()=>{
  const template='<html lang="en" data-theme="light" data-preset="[VISUAL PRESET]">'+
    '<title>[PROJECT NAME] Architecture Diagram</title><h1>[PROJECT NAME] Architecture</h1>\n'+
    '<p class="subtitle">[Subtitle description]</p>\n'+
    '      <!-- ARCHIFY:SVG_SLOT_START --><!-- ARCHIFY:SVG_SLOT_END -->\n'+
    '    <!-- ARCHIFY:CARDS_SLOT_START --><!-- ARCHIFY:CARDS_SLOT_END -->\n'+
    '    <!-- ARCHIFY:I18N_DATA -->';
  for(const size of invalid){
    assert.throws(()=>renderCards(card({title:size})),{code:'INVALID_FONT_SIZE'});
    if(size!==null)assert.throws(()=>renderCards(card({items:[size]})),{code:'INVALID_FONT_SIZE'});
    for(const key of ['title','subtitle'])assert.throws(()=>applyTemplate(template,{title:'Title',subtitle:'Subtitle',svg:'',cards:'',fontSizes:{[key]:size}}),{code:'INVALID_FONT_SIZE'});
    assert.throws(()=>renderLegend({entries:[{kind:'backend',label:'Backend',font_size:size}],layout:{},renderSwatch:()=>''}),{code:'INVALID_FONT_SIZE'});
    assert.throws(()=>renderLegend({entries:[],layout:{titleFontSize:size},renderSwatch:()=>''}),{code:'INVALID_FONT_SIZE'});
  }
  assert.match(renderCards(card({title:6,items:[72,null]})),/font-size:6px/);
  assert.match(renderCards(card({items:[null]})),/&lt;item&gt;/);
  assert.doesNotThrow(()=>renderCards([{title:'Default',items:['Default']}]));
});

test('editor API rejects invalid font fields while allowing repairable drafts',async t=>{
  const source={schema_version:1,diagram_type:'architecture',meta:{title:'Draft',output:'diagram.html'},components:[{id:'a',type:'backend',label:'A',pos:[100,100]}]};
  const {base,input}=await startEditor(t,source);
  for(const sizes of invalid.map(title=>({title})).concat([{items:['6e0']},{items:[{}]},{items:[[]]}])){
    const next=structuredClone(source);next.cards=card(sizes);
    fs.writeFileSync(input,JSON.stringify(next));
    assert.equal((await fetch(base+'api/spec')).status,422);
    for(const endpoint of ['routes','image-preview','save']){
      const response=await fetch(base+'api/'+endpoint,{method:'POST',headers:{Origin:new URL(base).origin,'X-Archify-Editor':'1','Content-Type':'application/json'},
        body:JSON.stringify(endpoint==='save'?{candidate:next,expectedHash:createHash('sha256').update(fs.readFileSync(input)).digest('hex')}:next)});
      assert.equal(response.status,422);
    }
  }
  const overflow=JSON.stringify({...source,cards:card({title:12})}).replace('"title":12','"title":1e309');
  fs.writeFileSync(input,overflow);assert.equal((await fetch(base+'api/spec')).status,422);
  source.cards=card({title:6,items:[72,null]});
  // No full geometry/composition gate at the editor read boundary.
  source.components[0].pos=[-100,-100];
  fs.writeFileSync(input,JSON.stringify(source));
  assert.equal((await fetch(base+'api/spec')).status,200);
});
