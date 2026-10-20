import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {architectureDrafts} from '../draft/architecture.mjs';
import {validateArchitectureIntent} from '../draft/intent.mjs';
import {validateSchema} from '../renderers/shared/validator.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'bin/archify.mjs');
const read = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const fixture = () => ({
  semantic: read('examples/intent/shared-layer.semantic.json'),
  intent: read('examples/intent/shared-layer.intent.json'),
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hasCode = code => error => Boolean(error.archifyDiagnostics?.some(diagnostic => diagnostic.code === code));
const center = node => node.pos[0] + node.size[0] / 2;

function semanticOnly(candidate, source) {
  const restored = structuredClone(candidate);
  if (source.meta.font_scale === undefined) delete restored.meta.font_scale;
  if (source.meta.quality_profile === undefined) delete restored.meta.quality_profile;
  for (const node of restored.components) { delete node.pos; delete node.size; }
  for (const edge of restored.connections || []) {
    for (const field of ['fromSide', 'toSide', 'fromPort', 'toPort']) delete edge[field];
  }
  return restored;
}

function workspace(t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'archify-intent-')));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true, maxRetries: 3, retryDelay: 100}));
  return directory;
}

function run(args, cwd, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 4_000_000,
    env: {...process.env, ARCHIFY_UPDATE_CHECK_DISABLED: '1'},
  });
  assert.ifError(result.error);
  assert.equal(result.status, expectedStatus, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

function writeInputs(directory, semantic, intent) {
  const source = path.join(directory, 'semantic 输入.json');
  const plan = path.join(directory, 'intent 意图.json');
  fs.writeFileSync(source, JSON.stringify(semantic));
  fs.writeFileSync(plan, JSON.stringify(intent));
  return {source, plan};
}

test('intent drafts are deterministic, strict-schema candidates and preserve every semantic fact', () => {
  const {semantic, intent} = fixture();
  const before = structuredClone({semantic, intent});
  const proposals = architectureDrafts(semantic, {intent});
  assert.equal(proposals.length, 9);
  assert.deepEqual(proposals, architectureDrafts(semantic, {intent}));
  assert.deepEqual({semantic, intent}, before);
  for (const {candidate, intent: accepted} of proposals) {
    validateSchema('architecture', candidate);
    assert.deepEqual(semanticOnly(candidate, semantic), semantic);
    assert.equal(accepted.question, intent.question);
    assert.ok(candidate.components.every(node => node.pos.every(Number.isFinite) && node.size.every(n => n > 0)));
    assert.ok(candidate.connections.every(edge => edge.via === undefined && edge.labelAt === undefined));
  }
});

test('main spine aligns across bands, branches stay adjacent and shared outputs get exact vertical ports', () => {
  const {semantic, intent} = fixture();
  for (const {candidate} of architectureDrafts(semantic, {intent}).filter(p => p.structure === 'spine')) {
    const nodes = new Map(candidate.components.map(node => [node.id, node]));
    assert.equal(center(nodes.get('dispatcher')), center(nodes.get('worker')));
    assert.ok(nodes.get('calculator').pos[0] + nodes.get('calculator').size[0] < nodes.get('worker').pos[0]);
    assert.ok(nodes.get('coordinator').pos[0] > nodes.get('worker').pos[0] + nodes.get('worker').size[0]);
    const layer = nodes.get('driver');
    assert.ok(layer.size[0] > nodes.get('worker').size[0] * 2);
    for (const id of intent.sharedLayers[0].targets) {
      const target = nodes.get(id), edge = candidate.connections.find(edge => edge.from === 'driver' && edge.to === id);
      assert.ok(layer.pos[0] <= target.pos[0] && layer.pos[0] + layer.size[0] >= target.pos[0] + target.size[0]);
      assert.equal(edge.fromSide, 'bottom'); assert.equal(edge.toSide, 'top');
      assert.deepEqual(edge.toPort, [0.5, 0]);
      assert.ok(Math.abs(layer.pos[0] + layer.size[0] * edge.fromPort[0] - center(target)) < 1e-7);
    }
    const feedback = candidate.connections.find(edge => edge.id === 'reply');
    assert.equal(feedback.fromSide, 'top'); assert.equal(feedback.toSide, 'top');
    assert.equal(feedback.variant, 'dashed');
  }
});

test('explicit typography survives; a singleton and a folded main path remain expressible', () => {
  const {semantic, intent} = fixture();
  semantic.meta.font_scale = 1.1;
  semantic.components[0].font_sizes = {label: 16, sublabel: 11};
  for (const {candidate} of architectureDrafts(semantic, {intent})) {
    assert.deepEqual(semanticOnly(candidate, semantic), semantic);
  }
  const singleton = {schema_version: 1, diagram_type: 'architecture', meta: {title: 'Single', output: 'single.html'}, components: [{id: 'only', type: 'backend', label: 'Only'}]};
  assert.equal(architectureDrafts(singleton, {intent: {schemaVersion: 1, question: 'One responsibility', bands: [['only']], mainPath: ['only']}}).length, 9);
  const folded = {schema_version: 1, diagram_type: 'architecture', meta: {title: 'Fold', output: 'fold.html'}, components: ['a', 'b', 'c', 'd'].map(id => ({id, type: 'backend', label: id})), connections: [{from: 'a', to: 'b'}, {from: 'b', to: 'c'}, {from: 'c', to: 'd'}]};
  const plan = {schemaVersion: 1, question: 'Follow a folded chain', bands: [['a', 'b'], ['d', 'c']], mainPath: ['a', 'b', 'c', 'd']};
  const nodes = new Map(architectureDrafts(folded, {intent: plan})[0].candidate.components.map(node => [node.id, node]));
  assert.equal(center(nodes.get('b')), center(nodes.get('c')));
  assert.ok(nodes.get('d').pos[0] < nodes.get('c').pos[0]);
});

const invalidIntents = [
  ['question', 'draft/intent-question', ({intent}) => { intent.question = ' '; }],
  ['version', 'draft/intent-version', ({intent}) => { intent.schemaVersion = 2; }],
  ['pixel geometry', 'draft/intent-field', ({intent}) => { intent.pos = [0, 0]; }],
  ['nested pixel geometry', 'draft/intent-field', ({intent}) => { intent.branches[0].offset = 50; }],
  ['missing node', 'draft/intent-coverage', ({intent}) => { intent.bands[0].pop(); }],
  ['duplicate node', 'draft/intent-coverage', ({intent}) => { intent.bands[0].push('worker'); }],
  ['unknown node', 'draft/intent-node', ({intent}) => { intent.bands[0][0] = 'unknown'; }],
  ['invented main edge', 'draft/intent-main-path', ({intent}) => { intent.mainPath = ['client', 'driver']; }],
  ['main-path reversal', 'draft/intent-main-path', ({intent}) => { intent.mainPath = ['dispatcher', 'client', 'receiver']; }],
  ['unrelated branch', 'draft/intent-branch', ({intent}) => { intent.branches[0].anchor = 'receiver'; }],
  ['branch cycle', 'draft/intent-branch', ({semantic, intent}) => { semantic.connections.push({from: 'calculator', to: 'coordinator'}); intent.branches = [{node: 'calculator', anchor: 'coordinator'}, {node: 'coordinator', anchor: 'calculator'}]; }],
  ['shared layer not isolated', 'draft/intent-shared-layer', ({intent}) => { intent.bands[1].shift(); intent.bands[2].push('calculator'); }],
  ['shared targets in wrong band', 'draft/intent-shared-layer', ({intent}) => { intent.sharedLayers[0].targets = ['worker']; }],
  ['missing shared edge', 'draft/intent-relationship', ({semantic}) => { semantic.connections = semantic.connections.filter(edge => edge.id !== 'device-a'); }],
  ['noncontiguous shared targets', 'draft/intent-shared-layer', ({intent}) => { intent.sharedLayers[0].targets = ['deviceA', 'deviceC']; }],
  ['unknown feedback corridor', 'draft/intent-feedback', ({intent}) => { intent.feedbackEdges[0].corridor = 'diagonal'; }],
  ['undeclared main-path return', 'draft/intent-feedback', ({intent}) => { intent.feedbackEdges = []; }],
];
for (const [name, code, mutate] of invalidIntents) test(`intent rejects ${name} without changing source data`, () => {
  const input = fixture(); mutate(input);
  const before = structuredClone(input);
  assert.throws(() => architectureDrafts(input.semantic, {intent: input.intent}), hasCode(code));
  assert.deepEqual(input, before);
});

test('conflicting cross-band alignments fail rather than overlapping or silently ignoring intent', () => {
  const semantic = {schema_version: 1, diagram_type: 'architecture', meta: {title: 'Conflict', output: 'conflict.html'}, components: ['a', 'b', 'c', 'd'].map(id => ({id, type: 'backend', label: id})), connections: [{from: 'a', to: 'd'}, {from: 'b', to: 'c'}]};
  const intent = {schemaVersion: 1, question: 'Conflicting alignments', bands: [['a', 'b'], ['c', 'd']], mainPath: ['a', 'd'], branches: [{node: 'b', anchor: 'c'}]};
  validateArchitectureIntent(semantic, intent);
  const drafts = architectureDrafts(semantic, {intent});
  assert.ok(drafts.rejected.some(probe => probe.structure === 'spine'));
  assert.ok(drafts.every(proposal => proposal.structure !== 'spine'));
  assert.deepEqual(drafts[0].intent.bands, intent.bands);
});

test('legacy options remain usable and supplied geometry is never reinterpreted as semantic intent', () => {
  const {semantic, intent} = fixture();
  assert.ok(architectureDrafts(semantic).length > 0);
  assert.throws(() => architectureDrafts(semantic, {intent, composition: 'layered'}), hasCode('draft/intent-options'));
  semantic.components[0].pos = [30, 40];
  assert.throws(() => architectureDrafts(semantic, {intent}), hasCode('draft/fixed-geometry'));
  assert.deepEqual(semantic.components[0].pos, [30, 40]);
});

test('public CLI binds the accepted intent, preserves source bytes and passes canonical artifact checks', {timeout: 120000}, t => {
  const directory = workspace(t), {semantic, intent} = fixture();
  const {source, plan} = writeInputs(directory, semantic, intent);
  const sourceBefore = fs.readFileSync(source), intentBefore = fs.readFileSync(plan);
  const output = path.join(directory, 'candidate.json');
  const receipt = run(['draft', 'architecture', source, output, '--intent', plan, '--json'], directory);
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.intent.contract, 'archify-architecture-intent-v1');
  assert.equal(receipt.intent.sha256, digest(intentBefore));
  assert.equal(receipt.inputSha256, digest(sourceBefore));
  assert.deepEqual(receipt.intent.plan, validateArchitectureIntent(semantic, intent));
  assert.equal(receipt.candidate.sha256, digest(fs.readFileSync(output)));
  assert.ok(receipt.attempts.length > 0 && receipt.attempts.length <= 9);
  assert.ok(receipt.attempts.find(attempt => attempt.id === receipt.selected)?.artifactPassed);
  const candidate = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(semanticOnly(candidate, semantic), semantic);
  const verified = run(['validate', 'architecture', output, '--json', '--quality', 'showcase'], directory);
  assert.equal(verified.ok, true);
  const layout = run(['validate', 'architecture', output, '--layout-json', '--quality', 'showcase'], directory);
  assert.equal(layout.ok, true);
  const fanout = layout.connections.filter(edge => edge.from === 'driver');
  assert.equal(fanout.length, 3);
  for (const edge of fanout) {
    assert.ok(edge.points.every(point => Math.abs(point[0] - edge.points[0][0]) < 1e-6), JSON.stringify(edge));
  }
  const repeated = path.join(directory, 'candidate-repeat.json');
  run(['draft', 'architecture', source, repeated, '--intent', plan, '--json'], directory);
  assert.deepEqual(fs.readFileSync(repeated), fs.readFileSync(output));
  const preserved = fs.readFileSync(output);
  const refused = run(['draft', 'architecture', source, output, '--intent', plan, '--json'], directory, 1);
  assert.equal(refused.diagnostics[0].code, 'draft/output-exists');
  assert.deepEqual(fs.readFileSync(output), preserved);
  assert.deepEqual(fs.readFileSync(source), sourceBefore);
  assert.deepEqual(fs.readFileSync(plan), intentBefore);
  assert.equal(receipt.visualReview, 'not-requested');
});

test('CLI rejects incompatible options, invalid intent and fixed source geometry without publishing', {timeout: 60000}, t => {
  const directory = workspace(t), {semantic, intent} = fixture();
  const {source, plan} = writeInputs(directory, semantic, intent);
  const output = path.join(directory, 'must-not-exist.json');
  const conflict = run(['draft', 'architecture', source, output, '--intent', plan, '--composition', 'flow', '--json'], directory, 2);
  assert.equal(conflict.ok, false);
  assert.ok(conflict.diagnostics.some(diagnostic => diagnostic.code === 'cli/conflicting-options'));
  fs.writeFileSync(plan, '{invalid');
  const invalidJson = run(['draft', 'architecture', source, output, '--intent', plan, '--json'], directory, 1);
  assert.ok(invalidJson.diagnostics.some(diagnostic => diagnostic.code === 'draft/intent-input'));
  fs.writeFileSync(plan, JSON.stringify({...intent, mainPath: ['client', 'driver']}));
  const invalidGraph = run(['draft', 'architecture', source, output, '--intent', plan, '--json'], directory, 1);
  assert.ok(invalidGraph.diagnostics.some(diagnostic => diagnostic.code === 'draft/intent-main-path'));
  semantic.components[0].pos = [10, 20];
  fs.writeFileSync(source, JSON.stringify(semantic));
  fs.writeFileSync(plan, JSON.stringify(intent));
  const fixed = run(['draft', 'architecture', source, output, '--intent', plan, '--json'], directory, 1);
  assert.ok(fixed.diagnostics.some(diagnostic => diagnostic.code === 'draft/fixed-geometry'));
  assert.equal(fs.existsSync(output), false);
});
