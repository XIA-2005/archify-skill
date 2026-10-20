import {loneAttachmentDefects, centerLoneAttachments} from '../draft/attachments.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {architectureDrafts} from '../draft/architecture.mjs';
import {extractSemantic, compareSemantics, semanticHash} from '../draft/semantic.mjs';
import {compactPoints, compareDrafts, qualityKey, repairRecommendations, readingMetrics} from '../draft/quality.mjs';
import {createQualitySession, advanceQualitySession, defectAction, recordReview} from '../draft/quality-session.mjs';
const load = file => JSON.parse(fs.readFileSync(new URL(file, import.meta.url)));
const semantic = () => load('../examples/intent/shared-layer.semantic.json');
const intent = () => load('../examples/intent/shared-layer.intent.json');

test('geometry extraction is explicit, owner-specific and fully logged, not a recursive filter', () => {
  const original = semantic();
  delete original.meta.font_scale; delete original.meta.quality_profile;
  original.components[0].pos = [7, 8]; original.components[0].size = [300, 90];
  original.connections[0].via = [[22, 23]];
  original.meta.viewBox = [1000, 800];
  original.cards = [{title: 'Keep conditions and coordinate-like words', items: ['via and route are content, not geometry']}];
  original.components[0].sources = [{path: 'src/a.c', start: 1, end: 8}];
  const frozen = structuredClone(original), extracted = extractSemantic(original);
  assert.deepEqual(original, frozen);
  assert.equal(extracted.removed.length, 4);
  assert.deepEqual(extracted.semantic.cards, original.cards);
  assert.deepEqual(extracted.semantic.components[0].sources, original.components[0].sources);
  assert.ok(extracted.removed.every(entry => entry.reason === 'independent-new-layout'));
  const candidate = structuredClone(extracted.semantic);
  candidate.meta.font_scale = 1.25; candidate.meta.quality_profile = 'showcase';
  candidate.components[0].pos = [100, 200]; candidate.components[0].size = [200, 100];
  const comparison = compareSemantics(extracted.semantic, candidate);
  assert.equal(comparison.equivalent, true); assert.equal(comparison.defaults.length, 2);
  for (const mutate of [c => c.connections.reverse(), c => c.connections[0].label = 'changed condition',
    c => c.components[0].sources[0].path = 'invented.c', c => c.boundaries[0].wraps.pop(),
    c => c.connections[0].variant = 'dashed', c => c.meta.font_scale = 0.5]) {
    const changed = structuredClone(candidate); mutate(changed);
    assert.equal(compareSemantics(extracted.semantic, changed).equivalent, false);
  }
});

test('structural alternatives change placement, not only spacing, and preserve band order and source bytes', () => {
  const source = semantic(), plan = intent(), frozen = structuredClone(source);
  const drafts = architectureDrafts(source, {intent: plan});
  assert.deepEqual(source, frozen);
  assert.deepEqual(drafts, architectureDrafts(source, {intent: plan}));
  const sameSpacing = drafts.filter(d => d.id.endsWith('-100'));
  assert.equal(new Set(sameSpacing.map(d => JSON.stringify(d.candidate.components.map(n => n.pos)))).size >= 2, true);
  assert.equal(new Set(drafts.map(d => d.structure)).size, 3);
  for (const draft of drafts) {
    assert.equal(compareSemantics(source, draft.candidate).equivalent, true);
    const nodes = new Map(draft.candidate.components.map(n => [n.id, n]));
    for (const band of plan.bands) for (let i = 1; i < band.length; i++) assert.ok(nodes.get(band[i]).pos[0] > nodes.get(band[i - 1]).pos[0]);
    assert.ok(draft.candidate.connections.every(e => !e.via && !e.labelAt));
  }
});

test('ordinary fanout remains a compact hub unless a shared layer was actually declared', () => {
  const source = {schema_version: 1, diagram_type: 'architecture', meta: {title: 'Hub', output: 'hub.html'},
    components: ['hub', 'a', 'b', 'c'].map(id => ({id, type: 'backend', label: id})),
    connections: ['a', 'b', 'c'].map(to => ({from: 'hub', to}))};
  const plan = {schemaVersion: 1, question: 'A hub serves peers', bands: [['hub'], ['a', 'b', 'c']], mainPath: ['hub', 'b']};
  for (const {candidate} of architectureDrafts(source, {intent: plan})) {
    const node = candidate.components[0];
    assert.ok(node.size[0] < candidate.components.slice(1).reduce((n, c) => n + c.size[0], 0));
    assert.equal(compareSemantics(source, candidate).equivalent, true);
  }
});

test('collinear route points do not count as turns and reverse segments are retained', () => {
  assert.deepEqual(compactPoints([[0, 0], [0, 0], [1, 0], [2, 0], [2, 1], [2, 3]]), [[0, 0], [2, 0], [2, 3]]);
  assert.deepEqual(compactPoints([[0, 0], [3, 0], [1, 0]]), [[0, 0], [3, 0], [1, 0]]);
});

test('lexicographic ranking cannot buy counterflow or a crossing with a lower weighted score', () => {
  const metric = {counterflowCorridors: [], crossings: 0, edgeCount: 1, desktopText: [{projectedPx: 9}],
    width: 100, height: 100, routeLength: 100, estimatedDiagramHeightPx: 100,
    reading: {mainBacktracks: 0, shared: [], mainBends: 0, rowDrift: 0, bendsPerEdge: 0}};
  const entry = (id, patch = {}) => ({id, attempt: {metrics: {...metric, ...patch}}});
  assert.ok(compareDrafts(entry('valid', {score: 999999}), entry('crossed', {score: 0, crossings: 1})) < 0);
  assert.ok(compareDrafts(entry('long', {routeLength: 9000}), entry('ambiguous', {counterflowCorridors: [{}]})) < 0);
  assert.ok(compareDrafts(entry('a'), entry('b')) < 0);
  assert.deepEqual(qualityKey(metric), qualityKey(structuredClone(metric)));
});

test('shared crowding signals group reflow, while structural drift is diagnostic rather than a failure', () => {
  const result = repairRecommendations({reading: {rowDrift: 0.3, shared: [{node: 'driver', outputs: 4, bentOutputs: 3, bends: 8}]}});
  assert.equal(result[0].action, 'reflow-connected-group');
  assert.equal(result[1].action, 'compare-structural-candidate');
  assert.equal(defectAction([{kind: 'label'}]), 'repair-local-label');
  assert.equal(defectAction([{kind: 'route'}]), 'repair-local-route');
  assert.equal(defectAction([{kind: 'repair-conflict'}]), 'reflow-connected-group');
});
const submission = (state, id, decision = 'rework', replaceBest = false) => ({expectedRevision: state.revision,
  candidateSha256: id, artifactSha256: `${id}-html`, delivery: `${id}.json`, technicalPassed: true,
  semanticEquivalent: true, review: {reviewer: 'test reviewer', decision, replaceBest, comparison: 'Compared actual images; retain or improve the best.',
    defects: decision === 'accept' ? [] : [{kind: 'composition', subjects: ['driver'], description: 'Shared fanout needs a clearer arrangement.'}]}});

test('one request has initial review plus two repairs; regenerated IDs cannot reset the budget', () => {
  let state = createQualitySession(semantic(), intent(), 'one-request');
  state = advanceQualitySession(state, submission(state, 'initial', 'rework', true));
  assert.equal(state.repairsUsed, 0); assert.equal(state.best.candidateSha256, 'initial');
  state = advanceQualitySession(state, submission(state, 'rebuilt-1', 'reject'));
  assert.equal(state.repairsUsed, 1); assert.equal(state.best.candidateSha256, 'initial');
  state = advanceQualitySession(state, submission(state, 'another-structure', 'rework'));
  assert.equal(state.repairsUsed, 2); assert.equal(state.status, 'visual-failed');
  assert.equal(state.best.candidateSha256, 'initial');
  assert.equal(state.history.length, 3);
  assert.throws(() => advanceQualitySession(state, submission(state, 'reset-attempt')), /sealed/);
});

test('hard failures, stale reviews, duplicate bytes and semantic corrections cannot change best state', () => {
  const state = createQualitySession(semantic(), intent());
  const frozen = structuredClone(state);
  for (const patch of [{technicalPassed: false}, {semanticEquivalent: false}, {expectedRevision: 0}]) {
    assert.throws(() => advanceQualitySession(state, {...submission(state, 'bad'), ...patch}));
  }
  assert.deepEqual(state, frozen);
  const next = advanceQualitySession(state, submission(state, 'once'));
  assert.throws(() => advanceQualitySession(next, submission(next, 'once')), /Unchanged/);
  const bad = submission(state, 'semantic'); bad.review.defects[0].kind = 'semantic';
  assert.throws(() => advanceQualitySession(state, bad), /Semantic corrections/);
});

test('accepted review seals the best version; no automatic claim is written into machine receipts', () => {
  const state = createQualitySession(semantic(), intent());
  assert.throws(() => advanceQualitySession(state, submission(state, 'not-best', 'accept')), /best/);
  const next = advanceQualitySession(state, submission(state, 'good', 'accept', true));
  assert.equal(next.status, 'accepted'); assert.equal(next.best.candidateSha256, 'good');
  assert.equal(next.nextAction, 'deliver-best');
  assert.equal(next.visualAcceptance, undefined);
  assert.throws(() => advanceQualitySession(next, submission(next, 'later')), /sealed/);
});

test('draft-only centered attachment repair counts incoming and outgoing sides together', () => {
  const candidate={components:[{id:'a',pos:[0,0],size:[100,80]},{id:'b',pos:[200,0],size:[100,100]}],connections:[{from:'a',to:'b'}]};
  const layout={connections:[{from:'a',to:'b',points:[[100,40],[200,40]]}]};
  const defects=loneAttachmentDefects(candidate,layout);
  assert.equal(defects.length,1);assert.equal(defects[0].node,'b');
  centerLoneAttachments(candidate,defects);
  assert.deepEqual(candidate.connections[0].toPort,[0,0.5]);
  assert.equal(candidate.connections[0].toSide,'left');
  const centered={connections:[{from:'a',to:'b',points:[[100,40],[150,40],[150,50],[200,50]]}]};
  assert.deepEqual(loneAttachmentDefects(candidate,centered),[]);
});
test('delivery relocation is explicit and never silently ignores output or other metadata', () => {
  const source=semantic(),candidate=structuredClone(source);candidate.meta.output='separate/round1.html';
  assert.equal(compareSemantics(source,candidate).equivalent,false);
  const comparison=compareSemantics(source,candidate,{outputPath:'separate/round1.html'});
  assert.equal(comparison.equivalent,true);assert.equal(comparison.deliveryRelocations.length,1);
  candidate.meta.title='Changed meaning';
  assert.equal(compareSemantics(source,candidate,{outputPath:'separate/round1.html'}).equivalent,false);
});

test('a technically valid fallback remains available even if all three image reviews fail', () => {
  let state=createQualitySession(semantic(),intent());
  for(const id of ['initial-with-defects','first-repair','last-repair']){
    const item=submission(state,id,'reject');item.review.defects[0].unacceptable=true;
    state=advanceQualitySession(state,item);
    assert.equal(state.best,null);
    assert.equal(state.bestValid.candidateSha256,'initial-with-defects');
  }
  assert.equal(state.status,'visual-failed');
  assert.equal(state.repairsUsed,2);
  assert.equal(state.nextAction,'return-best-with-explicit-visual-failure');
});
