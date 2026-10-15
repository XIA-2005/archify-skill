#!/usr/bin/env node
import { createSessionFiles, sessionError } from './session-files.mjs';
// Separate text/form editor for workflow, sequence, dataflow and lifecycle.
// Does not change canonical renderers, route solvers, or the Architecture editor.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fs.realpathSync.native(process.cwd());
const editorDir = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(editorDir, '../bin/archify.mjs');
const supported = new Set(['workflow', 'sequence', 'dataflow', 'lifecycle']);
const candidateArg = process.argv[2];
if (!candidateArg || process.argv.includes('--help')) {
  console.log('Usage: node editor/serve-schema.mjs <candidate.json> (run from project root)');
  process.exit(candidateArg ? 0 : 1);
}
const extra = process.argv.slice(3);
if(extra.length && (extra.length !== 2 || extra[0] !== '--repo-root')) throw new Error('Expected --repo-root <directory>');
const repoRoot = extra.length ? fs.realpathSync.native(path.resolve(extra[1])) : root;
const inside = (p) => p === root || p.startsWith(root + path.sep);
const input = fs.realpathSync.native(path.resolve(root, candidateArg));
if (!inside(input) || !fs.statSync(input).isFile()) {
  throw new Error('Candidate path must be a regular file inside the selected project');
}
const sessionFiles = createSessionFiles(root, [input]);
const source = JSON.parse(sessionFiles.read(input, 'utf8'));
if (!supported.has(source.diagram_type)) {
  throw new Error('Expected a project-local workflow/sequence/dataflow/lifecycle candidate');
}
const output = path.resolve(root, source.meta?.output || '');
const outputParent = fs.realpathSync.native(path.dirname(output));
if (!inside(output) || !inside(outputParent) || !output.toLowerCase().endsWith('.html')
  || (fs.existsSync(output) && !inside(fs.realpathSync.native(output)))) {
  throw new Error('Invalid or out-of-project meta.output');
}
sessionFiles.bind(output);
sessionFiles.assert();
const type = source.diagram_type;
const version = source.schema_version;
const outputName = source.meta.output;
const repositoryIdentity = JSON.stringify(source.meta.repository);
const token = randomBytes(20).toString('hex');
const digest = (v) => createHash('sha256').update(v).digest('hex');
const stamp = () => new Date().toISOString().replace(/\W/g, '').slice(0, 14) + randomBytes(4).toString('hex');
const previewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-schema-preview-'));
const previewFile = path.join(previewDir, 'preview.html');
const previewFiles = createSessionFiles(previewDir, [previewFile]);
let previewHTML = null;
let saving = false;

function answer(res, code, payload, mime='application/json; charset=utf-8') {
  res.writeHead(code, {'Content-Type':mime,'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
    'Cross-Origin-Resource-Policy':'same-origin'});
  res.end(mime.startsWith('application/json') ? JSON.stringify(payload) : payload);
}
const run = (args) => {
  sessionFiles.assert();
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd:root, encoding:'utf8', timeout:120000, maxBuffer:8_000_000, windowsHide:true,
  });
  sessionFiles.assert();
  let parsed = {};
  try { parsed = JSON.parse(r.stdout?.trim() || '{}'); } catch {}
  return {ok:r.status === 0 && (!args.includes('--json') || parsed.ok === true),
    detail:parsed, error:parsed.diagnostics?.map(x=>x.message).slice(0,4).join('; ')
      || r.error?.message || r.stderr?.slice(-900) || 'CLI rejected this candidate'};
};
const flags = (quality) => ['--quality', quality === 'standard' ? 'standard':'showcase',
  ...(source.meta.repository ? ['--repo-root', repoRoot] : [])];
const sameMeta = (c) => c && c.diagram_type === type && c.schema_version === version
  && c.meta?.output === outputName
  && JSON.stringify(c.meta?.repository) === repositoryIdentity;

async function body(req) {
  const parts=[];let length=0;
  for await(const p of req) { length+=p.length;if(length>2_000_000)throw new Error('Max 2 MB request');parts.push(p); }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

async function preview(req,res) {
  try {
    const data = await body(req);
    if(!sameMeta(data.candidate)) return answer(res,400,{ok:false,message:'Type, version, output or repository changed'});
    const temp = path.join(previewDir,'candidate.json');
    sessionFiles.assert();
    previewFiles.assert();
    fs.writeFileSync(temp, JSON.stringify(data.candidate,null,2)+'\n');
    const quality = data.candidate.meta?.quality_profile;
    const result = run(['render',type,temp,previewFile,...flags(quality)]);
    if(!result.ok) return answer(res,422,{ok:false,message:result.error});
    previewHTML = previewFiles.read(previewFile,'utf8');
    answer(res,200,{ok:true,message:'Canonical renderer preview (not a finalized artifact)'});
  } catch(e) { const failure=sessionError(e,422); answer(res,failure.status,failure.body); }
}
async function save(req,res) {
  if(saving) return answer(res,423,{ok:false,message:'Save already in progress'});
  saving=true;
  let temp;
  try {
    const data=await body(req);
    if(!sameMeta(data.candidate)) return answer(res,400,{ok:false,message:'Protected metadata changed'});
    const bytes=sessionFiles.read(input);
    if(digest(bytes)!==data.expectedHash) return answer(res,409,{ok:false,message:'Candidate changed outside editor; reload before saving'});
    temp=path.join(path.dirname(input),`candidate.schema-edit-${stamp()}.json`);
    sessionFiles.assert();
    fs.writeFileSync(temp,JSON.stringify(data.candidate,null,2)+'\n',{flag:'wx'});
    const quality=data.candidate.meta?.quality_profile;
    const check=run(['validate',type,temp,...flags(quality),'--json']);
    if(!check.ok) return answer(res,422,{ok:false,message:check.error});
    if(digest(sessionFiles.read(input))!==data.expectedHash) return answer(res,409,{ok:false,message:'Candidate changed during validation'});
    const backup=path.join(path.dirname(input),`candidate.schema-backup-${stamp()}.json`);
    sessionFiles.assert();
    fs.writeFileSync(backup,bytes,{flag:'wx'});
    sessionFiles.assert();
    fs.renameSync(temp,input);temp=null;
    const latestHash=digest(sessionFiles.read(input));
    const evidence=path.join(path.dirname(input),`schema-editor-review-${stamp()}`);
    const final=run(['finalize',type,input,output,...flags(quality),'--out-dir',evidence,'--json']);
    if(!final.ok) return answer(res,500,{ok:false,saved:true,expectedHash:latestHash,backup,
      message:'Saved candidate but finalized HTML failed: '+final.error});
    answer(res,200,{ok:true,expectedHash:latestHash,backup,message:'Candidate and official HTML validated and saved'});
  } catch(e) {const failure=sessionError(e);answer(res,failure.status,failure.body);}
  finally {if(temp)try{sessionFiles.assert();fs.unlinkSync(temp);}catch{} saving=false;}
}
const page = fs.readFileSync(path.join(editorDir,'schema-editor.html'),'utf8');
const server = http.createServer((req,res)=>{
  const route=req.url?.split('?')[0];const base=`/${token}`;
  const host=`127.0.0.1:${server.address().port}`;
  if(req.headers.host!==host || !(route===base || route?.startsWith(base+'/')))
    return answer(res,404,{ok:false,message:'Not found'});
  if(req.method==='GET'&&(route===base || route===base+'/'))
    return answer(res,200,page,'text/html; charset=utf-8');
  if(req.method==='GET'&&route===base+'/api/spec'){
    try {const bytes=sessionFiles.read(input),candidate=JSON.parse(bytes);
      if(!sameMeta(candidate))return answer(res,422,{ok:false,message:'Candidate structure or protected metadata changed'});
      return answer(res,200,{candidate,expectedHash:digest(bytes),target:output});}
    catch(error){const failure=sessionError(error,error.code==='ENOENT'?404:error instanceof SyntaxError?422:500);return answer(res,failure.status,failure.body);}
  }
  if(req.method==='GET'&&route===base+'/preview'&&previewHTML)
    { res.setHeader('Content-Security-Policy','sandbox allow-scripts');
      return answer(res,200,previewHTML,'text/html; charset=utf-8'); }
  if(req.method==='GET'&&route===base+'/original') {
    try { return answer(res,200,sessionFiles.read(output),'text/html; charset=utf-8'); }
    catch(error) { const failure=sessionError(error); return answer(res,failure.status,failure.body); }
  }
  if(req.method==='POST'&&['/api/preview','/api/save'].some(p=>route===base+p)){
    if(req.headers.origin!==`http://${host}` || req.headers['x-archify-editor']!=='1'
      || !req.headers['content-type']?.startsWith('application/json'))
      return answer(res,403,{ok:false,message:'Forbidden origin'});
    return route===base+'/api/preview' ? void preview(req,res) : void save(req,res);
  }
  answer(res,404,{ok:false,message:'Not found'});
});
server.listen(0,'127.0.0.1',()=>console.log(`Archify ${type} schema editor (localhost only):\nhttp://127.0.0.1:${server.address().port}/${token}/\nCandidate: ${input}`));
function cleanup(){try{previewFiles.assert();fs.rmSync(previewDir,{recursive:true,force:true});}catch{}}
process.on('exit',cleanup);
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
