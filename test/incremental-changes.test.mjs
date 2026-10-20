import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {applyContentChanges} from '../incremental/changes.mjs';
import {extractSemantic} from '../draft/semantic.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const semantic = candidate => extractSemantic(candidate).semantic;
const evidence = ['reviewed source: src/controller.c:10-20'];
const baseline = () => ({schema_version: 1, diagram_type: 'architecture',
  meta: {title: 'Controller', output: 'diagram.html', viewBox: [1000, 650],
    font_scale: 1.2, repository: {url: 'https://example.org/project', revision: 'a'.repeat(40)}},
  components: [
    {id: 'controller', type: 'backend', label: 'Controller', sublabel: 'Runs when enabled',
      pos: [70, 100], size: [220, 100], font_sizes: {label: 12},
      sources: [{path: 'src/controller.c', line: 10, end_line: 20}]},
    {id: 'motor', type: 'external', label: 'Motor', pos: [420, 100], size: [170, 100]},
  ],
  boundaries: [{kind: 'region', label: 'Firmware', wraps: ['controller'], bounds: [40, 60, 300, 200]}],
  connections: [{id: 'control', from: 'controller', to: 'motor', label: 'if enabled',
    labelColor: '#123456', width: 2, fromSide: 'right', toSide: 'left', via: [[330, 150]], labelAt: [355, 120]}],
  cards: [{dot: 'cyan', title: 'Details', items: ['A verified implementation note.']}],
});
function transaction(original, operations, expectedSemantic, options = {}) {
  const bytes = Buffer.from(JSON.stringify(original, null, 2) + '\n');
  return applyContentChanges(original,
    {schemaVersion: 1, baselineSha256: digest(bytes), operations},
    {baselineBytes: bytes, expectedSemantic, ...options});
}
const hasCode = code => error => error.code === `incremental/${code}`;
const componentUpdate = (original, set, unset) => ({op: 'update', target: 'component', id: 'controller',
  before: semantic(original).components[0], set, ...(unset ? {unset} : {}), evidence});

test('no-op preserves full candidate, geometry, styles, array order and independent clones', () => {
  const original = baseline(), before = structuredClone(original);
  const result = transaction(original, [], semantic(original));
  assert.deepEqual(result.candidate, before);
  assert.deepEqual(original, before);
  assert.equal(result.baselineBinding, 'verified-raw-bytes');
  assert.equal(result.changes.length, 0);
  result.candidate.components[0].pos[0] += 1;
  assert.deepEqual(original, before);
});

test('long label and behavior condition update keep stable identity, routes and non-geometric style', () => {
  const original = baseline(), next = semantic(original);
  next.components[0].label = 'A much longer controller label with the full condition';
  next.connections[0].label = 'if enabled and temperature < threshold';
  const result = transaction(original, [componentUpdate(original, {label: next.components[0].label}),
    {op: 'update', target: 'connection', id: 'control', before: semantic(original).connections[0],
      set: {label: next.connections[0].label}, evidence}], next);
  assert.deepEqual(result.candidate.components[0].pos, original.components[0].pos);
  assert.deepEqual(result.candidate.connections[0].via, original.connections[0].via);
  assert.equal(result.candidate.connections[0].labelColor, '#123456');
  assert.equal(result.candidate.connections[0].width, 2);
  assert.equal(result.candidate.components[0].id, 'controller');
  assert.deepEqual(result.semantic, next);
});

test('addition appends stable nodes and relationships while preserving old order', () => {
  const original = baseline(), next = semantic(original);
  const node = {id: 'audit', type: 'database', label: 'Audit log'};
  const edge = {id: 'audit_write', from: 'controller', to: 'audit', label: 'after success'};
  next.components.push(node); next.connections.push(edge);
  const result = transaction(original, [
    {op: 'add', target: 'component', value: node, evidence},
    {op: 'add', target: 'connection', value: edge, evidence},
  ], next);
  assert.deepEqual(result.candidate.components.map(item => item.id), ['controller', 'motor', 'audit']);
  assert.deepEqual(result.candidate.components[1], original.components[1]);
  assert.equal(Object.hasOwn(result.candidate.components[2], 'pos'), false);
});

test('approved component and relationship removals apply together atomically', () => {
  const original = baseline(), next = semantic(original);
  next.components.splice(1, 1); next.connections = [];
  const result = transaction(original, [
    {op: 'remove', target: 'component', id: 'motor', before: semantic(original).components[1], evidence},
    {op: 'remove', target: 'connection', id: 'control', before: semantic(original).connections[0], evidence},
  ], next);
  assert.equal(result.candidate.components.length, 1);
  assert.deepEqual(result.candidate.connections, []);
  assert.equal(original.components.length, 2);
});

test('boundary rename has explicit old selector mapping and preserves its exact frame', () => {
  const original = baseline(), next = semantic(original);
  next.boundaries[0].label = 'Embedded control'; next.boundaries[0].wraps.push('motor');
  const result = transaction(original, [{op: 'update', target: 'boundary',
    selector: {kind: 'region', label: 'Firmware'}, before: semantic(original).boundaries[0],
    set: {label: 'Embedded control', wraps: ['controller', 'motor']}, evidence}], next);
  assert.deepEqual(result.boundaryMappings, [{from: {kind: 'region', label: 'Firmware'},
    to: {kind: 'region', label: 'Embedded control'}}]);
  assert.deepEqual(result.candidate.boundaries[0].bounds, original.boundaries[0].bounds);
});

test('source revision, line changes and cards have explicit content transactions', () => {
  const original = baseline(), next = semantic(original);
  next.meta.repository.revision = 'b'.repeat(40);
  next.components[0].sources[0].line = 15;
  next.cards[0].items.push('Additional reviewed note.');
  const result = transaction(original, [
    {op: 'update', target: 'meta', before: semantic(original).meta, set: {repository: next.meta.repository}, evidence},
    componentUpdate(original, {sources: next.components[0].sources}),
    {op: 'update', target: 'cards', before: original.cards, value: next.cards, evidence},
  ], next);
  assert.deepEqual(result.semantic, next);
  assert.deepEqual(result.candidate.meta.viewBox, original.meta.viewBox);
  assert.deepEqual(result.candidate.components[0].pos, original.components[0].pos);
});

test('optional cards may be added and explicitly removed without equating absent and empty arrays', () => {
  const original = baseline(); delete original.cards;
  const next = semantic(original); next.cards = [{dot: 'slate', title: 'Fact', items: []}];
  const added = transaction(original, [{op: 'update', target: 'cards', before: null, value: next.cards, evidence}], next);
  const removed = transaction(added.candidate, [{op: 'update', target: 'cards', before: next.cards, value: null, evidence}], semantic(original));
  assert.equal(Object.hasOwn(removed.candidate, 'cards'), false);
  assert.throws(() => transaction(original, [], {...semantic(original), cards: []}), hasCode('semantic-mismatch'));
});

test('output relocation needs an explicit reviewed update and exact S1', () => {
  const original = baseline(), next = semantic(original); next.meta.output = 'review/new-diagram.html';
  assert.throws(() => transaction(original, [], next), hasCode('semantic-mismatch'));
  const result = transaction(original, [{op: 'update', target: 'meta', before: semantic(original).meta,
    set: {output: next.meta.output}, evidence}], next);
  assert.equal(result.candidate.meta.output, 'review/new-diagram.html');
});

test('raw byte binding rejects stale baseline, caller hash mismatch and mismatching parsed candidate', () => {
  const original = baseline(), expectedSemantic = semantic(original), bytes = JSON.stringify(original);
  assert.throws(() => applyContentChanges(original, {schemaVersion: 1, baselineSha256: '0'.repeat(64), operations: []},
    {baselineBytes: bytes, expectedSemantic}), hasCode('stale-baseline'));
  assert.throws(() => transaction(original, [], expectedSemantic, {baselineSha256: '0'.repeat(64)}), hasCode('baseline-hash-mismatch'));
  const edited = structuredClone(original); edited.components[0].label = 'Unbound edit';
  assert.throws(() => applyContentChanges(edited, {schemaVersion: 1, baselineSha256: digest(bytes), operations: []},
    {baselineBytes: bytes, expectedSemantic}), hasCode('baseline-object-mismatch'));
});

test('caller supplied raw SHA is explicit when bytes are unavailable; S1 and hash remain mandatory', () => {
  const original = baseline(), expectedSemantic = semantic(original), baselineSha256 = digest(JSON.stringify(original));
  const proposal = {schemaVersion: 1, baselineSha256, operations: []};
  const result = applyContentChanges(original, proposal, {baselineSha256, expectedSemantic});
  assert.equal(result.baselineBinding, 'caller-supplied-raw-sha256');
  assert.throws(() => applyContentChanges(original, proposal, {baselineSha256}), hasCode('missing-expected-semantic'));
  assert.throws(() => applyContentChanges(original, proposal, {expectedSemantic}), hasCode('missing-baseline-hash'));
});

test('full before value is checked even when the updated field still matches', () => {
  const original = baseline(), next = semantic(original); next.components[0].label = 'New label';
  const operation = componentUpdate(original, {label: 'New label'});
  operation.before.sublabel = 'Incorrect stale behavior';
  assert.throws(() => transaction(original, [operation], next), hasCode('old-value-mismatch'));
});

test('no unexpected condition loss, source deletion, style change or array reordering is hidden', () => {
  const original = baseline(), next = semantic(original);
  for (const mutate of [
    value => delete value.connections[0].label,
    value => delete value.components[0].sources,
    value => value.connections[0].labelColor = '#eeeeee',
    value => value.components.reverse(),
  ]) {
    const differentS1 = structuredClone(next); mutate(differentS1);
    assert.throws(() => transaction(original, [], differentS1), hasCode('semantic-mismatch'));
  }
});

test('content operations reject all authored geometry and stable ID replacement', () => {
  const original = baseline(), next = semantic(original);
  for (const field of ['pos', 'size', 'row', 'col']) {
    assert.throws(() => transaction(original, [componentUpdate(original, {[field]: [1, 2]})], next), hasCode('geometry-in-content'));
  }
  assert.throws(() => transaction(original, [componentUpdate(original, {}, ['pos'])], next), hasCode('geometry-in-content'));
  assert.throws(() => transaction(original, [componentUpdate(original, {id: 'replacement'})], next), hasCode('identity-change'));
  assert.throws(() => transaction(original, [{op: 'add', target: 'component', value: {id: 'new', type: 'backend', label: 'New', pos: [1, 2]}, evidence}], next), hasCode('geometry-in-content'));
  assert.throws(() => transaction(original, [{op: 'update', target: 'connection', id: 'control',
    before: next.connections[0], set: {labelAt: [1, 2]}, evidence}], next), hasCode('geometry-in-content'));
  assert.throws(() => transaction(original, [], original), hasCode('expected-has-geometry'));
});

test('unknown proposal keys, operation keys, candidate fields and malformed unset are rejected', () => {
  const original = baseline(), next = semantic(original), bytes = JSON.stringify(original);
  assert.throws(() => applyContentChanges(original, {schemaVersion: 1, baselineSha256: digest(bytes), operations: [], ignored: true},
    {baselineBytes: bytes, expectedSemantic: next}), hasCode('unknown-field'));
  assert.throws(() => transaction(original, [{...componentUpdate(original, {label: 'new'}), silent: true}], next), hasCode('unknown-field'));
  assert.throws(() => transaction(original, [componentUpdate(original, {unknown: 'field'})], next), error =>
    error.archifyDiagnostics?.some(item => item.code === 'schema/additionalProperties'));
  assert.throws(() => transaction(original, [componentUpdate(original, {}, ['sublabel', 'sublabel'])], next), hasCode('invalid-proposal'));
  assert.throws(() => transaction(original, [componentUpdate(original, {sublabel: 'new'}, ['sublabel'])], next), hasCode('invalid-proposal'));
  assert.throws(() => transaction(original, [{...componentUpdate(original, {}), set: null}], next), hasCode('invalid-proposal'));
  assert.throws(() => transaction(original, [{...componentUpdate(original, {}), unset: null}], next), hasCode('invalid-proposal'));
});

test('removal needs evidence and explicit S1 absence, never cascades silently', () => {
  const original = baseline(), next = semantic(original);
  const removal = {op: 'remove', target: 'component', id: 'motor', before: next.components[1], evidence};
  assert.throws(() => transaction(original, [removal], next), hasCode('unsupported-deletion'));
  assert.throws(() => transaction(original, [{...removal, evidence: []}], next), hasCode('unsupported-change'));
  const missingNodeS1 = semantic(original); missingNodeS1.components.pop();
  assert.throws(() => transaction(original, [removal], missingNodeS1), hasCode('dangling-reference'));
});

test('duplicate and dangling IDs in baseline or S1 cannot pass schema-only validation', () => {
  for (const mutate of [
    value => value.components.push(structuredClone(value.components[0])),
    value => value.connections.push(structuredClone(value.connections[0])),
    value => value.boundaries.push(structuredClone(value.boundaries[0])),
  ]) {
    const original = baseline(); mutate(original);
    assert.throws(() => transaction(original, [], semantic(original)), hasCode('duplicate-id'));
  }
  const original = baseline(), next = semantic(original);
  next.connections[0].to = 'missing';
  assert.throws(() => transaction(original, [], next), hasCode('dangling-reference'));
  const missingMember = semantic(original); missingMember.boundaries[0].wraps.push('missing');
  assert.throws(() => transaction(original, [], missingMember), hasCode('dangling-reference'));
});

test('legacy edges without IDs are preserved but endpoint or array index guessing is refused', () => {
  const original = baseline(); delete original.connections[0].id;
  const next = semantic(original);
  assert.deepEqual(transaction(original, [], next).candidate, original);
  assert.throws(() => transaction(original, [{op: 'update', target: 'connection', id: 'controller->motor',
    before: next.connections[0], set: {label: 'New'}, evidence}], next), hasCode('missing-target'));
  assert.throws(() => transaction(original, [{op: 'update', target: 'connection', index: 0,
    before: next.connections[0], set: {label: 'New'}, evidence}], next), hasCode('unknown-field'));
});

test('later failure preserves baseline, proposal and approved S1 without partial application', () => {
  const original = baseline(), next = semantic(original); next.components[0].label = 'First valid change';
  const operations = [componentUpdate(original, {label: next.components[0].label}),
    {op: 'update', target: 'component', id: 'missing', before: {}, set: {label: 'Invalid'}, evidence}];
  const snapshot = structuredClone({original, next, operations});
  assert.throws(() => transaction(original, operations, next), hasCode('missing-target'));
  assert.deepEqual({original, next, operations}, snapshot);
});

test('repeated exact input is deterministic and invalid non-JSON values are refused', () => {
  const original = baseline(), next = semantic(original); next.components[0].label = 'Changed';
  const operations = [componentUpdate(original, {label: 'Changed'})];
  assert.deepEqual(transaction(original, operations, next), transaction(original, operations, next));
  const invalid = componentUpdate(original, {label: undefined});
  assert.throws(() => transaction(original, [invalid], next), hasCode('non-json'));
  const nonFinite = componentUpdate(original, {font_sizes: {label: NaN}});
  assert.throws(() => transaction(original, [nonFinite], next), hasCode('non-json'));
});

test('semantic mismatch exposes concrete old and expected field values for investigation', () => {
  const original = baseline(), next = semantic(original);
  next.components[0].sublabel = 'Runs only after a verified release';
  assert.throws(() => transaction(original, [], next), error => {
    assert.equal(error.code, 'incremental/semantic-mismatch');
    const differences = error.archifyDiagnostics[0].evidence.differences;
    assert.deepEqual(differences, [{path: '/components/0/sublabel',
      expected: {present: true, value: next.components[0].sublabel},
      actual: {present: true, value: original.components[0].sublabel}}]);
    return true;
  });
});

test('successive boundary renames fold original identity into a single final mapping', () => {
  const original = baseline(), next = semantic(original); next.boundaries[0].label = 'Final';
  const middle = {...semantic(original).boundaries[0], label: 'Middle'};
  const result = transaction(original, [
    {op: 'update', target: 'boundary', selector: {kind: 'region', label: 'Firmware'},
      before: semantic(original).boundaries[0], set: {label: 'Middle'}, evidence},
    {op: 'update', target: 'boundary', selector: {kind: 'region', label: 'Middle'},
      before: middle, set: {label: 'Final'}, evidence},
  ], next);
  assert.deepEqual(result.boundaryMappings, [{from: {kind: 'region', label: 'Firmware'}, to: {kind: 'region', label: 'Final'}}]);
  assert.deepEqual(result.candidate.boundaries[0].bounds, original.boundaries[0].bounds);
});

test('boundary removal and addition preserve constrained frame and label offset across identity changes', () => {
  for (const label of ['Firmware', 'Replacement']) {
    const original = baseline(); original.boundaries[0].labelOffset = [20, 5]; original.boundaries[0].pad = 42;
    const next = semantic(original); next.boundaries[0].label = label;
    const result = transaction(original, [
      {op: 'remove', target: 'boundary', selector: {kind: 'region', label: 'Firmware'}, before: semantic(original).boundaries[0], evidence},
      {op: 'add', target: 'boundary', value: next.boundaries[0], evidence},
    ], next);
    assert.deepEqual(result.candidate.boundaries[0].bounds, original.boundaries[0].bounds);
    assert.deepEqual(result.candidate.boundaries[0].labelOffset, [20, 5]);
    assert.equal(result.candidate.boundaries[0].pad, 42);
    assert.equal(result.geometryTransfers[0].from.label, 'Firmware');
    assert.equal(result.geometryTransfers[0].to.label, label);
    assert.equal(result.boundaryMappings.length, label === 'Firmware' ? 0 : 1);
  }
});

test('constraint inheritance also protects add-before-remove and a changed member set', () => {
  const original = baseline(), next = semantic(original);
  next.boundaries[0] = {kind: 'region', label: 'New owner', wraps: ['controller', 'motor']};
  const result = transaction(original, [
    {op: 'add', target: 'boundary', value: next.boundaries[0], evidence},
    {op: 'remove', target: 'boundary', selector: {kind: 'region', label: 'Firmware'}, before: semantic(original).boundaries[0], evidence},
  ], next);
  assert.deepEqual(result.candidate.boundaries[0].bounds, original.boundaries[0].bounds);
  assert.equal(result.geometryTransfers[0].reason, 'overlapping-boundary-members');
});

test('ambiguous boundary merge or split refuses to discard or duplicate authored geometry', () => {
  const original = baseline();
  original.boundaries.push({kind: 'region', label: 'Device', wraps: ['motor'], bounds: [400, 60, 250, 200]});
  const next = semantic(original); next.boundaries = [{kind: 'region', label: 'Merged', wraps: ['controller', 'motor']}];
  const removals = semantic(original).boundaries.map(before => ({op: 'remove', target: 'boundary',
    selector: {kind: before.kind, label: before.label}, before, evidence}));
  assert.throws(() => transaction(original, [...removals, {op: 'add', target: 'boundary', value: next.boundaries[0], evidence}], next),
    hasCode('ambiguous-boundary-replacement'));

  const split = baseline(); split.boundaries[0].wraps.push('motor');
  const splitNext = semantic(split); splitNext.boundaries = [
    {kind: 'region', label: 'Control', wraps: ['controller']},
    {kind: 'region', label: 'Device', wraps: ['motor']},
  ];
  assert.throws(() => transaction(split, [
    {op: 'remove', target: 'boundary', selector: {kind: 'region', label: 'Firmware'}, before: semantic(split).boundaries[0], evidence},
    ...splitNext.boundaries.map(value => ({op: 'add', target: 'boundary', value, evidence})),
  ], splitNext), hasCode('ambiguous-boundary-replacement'));
});

test('genuinely disjoint new boundary need not inherit a deleted frame', () => {
  const original = baseline(), next = semantic(original);
  next.boundaries[0] = {kind: 'region', label: 'Device', wraps: ['motor']};
  const result = transaction(original, [
    {op: 'remove', target: 'boundary', selector: {kind: 'region', label: 'Firmware'}, before: semantic(original).boundaries[0], evidence},
    {op: 'add', target: 'boundary', value: next.boundaries[0], evidence},
  ], next);
  assert.equal(Object.hasOwn(result.candidate.boundaries[0], 'bounds'), false);
  assert.deepEqual(result.geometryTransfers, []);
});
