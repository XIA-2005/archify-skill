// Controlled update experiments, NOT a change to any real firmware/project.
// These small executable sources and their independent expected results are
// frozen before a model is called. They are fixtures, not a source extractor.
import {createHash} from 'node:crypto';
import {extractSemantic, semanticHash, stableJSON} from '../draft/semantic.mjs';

const clone = value => structuredClone(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const SOURCE_PATH = id => `src/${id}.mjs`;
const display = {
  input: {label: 'Gateway', sublabel: 'Submit task', type: 'frontend', owner: 'Client'},
  dispatch: {label: 'Dispatch', sublabel: 'Check readiness', type: 'backend', owner: 'Service'},
  worker: {label: 'Worker', sublabel: 'Process task', type: 'backend', owner: 'Service'},
  shared: {label: 'Shared writer', sublabel: 'Persist result', type: 'backend', owner: 'Service'},
  storeA: {label: 'Store A', sublabel: 'Primary copy', type: 'database', owner: 'Storage'},
  storeB: {label: 'Store B', sublabel: 'Backup copy', type: 'database', owner: 'Storage'},
};
const bodies = {
  input: ['return io.dispatch(task, io);'],
  dispatch: ['if (task.ready) return io.worker(task, io);'],
  worker: ['io.shared(task, io);', 'return task;'],
  shared: ['io.storeA(task, io);', 'io.storeB(task, io);'],
  storeA: ['return task;'],
  storeB: ['return task;'],
};
const edge = (id, from, to, label) => ({id, from, to, ...(label ? {label} : {})});
const baseEdges = [
  edge('input-dispatch', 'input', 'dispatch'),
  edge('dispatch-worker', 'dispatch', 'worker', 'ready'),
  edge('worker-shared', 'worker', 'shared', 'result'),
  edge('shared-storeA', 'shared', 'storeA'),
  edge('shared-storeB', 'shared', 'storeB'),
];
const sourceFile = (id, description, statements) => {
  const content = [
    '// CONTROLLED EXPERIMENT: module-level contract, not real project firmware.',
    `export const description = ${JSON.stringify(description)};`,
    `export function ${id}(task, io) {`,
    `  io.trace('${id}');`,
    ...statements.map(statement => `  ${statement}`),
    '}', '',
  ].join('\n');
  return {path: SOURCE_PATH(id), content, sha256: sha256(content)};
};
const packet = (revision, descriptions, code) => ({
  revision,
  origin: 'controlled-executable-fixture',
  files: Object.keys(descriptions).map(id => sourceFile(id, descriptions[id], code[id])),
});
const sourceRefs = file => [{path: file.path, line: 2, end_line: file.content.trimEnd().split('\n').length}];
const semantics = (descriptions, connections, source) => ({
  schema_version: 1, diagram_type: 'architecture',
  meta: {title: 'Task pipeline · control fixture', output: 'diagram.html', quality_profile: 'showcase', font_scale: 1.25},
  // The fixture has no real remote repository. Keep local source references in
  // the fact ledger rather than invent /meta/repository for clickable links.
  components: Object.entries(descriptions).map(([id, item]) => ({id, type: item.type,
    label: item.label, sublabel: item.sublabel})),
  boundaries: [...new Set(Object.values(descriptions).map(item => item.owner))]
    .filter(owner => owner !== 'Client')
    .map(label => ({kind: 'region', label,
      wraps: Object.entries(descriptions).filter(([, item]) => item.owner === label).map(([id]) => id)})),
  connections: clone(connections),
});
const geometry = {
  input: [[40, 80], [200, 80]], dispatch: [[340, 80], [200, 80]],
  worker: [[640, 80], [200, 80]], shared: [[480, 300], [520, 80]],
  storeA: [[480, 520], [200, 80]], storeB: [[800, 520], [200, 80]],
};
function baselineCandidate() {
  const source = packet('control-v1', display, bodies);
  const candidate = semantics(display, baseEdges, source);
  for (const component of candidate.components) {
    [component.pos, component.size] = clone(geometry[component.id]);
  }
  for (const connection of candidate.connections) {
    if (['input-dispatch', 'dispatch-worker'].includes(connection.id)) {
      Object.assign(connection, {fromSide: 'right', toSide: 'left', route: 'straight'});
    } else {
      Object.assign(connection, {fromSide: 'bottom', toSide: 'top', route: 'straight'});
      if (connection.to === 'storeA') connection.fromPort = [100 / 520, 1];
      if (connection.to === 'storeB') connection.fromPort = [420 / 520, 1];
    }
  }
  return candidate;
}

const readyTrace = ['input', 'dispatch', 'worker', 'shared', 'storeA', 'storeB'];
const blockedTrace = ['input', 'dispatch'];

/** Fresh copies on every call; experiment runners persist hashes before calls. */
export function getIncrementalFixtures() {
  const baseline = baselineCandidate();
  const sourceBefore = packet('control-v1', display, bodies);
  const build = (id, purpose, mutate, traces, changedObjects) => {
    const descriptions = clone(display), code = clone(bodies), connections = clone(baseEdges);
    mutate(descriptions, code, connections);
    const same = stableJSON({descriptions, code, connections}) === stableJSON({descriptions: display, code: bodies, connections: baseEdges});
    const sourceAfter = same ? clone(sourceBefore) : packet(`control-v2-${id}`, descriptions, code);
    const expectedSemantic = semantics(descriptions, connections, sourceAfter);
    // Preserve surviving boundary order and append new identities, matching the
    // ID-based proposal contract rather than assuming a free array reorder.
    const boundaryKey = item => `${item.kind}:${item.label}`;
    const priorBoundaryKeys = new Set(baseline.boundaries.map(boundaryKey));
    expectedSemantic.boundaries = [
      ...baseline.boundaries.flatMap(old => expectedSemantic.boundaries.filter(item => boundaryKey(item) === boundaryKey(old))),
      ...expectedSemantic.boundaries.filter(item => !priorBoundaryKeys.has(boundaryKey(item))),
    ];
    const expectedFacts = {
      origin: 'predeclared-independent-experiment-oracle',
      scope: 'Module-level synchronous task pipeline; io.trace is instrumentation and not an architecture edge.',
      components: Object.entries(descriptions).map(([nodeId, description]) => ({id: nodeId, ...description,
        sources: sourceRefs(sourceAfter.files.find(file => file.path === SOURCE_PATH(nodeId)))})),
      connections: clone(connections), boundaries: clone(expectedSemantic.boundaries),
      executions: clone(traces), changedObjects: clone(changedObjects), noOtherChanges: true,
      semanticSha256: semanticHash(expectedSemantic),
    };
    return {id, purpose, baseline: clone(baseline), expectedSemantic, sourceBefore: clone(sourceBefore), sourceAfter,
      expectedFacts, mainPath: ['input', 'dispatch', 'worker', 'shared'],
      geometryPolicy: {schemaVersion: 1, origin: 'controlled-generated-fixture',
        generated: {components: baseline.components.map(node => node.id), connections: baseline.connections.map(item => item.id),
          boundaries: baseline.boundaries.map(({kind, label}) => ({kind, label}))}},
      experiment: {kind: 'controlled-fixture', realFirmwareChange: false,
        oracleFrozenBeforeModel: true, semanticSha256: expectedFacts.semanticSha256}};
  };
  return [
    build('no-op', 'No architecture or source change; retain semantic content and geometry.', () => {}, [
      {task: {ready: true}, trace: readyTrace}, {task: {ready: false}, trace: blockedTrace},
    ], []),
    build('text-condition', 'Keep IDs and main path; rename worker and require authorization visibly on the edge.', (d, code, edges) => {
      d.worker.label = 'Task worker';
      code.dispatch = ['if (task.ready && task.authorized) return io.worker(task, io);'];
      edges.find(item => item.id === 'dispatch-worker').label = 'ready + authorized';
    }, [
      {task: {ready: true, authorized: true}, trace: readyTrace},
      {task: {ready: true, authorized: false}, trace: blockedTrace},
      {task: {ready: false, authorized: true}, trace: blockedTrace},
    ], ['component:worker', 'connection:dispatch-worker']),
    build('add-branch', 'Worker invokes an audit branch only when audit is enabled.', (d, code, edges) => {
      d.audit = {label: 'Audit', sublabel: 'Record execution', type: 'backend', owner: 'Service'};
      code.audit = ['return task;'];
      code.worker = ['if (task.audit) io.audit(task, io);', 'io.shared(task, io);', 'return task;'];
      edges.push(edge('worker-audit', 'worker', 'audit', 'audit enabled'));
    }, [
      {task: {ready: true, audit: false}, trace: readyTrace},
      {task: {ready: true, audit: true}, trace: ['input', 'dispatch', 'worker', 'audit', 'shared', 'storeA', 'storeB']},
    ], ['component:audit', 'connection:worker-audit', 'boundary:Service']),
    build('shared-consumer', 'Shared writer persists to three separate consumers; no relationship may disappear.', (d, code, edges) => {
      d.storeC = {label: 'Store C', sublabel: 'Archive copy', type: 'database', owner: 'Storage'};
      code.storeC = ['return task;'];
      code.shared.push('io.storeC(task, io);');
      edges.push(edge('shared-storeC', 'shared', 'storeC'));
    }, [
      {task: {ready: true}, trace: [...readyTrace, 'storeC']},
      {task: {ready: false}, trace: blockedTrace},
    ], ['component:storeC', 'connection:shared-storeC', 'boundary:Storage']),
    build('remove-consumer', 'Remove backup storage and its call without leaving a dangling relationship.', (d, code, edges) => {
      delete d.storeB; delete code.storeB;
      code.shared = ['io.storeA(task, io);'];
      edges.splice(edges.findIndex(item => item.id === 'shared-storeB'), 1);
    }, [
      {task: {ready: true}, trace: readyTrace.filter(id => id !== 'storeB')},
    ], ['component:storeB', 'connection:shared-storeB', 'boundary:Storage']),
    build('boundary-move', 'Rename service ownership and migrate backup storage without changing execution calls.', d => {
      for (const item of Object.values(d)) if (item.owner === 'Service') item.owner = 'Application';
      d.storeB.owner = 'Application';
    }, [{task: {ready: true}, trace: readyTrace}], ['boundary:Service', 'boundary:Application', 'boundary:Storage']),
    build('long-label', 'Retain the complete long label; resizing is permitted but text shrinking is not.', d => {
      d.worker.label = 'Validated task execution and result preparation';
      d.worker.sublabel = 'Keep the entire label';
    }, [{task: {ready: true}, trace: readyTrace}], ['component:worker']),
    build('feedback', 'Backup storage may request exactly one retry; keep the feedback direction distinct.', (d, code, edges) => {
      code.storeB = ['if (task.retry && !task.retried) return io.dispatch({...task, retried: true}, io);', 'return task;'];
      edges.push({...edge('storeB-dispatch', 'storeB', 'dispatch', 'retry once'), variant: 'dashed'});
    }, [
      {task: {ready: true, retry: false}, trace: readyTrace},
      {task: {ready: true, retry: true}, trace: [...readyTrace, ...readyTrace.slice(1)]},
    ], ['connection:storeB-dispatch']),
  ];
}

/** Golden fixture proposal only: never substitute it for model experiment output. */
export function buildFixtureProposal(fixture, baselineSha256) {
  const oldSemantic = extractSemantic(fixture.baseline).semantic, next = fixture.expectedSemantic;
  const operations = [];
  const evidence = ['Controlled experiment oracle frozen before model invocation',
    ...fixture.sourceAfter.files.map(file => `${file.path}:1-${file.content.trimEnd().split('\n').length} sha256:${file.sha256}`)];
  for (const [collection, target] of [['components', 'component'], ['connections', 'connection'], ['boundaries', 'boundary']]) {
    const key = value => target === 'boundary' ? `${value.kind}:${value.label}` : value.id;
    const oldMap = new Map((oldSemantic[collection] || []).map(value => [key(value), value]));
    const newMap = new Map((next[collection] || []).map(value => [key(value), value]));
    const selector = value => target === 'boundary' ? {selector: {kind: value.kind, label: value.label}} : {id: value.id};
    for (const [id, before] of oldMap) {
      if (!newMap.has(id)) operations.push({op: 'remove', target, ...selector(before), before: clone(before), evidence});
      else {
        const after = newMap.get(id), set = {}, unset = [];
        for (const [field, value] of Object.entries(after)) if (stableJSON(before[field]) !== stableJSON(value)) set[field] = clone(value);
        for (const field of Object.keys(before)) if (!Object.hasOwn(after, field)) unset.push(field);
        if (Object.keys(set).length || unset.length) operations.push({op: 'update', target, ...selector(before), before: clone(before), set, ...(unset.length ? {unset} : {}), evidence});
      }
    }
    for (const [id, value] of newMap) if (!oldMap.has(id)) operations.push({op: 'add', target, value: clone(value), evidence});
  }
  return {schemaVersion: 1, baselineSha256, operations};
}

/** Deliberately wrong candidates for oracle/gate rejection, separate from positives. */
export function getIncrementalOracleNegatives() {
  const fixtures = getIncrementalFixtures();
  const condition = clone(fixtures.find(item => item.id === 'text-condition'));
  const missingCondition = clone(condition.expectedSemantic);
  missingCondition.connections.find(item => item.id === 'dispatch-worker').label = 'ready';
  const shared = clone(fixtures.find(item => item.id === 'shared-consumer'));
  const missingEdge = clone(shared.expectedSemantic);
  missingEdge.connections = missingEdge.connections.filter(item => item.id !== 'shared-storeC');
  const feedback = clone(fixtures.find(item => item.id === 'feedback'));
  const reversedEdge = clone(feedback.expectedSemantic);
  Object.assign(reversedEdge.connections.find(item => item.id === 'storeB-dispatch'), {from: 'dispatch', to: 'storeB'});
  return [
    {id: 'missing-authorization-condition', fixtureId: condition.id, expectedSemantic: condition.expectedSemantic, incorrectSemantic: missingCondition},
    {id: 'missing-shared-relationship', fixtureId: shared.id, expectedSemantic: shared.expectedSemantic, incorrectSemantic: missingEdge},
    {id: 'reversed-feedback-direction', fixtureId: feedback.id, expectedSemantic: feedback.expectedSemantic, incorrectSemantic: reversedEdge},
  ];
}
