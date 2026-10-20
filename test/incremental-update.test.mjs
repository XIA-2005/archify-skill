import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {getIncrementalFixtures, buildFixtureProposal} from '../scripts/incremental-fixtures.mjs';
import {updateArchitecture} from '../incremental/command.mjs';
import {geometryPermissions, incrementalCandidate, updateImpact, assertFixedGeometry, geometryDifference} from '../incremental/layout.mjs';
import {extractSemantic, compareSemantics} from '../draft/semantic.mjs';
import {createQualitySession, advanceQualitySession, recordReview} from '../draft/quality-session.mjs';
import {semanticHash} from '../draft/semantic.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-incremental-'));
  t.after(() => {
    const absolute = path.resolve(dir), parent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(absolute).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(absolute).startsWith('archify-incremental-'));
    fs.rmSync(absolute, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
  });
  return dir;
}
function inputs(dir, id) {
  const fixture = getIncrementalFixtures().find(item => item.id === id);
  const bytes = Buffer.from(JSON.stringify(fixture.baseline, null, 2) + '\n');
  const proposal = buildFixtureProposal(fixture, digest(bytes));
  const policy = {...fixture.geometryPolicy, baselineSha256: digest(bytes)};
  for (const [name, value] of Object.entries({baseline: fixture.baseline, proposal, approved: fixture.expectedSemantic, policy})) fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(value, null, 2) + '\n');
  return {fixture, bytes, proposal, policy, args: ['baseline', 'proposal', 'approved', 'candidate'].map(name => path.join(dir, name + '.json'))};
}
for (const id of ['no-op', 'text-condition', 'add-branch', 'shared-consumer', 'boundary-move']) test(`real update preserves approved facts and justified geometry: ${id}`, {timeout: 90000}, async t => {
  const dir = scratch(t), {fixture, args} = inputs(dir, id);
  const result = await updateArchitecture(...args, {geometryPolicyPath: path.join(dir, 'policy.json'), mainPath: fixture.mainPath});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const candidate = JSON.parse(fs.readFileSync(args[3]));
  assert.equal(compareSemantics(fixture.expectedSemantic, candidate).equivalent, true);
  assert.equal(result.geometryDifference.unexplained.length, 0);
  assert.equal(result.visualAcceptance, 'human-required');
  if (['no-op', 'add-branch'].includes(id)) {
    assert.deepEqual(result.geometryDifference.nodes, [], 'no-op and a separate branch must not move established nodes');
    if (id !== 'text-condition') assert.deepEqual(result.geometryDifference.connections, [], 'no-op/branch must preserve actual old routes and labels');
  }
  if (id === 'text-condition') {
    assert.deepEqual(result.geometryDifference.nodes.map(node => node.id), ['worker', 'shared', 'storeA', 'storeB']);
    const edge = result.geometryDifference.connections.find(edge => edge.id === 'dispatch-worker');
    assert.equal(edge.after.points.length, 2, 'long condition retains a direct main-path connection');
    assert.ok(result.attempts[0].ledger.some(item => item.kind === 'changed-label-channel'));
  }
  if (id === 'add-branch') {
    assert.equal(candidate.components.find(node => node.id === 'audit').size[1], candidate.components.find(node => node.id === 'worker').size[1]);
  }
  const repeat = await updateArchitecture(...args.slice(0, 3), path.join(dir, 'repeat.json'), {geometryPolicyPath: path.join(dir, 'policy.json'), mainPath: fixture.mainPath});
  assert.equal(repeat.ok, true); assert.deepEqual(fs.readFileSync(args[3]), fs.readFileSync(path.join(dir, 'repeat.json')));
  const outputAgain = await updateArchitecture(...args, {geometryPolicyPath: path.join(dir, 'policy.json')});
  assert.equal(outputAgain.ok, false); assert.equal(outputAgain.diagnostics[0].code, 'update/output-exists');
  assert.deepEqual(JSON.parse(fs.readFileSync(args[0])), fixture.baseline);
});

test('stale proposal, wrong oracle and fixed long text fail without publishing or mutating baseline', async t => {
  const dir = scratch(t), {fixture, args, proposal} = inputs(dir, 'long-label');
  const baseline = fs.readFileSync(args[0]);
  const policyPath = path.join(dir, 'policy.json');
  fs.writeFileSync(args[1], JSON.stringify({...proposal, baselineSha256: '0'.repeat(64)}));
  let result = await updateArchitecture(...args, {geometryPolicyPath: policyPath});
  assert.equal(result.ok, false); assert.equal(result.diagnostics[0].code, 'incremental/stale-baseline');
  fs.writeFileSync(args[1], JSON.stringify(proposal));
  fs.writeFileSync(args[2], JSON.stringify(extractSemantic(fixture.baseline).semantic));
  result = await updateArchitecture(...args, {geometryPolicyPath: policyPath});
  assert.equal(result.ok, false); assert.equal(result.diagnostics[0].code, 'incremental/semantic-mismatch');
  fs.writeFileSync(args[2], JSON.stringify(fixture.expectedSemantic));
  result = await updateArchitecture(...args); // unknown old geometry remains fixed
  assert.equal(result.ok, false); assert.equal(result.diagnostics[0].code, 'update/fixed-text-size');
  assert.equal(fs.existsSync(args[3]), false); assert.deepEqual(fs.readFileSync(args[0]), baseline);
});

test('valid grid no-op does not materialize coordinates or default sizes', () => {
  const baseline = {schema_version: 1, diagram_type: 'architecture', meta: {title: 'Grid', output: 'grid.html'},
    layout: {mode: 'grid', cols: 1}, components: [{id: 'a', type: 'backend', label: 'A', row: 0, col: 0}]};
  const semantic = extractSemantic(baseline).semantic, permission = geometryPermissions(baseline);
  const result = incrementalCandidate(baseline, baseline, {permission, impact: updateImpact(baseline, semantic)});
  assert.deepEqual(result.candidate, baseline); assert.equal(assertFixedGeometry(baseline, result.candidate, permission), true);
});

test('source-only revisions preserve small valid authored sizes', () => {
  const baseline = {schema_version: 1, diagram_type: 'architecture', meta: {title: 'Source', output: 'source.html'},
    components: [{id: 'a', type: 'backend', label: 'A', pos: [40, 80], size: [100, 60], sources: [{path: 'src/a.c', line: 10}]}]};
  const updated = structuredClone(baseline); updated.components[0].sources[0].line = 11;
  const impact = updateImpact(baseline, extractSemantic(updated).semantic);
  assert.deepEqual(impact.geometryRelevantNodes, []);
  const permission = geometryPermissions(baseline);
  const result = incrementalCandidate(baseline, updated, {permission, impact});
  assert.deepEqual(result.candidate.components[0].size, [100, 60]);
  assert.deepEqual(result.candidate.components[0].pos, [40, 80]);
  assert.equal(assertFixedGeometry(baseline, result.candidate, permission), true);
});

test('no-op preserves canonical-valid legacy off-center ports instead of self-justifying a repair', async t => {
  const dir = scratch(t), {fixture, args} = inputs(dir, 'no-op');
  fixture.baseline.connections[0].fromPort = [1, 0.25]; fixture.baseline.connections[0].toPort = [0, 0.25];
  const bytes = Buffer.from(JSON.stringify(fixture.baseline));
  fs.writeFileSync(args[0], bytes); fs.writeFileSync(args[1], JSON.stringify({schemaVersion: 1, baselineSha256: digest(bytes), operations: []}));
  fs.writeFileSync(args[2], JSON.stringify(extractSemantic(fixture.baseline).semantic));
  const result = await updateArchitecture(...args);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.repairsUsed, 0); assert.deepEqual(JSON.parse(fs.readFileSync(args[3])), fixture.baseline);
  assert.deepEqual(result.geometryDifference.connections, []);
});

test('parallel data/control relationships do not turn an ordinary node into a wide shared layer', () => {
  const baseline = {schema_version: 1, diagram_type: 'architecture', meta: {title: 'Parallel', output: 'parallel.html'},
    components: [{id: 'a', type: 'backend', label: 'A', pos: [180, 100], size: [240, 90]}, {id: 'b', type: 'backend', label: 'B', pos: [180, 340], size: [240, 90]}],
    connections: [{id: 'data', from: 'a', to: 'b'}, {id: 'control', from: 'a', to: 'b', variant: 'dashed'}]};
  const updated = structuredClone(baseline); updated.components[0].label = 'Updated';
  const permission = geometryPermissions(baseline, {schemaVersion: 1, baselineSha256: 'a'.repeat(64), origin: 'test-generated',
    generated: {components: ['a', 'b'], connections: ['data', 'control']}}, 'a'.repeat(64));
  const result = incrementalCandidate(baseline, updated, {permission, impact: updateImpact(baseline, extractSemantic(updated).semantic)});
  for (const node of result.candidate.components) assert.deepEqual(node.pos, baseline.components.find(old => old.id === node.id).pos);
  assert.deepEqual(result.candidate.components[0].size, [240, 90]);
});

test('boundary rename mapping preserves unknown frame coordinates and title offsets', () => {
  const baseline = getIncrementalFixtures()[0].baseline;
  Object.assign(baseline.boundaries[0], {bounds: [300, 40, 740, 380], labelOffset: [18, 3]});
  const updated = structuredClone(baseline); updated.boundaries[0].label = 'Application';
  const mappings = [{from: {kind: 'region', label: 'Service'}, to: {kind: 'region', label: 'Application'}}];
  const permission = geometryPermissions(baseline, undefined, undefined, mappings);
  const result = incrementalCandidate(baseline, updated, {permission, impact: updateImpact(baseline, extractSemantic(updated).semantic)});
  assert.deepEqual(result.candidate.boundaries[0].bounds, baseline.boundaries[0].bounds);
  assert.deepEqual(result.candidate.boundaries[0].labelOffset, [18, 3]);
  assert.equal(assertFixedGeometry(baseline, result.candidate, permission), true);
  result.candidate.boundaries[0].bounds[0]++;
  assert.throws(() => assertFixedGeometry(baseline, result.candidate, permission), error => error.code === 'update/fixed-geometry');
});

test('legacy relationship index shifts are ambiguous, never silently equal', () => {
  const baseline = {connections: [{id: 'removed', from: 'a', to: 'b'}, {from: 'c', to: 'd'}]};
  const candidate = {connections: [{from: 'c', to: 'd'}]};
  assert.throws(() => geometryDifference(baseline, candidate, {components: [], connections: []}, {components: [], connections: []}, {relatedNodes: []}),
    error => error.code === 'update/ambiguous-relationship-identity');
});

test('preparation and visual repairs share two rounds and cannot be reset by review', () => {
  const semantic = extractSemantic(getIncrementalFixtures()[0].baseline).semantic;
  const state = createQualitySession(semantic, {}, 'same-request', 2);
  const next = advanceQualitySession(state, {expectedRevision: 1, technicalPassed: true, semanticEquivalent: true,
    candidateSha256: 'candidate', artifactSha256: 'artifact', delivery: 'delivery.json',
    review: {decision: 'rework', reviewer: 'test reviewer', defects: [{kind: 'composition', subjects: ['shared'], description: 'Still crowded', unacceptable: true}]}});
  assert.equal(next.repairsUsed, 2); assert.equal(next.status, 'visual-failed');
  assert.throws(() => advanceQualitySession(next, {}), /sealed/);
  assert.throws(() => createQualitySession(semantic, {}, 'same-request', 3), /two-repair budget/);
});

test('CLI rejects unknown update options before doing any work', t => {
  const dir = scratch(t);
  const result = spawnSync(process.execPath, [path.join(root, 'bin/archify.mjs'), 'update', 'architecture', '--not-an-option', '--json'],
    {cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 20000});
  assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /Unknown update option/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('visual repair cannot move a user-pinned node after a prepared update', async t => {
  const dir = scratch(t), {fixture, args, policy} = inputs(dir, 'no-op');
  policy.fixed = {components: [{id: 'worker', fields: ['pos']}]};
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(policy));
  const prepared = await updateArchitecture(...args, {geometryPolicyPath: path.join(dir, 'policy.json')});
  assert.equal(prepared.ok, true);
  const planFile = path.join(dir, 'update.json'), stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(planFile, JSON.stringify(prepared));
  const init = spawnSync(process.execPath, [path.join(root, 'draft/quality-session.mjs'), 'init-update', stateFile, args[2], planFile],
    {encoding: 'utf8', windowsHide: true, timeout: 20000});
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const reset = spawnSync(process.execPath, [path.join(root, 'draft/quality-session.mjs'), 'init-update', path.join(dir, 'reset-state.json'), args[2], planFile],
    {encoding: 'utf8', windowsHide: true, timeout: 20000});
  assert.notEqual(reset.status, 0); assert.match(reset.stderr + reset.stdout, /already bound/);
  assert.equal(fs.existsSync(path.join(dir, 'reset-state.json')), false);
  const state = JSON.parse(fs.readFileSync(stateFile));
  assert.equal(state.geometryConstraintsSha256, semanticHash(state.geometryConstraints));
  const changed = JSON.parse(fs.readFileSync(args[3])); changed.components.find(node => node.id === 'worker').pos[0] += 40;
  fs.writeFileSync(args[3], JSON.stringify(changed));
  const html = path.join(dir, 'diagram.html'); fs.writeFileSync(html, '<html>mock artifact for isolated constraint check</html>');
  const images = ['light', 'dark'].map(theme => {const image = path.join(dir, theme + '.png'); fs.writeFileSync(image, 'mock image binding');
    return {path: image, sha256: digest(fs.readFileSync(image)), width: 1440, height: 900, theme};});
  // Mock receipts isolate this negative state transition; no visual success is claimed.
  const deliveryFile = path.join(dir, 'delivery.json'), reviewFile = path.join(dir, 'review.json');
  const candidateSha256 = digest(fs.readFileSync(args[3])), artifactSha256 = digest(fs.readFileSync(html));
  fs.writeFileSync(deliveryFile, JSON.stringify({ok: true, gates: {validate: 'pass', deliver: 'pass', check: 'pass', 'browser-check': 'pass'},
    source: args[3], specification: {sha256: candidateSha256}, artifact: {path: html, sha256: artifactSha256}, screenshots: images}));
  fs.writeFileSync(reviewFile, JSON.stringify({expectedRevision: 1, candidateSha256, artifactSha256, images,
    reviewer: 'test fixture', decision: 'accept', replaceBest: true, comparison: 'mock comparison', defects: []}));
  assert.throws(() => recordReview(state, deliveryFile, reviewFile), error => error.code === 'update/fixed-geometry');
  assert.equal(state.history.length, 0);
});
