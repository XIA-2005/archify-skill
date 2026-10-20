import {createHash} from 'node:crypto';
import {GEOMETRY_FIELDS, extractSemantic, semanticHash, stableJSON} from '../draft/semantic.mjs';
import {validateSchema} from '../renderers/shared/validator.mjs';

// This is a bounded change proposal, not a second diagram schema. Values are
// validated by the existing Architecture schema after the atomic transaction.
export const CONTENT_CHANGE_CONTRACT = Object.freeze({schemaVersion: 1, maxOperations: 128});
const collections = {component: 'components', connection: 'connections', boundary: 'boundaries'};
const geometryOwner = {component: 'component', connection: 'connection', boundary: 'boundary', meta: 'meta'};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => stableJSON(left) === stableJSON(right);
const boundaryIdentity = boundary => ({kind: boundary.kind, label: boundary.label});
const boundaryKey = boundary => stableJSON(boundaryIdentity(boundary));

function fail(code, message, subject = {}, evidence = {}, supportedFixes = []) {
  const error = new Error(message);
  error.code = `incremental/${code}`;
  error.archifyDiagnostics = [{code: error.code, severity: 'error', message, subject, evidence, supportedFixes}];
  throw error;
}

function requireObject(value, subject) {
  if (!object(value)) fail('invalid-proposal', 'Expected a JSON object.', subject);
}

function exactFields(value, allowed, subject) {
  requireObject(value, subject);
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) fail('unknown-field', 'The change proposal contains an unsupported field.',
      {...subject, field}, {}, ['remove the unsupported field; do not silently discard it']);
  }
}

function jsonValue(value, path, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)
      || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
    fail('non-json', 'Inputs must contain only finite JSON values.', {path});
  }
  ancestors.add(value);
  for (const [key, item] of Object.entries(value)) jsonValue(item, `${path}/${key}`, ancestors);
  if (Array.isArray(value) && (Object.keys(value).length !== value.length
      || Array.from({length: value.length}, (_, index) => index).some(index => !own(value, index)))) {
    fail('non-json', 'Sparse arrays and custom array properties are not supported.', {path});
  }
  ancestors.delete(value);
}

function schema(value, role) {
  try { validateSchema('architecture', value); }
  catch (error) {
    if (error.archifyDiagnostics) {
      for (const diagnostic of error.archifyDiagnostics) diagnostic.subject = {...diagnostic.subject, role};
    }
    throw error;
  }
}

function validateIdentityAndReferences(candidate, role) {
  const nodeIds = new Set(), edgeIds = new Set(), boundaryIds = new Set(), viewIds = new Set();
  for (const [target, items, identities] of [
    ['component', candidate.components, nodeIds],
    ['connection', candidate.connections || [], edgeIds],
    ['boundary', candidate.boundaries || [], boundaryIds],
    ['view', candidate.meta.views || [], viewIds],
  ]) {
    for (const item of items) {
      // Legacy relationships without IDs may be retained, but cannot be edited
      // by guessing from their array index or endpoints.
      const identity = target === 'boundary' ? boundaryKey(item) : item.id;
      if (identity === undefined && target === 'connection') continue;
      if (identities.has(identity)) fail('duplicate-id', 'Stable identities must be unique within their collection.',
        {role, target, id: identity});
      identities.add(identity);
    }
  }
  for (const edge of candidate.connections || []) {
    for (const field of ['from', 'to']) if (!nodeIds.has(edge[field])) {
      fail('dangling-reference', 'A relationship endpoint does not identify a component.',
        {role, target: 'connection', id: edge.id, field}, {value: edge[field]});
    }
  }
  for (const boundary of candidate.boundaries || []) {
    if (new Set(boundary.wraps).size !== boundary.wraps.length) {
      fail('duplicate-reference', 'A boundary cannot repeat a member.', {role, selector: boundaryIdentity(boundary)});
    }
    for (const member of boundary.wraps) if (!nodeIds.has(member)) {
      fail('dangling-reference', 'A boundary member does not identify a component.',
        {role, selector: boundaryIdentity(boundary)}, {member});
    }
  }
  for (const view of candidate.meta.views || []) {
    for (const identity of view.focus) if (!nodeIds.has(identity) && !edgeIds.has(identity)) {
      fail('dangling-reference', 'A guided view focus does not identify a component or relationship.',
        {role, target: 'view', id: view.id}, {focus: identity});
    }
  }
}

function rejectGeometry(value, target, subject) {
  requireObject(value, subject);
  const fields = GEOMETRY_FIELDS[geometryOwner[target]] || [];
  for (const field of fields) if (own(value, field)) {
    fail('geometry-in-content', 'Content changes cannot author or remove geometry.', {...subject, field}, {},
      ['submit geometry changes through the separate constrained layout stage']);
  }
}

function semanticOwner(owner, target) {
  const clone = structuredClone(owner);
  for (const field of GEOMETRY_FIELDS[geometryOwner[target]] || []) delete clone[field];
  return clone;
}

function selectorFor(operation, subject) {
  if (operation.target === 'boundary') {
    exactFields(operation.selector, ['kind', 'label'], subject);
    if (typeof operation.selector.kind !== 'string' || typeof operation.selector.label !== 'string') {
      fail('invalid-selector', 'Boundary changes require their old kind and label.', subject);
    }
    return operation.selector;
  }
  if (typeof operation.id !== 'string' || !operation.id) {
    fail('invalid-selector', 'Component and relationship changes require a stable ID.', subject);
  }
  return operation.id;
}

function findIndex(candidate, target, selector) {
  return (candidate[collections[target]] || []).findIndex(item => target === 'boundary'
    ? boundaryKey(item) === boundaryKey(selector) : item.id === selector);
}

function checkBefore(actual, operation, subject) {
  if (!own(operation, 'before') || !same(actual, operation.before)) {
    fail('old-value-mismatch', 'The supplied old content does not match the current transaction state.', subject,
      {expected: actual, provided: operation.before ?? null}, ['read the current baseline and regenerate a reviewed proposal']);
  }
}

function updateFields(owner, operation, subject) {
  if (!own(operation, 'set') && !own(operation, 'unset')) {
    fail('invalid-proposal', 'An update requires set or unset.', subject);
  }
  const set = own(operation, 'set') ? operation.set : {}, unset = own(operation, 'unset') ? operation.unset : [];
  requireObject(set, subject);
  if (!Array.isArray(unset) || unset.some(field => typeof field !== 'string') || new Set(unset).size !== unset.length) {
    fail('invalid-proposal', 'Unset must be an array of distinct field names.', subject);
  }
  rejectGeometry(set, operation.target, subject);
  for (const field of unset) {
    if ((GEOMETRY_FIELDS[geometryOwner[operation.target]] || []).includes(field)) {
      fail('geometry-in-content', 'Content changes cannot remove geometry.', {...subject, field});
    }
    if (!own(owner, field)) fail('old-value-mismatch', 'Cannot unset an absent field.', {...subject, field});
    if (own(set, field)) fail('invalid-proposal', 'A field cannot be set and unset in the same operation.', {...subject, field});
  }
  if (['component', 'connection'].includes(operation.target) && (own(set, 'id') || unset.includes('id'))) {
    fail('identity-change', 'Stable IDs cannot be changed by an update.', subject,
      {}, ['describe a real identity replacement as explicitly approved removal and addition']);
  }
  for (const field of unset) delete owner[field];
  for (const [field, value] of Object.entries(set)) {
    Object.defineProperty(owner, field, {value: structuredClone(value), enumerable: true, configurable: true, writable: true});
  }
}

function semanticDifferences(expected, actual, path = '') {
  if (same(expected, actual)) return [];
  if (object(expected) && object(actual)) {
    return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].flatMap(field => {
      const location = `${path}/${field}`;
      if (!own(expected, field) || !own(actual, field)) return [{path: location,
        expected: {present: own(expected, field), ...(own(expected, field) ? {value: expected[field]} : {})},
        actual: {present: own(actual, field), ...(own(actual, field) ? {value: actual[field]} : {})}}];
      return semanticDifferences(expected[field], actual[field], location);
    });
  }
  if (Array.isArray(expected) && Array.isArray(actual) && expected.length === actual.length) {
    return expected.flatMap((item, index) => semanticDifferences(item, actual[index], `${path}/${index}`));
  }
  return [{path: path || '/', expected: {present: true, value: expected}, actual: {present: true, value: actual}}];
}

function reconcileBoundaryGeometry(baseline, candidate, origins) {
  const previous = baseline.boundaries || [], current = candidate.boundaries || [];
  const surviving = new Set(current.map(owner => origins.get(owner)).filter(index => index !== undefined));
  const removed = previous.map((owner, index) => ({owner, index})).filter(item => !surviving.has(item.index));
  const additions = current.filter(owner => !origins.has(owner));
  const hasGeometry = owner => GEOMETRY_FIELDS.boundary.some(field => own(owner, field));
  const members = owner => stableJSON([...owner.wraps].sort());
  const proposals = additions.map(owner => {
    let matches = removed.filter(item => boundaryKey(item.owner) === boundaryKey(owner));
    let reason = 'same-boundary-identity';
    if (!matches.length) {
      matches = removed.filter(item => members(item.owner) === members(owner));
      reason = 'same-boundary-members';
    }
    if (!matches.length) {
      matches = removed.filter(item => item.owner.wraps.some(id => owner.wraps.includes(id)));
      reason = 'overlapping-boundary-members';
    }
    if (matches.length > 1 && matches.some(item => hasGeometry(item.owner))) {
      fail('ambiguous-boundary-replacement', 'A new boundary could inherit multiple removed geometry constraints.',
        {selector: boundaryIdentity(owner)}, {possibleOrigins: matches.map(item => boundaryIdentity(item.owner))},
        ['use explicit boundary updates/mappings or preserve the original boundary identities before changing geometry']);
    }
    return {owner, matches, reason};
  });
  for (const item of removed) {
    const destinations = proposals.filter(proposal => proposal.matches.some(match => match.index === item.index));
    if (destinations.length > 1 && hasGeometry(item.owner)) {
      fail('ambiguous-boundary-replacement', 'A removed boundary constraint cannot silently become several independent frames.',
        {selector: boundaryIdentity(item.owner)}, {possibleDestinations: destinations.map(entry => boundaryIdentity(entry.owner))},
        ['retain the original constrained boundary and explicitly approve any separate new boundaries']);
    }
  }
  const transfers = [];
  for (const proposal of proposals) {
    if (proposal.matches.length !== 1) continue;
    const {owner: origin, index} = proposal.matches[0];
    if (proposals.filter(item => item.matches.some(match => match.index === index)).length !== 1) continue;
    origins.set(proposal.owner, index);
    const fields = GEOMETRY_FIELDS.boundary.filter(field => own(origin, field));
    for (const field of fields) proposal.owner[field] = structuredClone(origin[field]);
    transfers.push({from: boundaryIdentity(origin), to: boundaryIdentity(proposal.owner), reason: proposal.reason, fields});
  }
  // Object lineage folds arbitrarily many explicit renames without guessing
  // from an intermediate label. Replacements above inherit constraints only;
  // their semantic identity and correctness still come from independent S1.
  const mappings = current.flatMap(owner => {
    const origin = previous[origins.get(owner)];
    return origin && boundaryKey(origin) !== boundaryKey(owner)
      ? [{from: boundaryIdentity(origin), to: boundaryIdentity(owner)}] : [];
  });
  return {mappings, transfers};
}

/** Apply a bounded, reviewed content transaction without modifying its inputs.
 *
 * baselineBytes binds and verifies the exact original UTF-8 bytes. If only
 * baselineSha256 is supplied, the caller is trusted to have read and hashed the
 * supplied baseline itself; this API cannot derive a raw-byte hash from an
 * already parsed object. expectedSemantic is independent, fully approved S1.
 * Its arrays, style, provenance and output path are compared exactly. Geometry
 * is retained by identity; subsequent constrained layout owns its invalidation.
 */
export function applyContentChanges(baseline, proposal, {baselineBytes, baselineSha256, expectedSemantic} = {}) {
  jsonValue(baseline, '/baseline');
  jsonValue(proposal, '/proposal');
  if (expectedSemantic === undefined) fail('missing-expected-semantic', 'Independent approved S1 is required.');
  jsonValue(expectedSemantic, '/expectedSemantic');
  schema(baseline, 'baseline');
  validateIdentityAndReferences(baseline, 'baseline');
  schema(expectedSemantic, 'expectedSemantic');
  validateIdentityAndReferences(expectedSemantic, 'expectedSemantic');
  const expected = extractSemantic(expectedSemantic);
  if (expected.removed.length) fail('expected-has-geometry', 'Approved S1 must contain content only.', {}, {removed: expected.removed});

  let actualHash = baselineSha256;
  let baselineBinding = 'caller-supplied-raw-sha256';
  if (baselineBytes !== undefined) {
    if (typeof baselineBytes !== 'string' && !Buffer.isBuffer(baselineBytes) && !(baselineBytes instanceof Uint8Array)) {
      fail('invalid-baseline-bytes', 'Baseline bytes must be a UTF-8 string, Buffer or Uint8Array.');
    }
    const bytes = typeof baselineBytes === 'string' ? Buffer.from(baselineBytes, 'utf8') : Buffer.from(baselineBytes);
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
    catch (error) { fail('invalid-baseline-bytes', 'Baseline bytes are not valid JSON.', {}, {reason: error.message}); }
    if (!same(parsed, baseline)) fail('baseline-object-mismatch', 'The parsed baseline differs from its supplied raw bytes.');
    actualHash = hash(bytes);
    if (baselineSha256 !== undefined && baselineSha256 !== actualHash) {
      fail('baseline-hash-mismatch', 'The caller baseline hash does not match the original bytes.');
    }
    baselineBinding = 'verified-raw-bytes';
  }
  if (typeof actualHash !== 'string' || !/^[a-f0-9]{64}$/.test(actualHash)) {
    fail('missing-baseline-hash', 'Supply the original baseline bytes or their SHA256.');
  }
  exactFields(proposal, ['schemaVersion', 'baselineSha256', 'operations'], {target: 'proposal'});
  if (proposal.schemaVersion !== CONTENT_CHANGE_CONTRACT.schemaVersion || !Array.isArray(proposal.operations)
      || proposal.operations.length > CONTENT_CHANGE_CONTRACT.maxOperations) {
    fail('invalid-proposal', 'Expected version 1 and at most 128 operations.');
  }
  if (proposal.baselineSha256 !== actualHash) fail('stale-baseline', 'The proposal targets another baseline.', {},
    {expected: actualHash, proposed: proposal.baselineSha256}, ['regenerate the proposal against the current raw candidate bytes']);

  const candidate = structuredClone(baseline), changes = [];
  const boundaryOrigins = new Map((candidate.boundaries || []).map((owner, index) => [owner, index]));
  for (const [index, operation] of proposal.operations.entries()) {
    const subject = {operation: index, target: operation?.target};
    requireObject(operation, subject);
    const {target, op} = operation;
    if (!['component', 'connection', 'boundary', 'meta', 'cards'].includes(target)
        || !['add', 'remove', 'update'].includes(op)) fail('invalid-operation', 'Unsupported target or operation.', subject);
    const selectorField = target === 'boundary' ? 'selector' : 'id';
    const allowed = ['op', 'target', 'evidence', ...(op === 'add' ? ['value']
      : target === 'cards' ? ['before', 'value']
        : [...(['meta'].includes(target) ? [] : [selectorField]), 'before', ...(op === 'update' ? ['set', 'unset'] : [])])];
    exactFields(operation, allowed, subject);
    if (!Array.isArray(operation.evidence) || !operation.evidence.length
        || operation.evidence.some(item => typeof item !== 'string' || !item.trim())) {
      fail('unsupported-change', 'Every operation needs explicit source or reviewed requirement evidence.', subject);
    }
    if (['meta', 'cards'].includes(target) && op !== 'update') {
      fail('invalid-operation', 'Metadata and cards support atomic update only.', subject);
    }

    if (target === 'cards') {
      checkBefore(candidate.cards ?? null, operation, subject);
      if (!own(operation, 'value') || (operation.value !== null && !Array.isArray(operation.value))) {
        fail('invalid-proposal', 'Cards value must be an entire array or null to remove the property.', subject);
      }
      const before = candidate.cards ?? null;
      if (operation.value === null) delete candidate.cards;
      else candidate.cards = structuredClone(operation.value);
      changes.push({...subject, op, before, after: candidate.cards ?? null, evidence: [...operation.evidence]});
      continue;
    }
    if (target === 'meta') {
      const before = semanticOwner(candidate.meta, target);
      checkBefore(before, operation, subject);
      updateFields(candidate.meta, operation, subject);
      changes.push({...subject, op, before, after: semanticOwner(candidate.meta, target), evidence: [...operation.evidence]});
      continue;
    }
    if (op === 'add') {
      rejectGeometry(operation.value, target, subject);
      const identity = target === 'boundary' ? boundaryIdentity(operation.value) : operation.value.id;
      if (target !== 'boundary' && (typeof identity !== 'string' || !identity)) {
        fail('invalid-selector', 'New components and relationships require stable IDs.', subject);
      }
      if (findIndex(candidate, target, identity) !== -1) fail('duplicate-id', 'Cannot add an existing stable identity.', {...subject, id: identity});
      candidate[collections[target]] ??= [];
      candidate[collections[target]].push(structuredClone(operation.value));
      changes.push({...subject, op, id: identity, before: null, after: structuredClone(operation.value), evidence: [...operation.evidence]});
      continue;
    }
    const selector = selectorFor(operation, subject), ownerIndex = findIndex(candidate, target, selector);
    if (ownerIndex === -1) fail('missing-target', 'The stable target does not exist in the current transaction state.', {...subject, id: selector});
    const owner = candidate[collections[target]][ownerIndex], before = semanticOwner(owner, target);
    checkBefore(before, operation, {...subject, id: selector});
    if (op === 'remove') {
      const explicitBoundaryReplacement = target === 'boundary' && proposal.operations.slice(index + 1).some(next =>
        next?.op === 'add' && next.target === 'boundary' && object(next.value) && boundaryKey(next.value) === boundaryKey(selector));
      if (findIndex(expectedSemantic, target, selector) !== -1 && !explicitBoundaryReplacement) {
        fail('unsupported-deletion', 'Approved S1 still contains the identity proposed for deletion.', {...subject, id: selector});
      }
      candidate[collections[target]].splice(ownerIndex, 1);
      changes.push({...subject, op, id: selector, before, after: null, evidence: [...operation.evidence]});
    } else {
      updateFields(owner, operation, {...subject, id: selector});
      const after = semanticOwner(owner, target);
      changes.push({...subject, op, id: selector, before, after, evidence: [...operation.evidence]});
    }
  }
  schema(candidate, 'updatedCandidate');
  validateIdentityAndReferences(candidate, 'updatedCandidate');
  const {mappings: boundaryMappings, transfers: geometryTransfers} = reconcileBoundaryGeometry(baseline, candidate, boundaryOrigins);
  const actual = extractSemantic(candidate);
  if (!same(expectedSemantic, actual.semantic)) {
    fail('semantic-mismatch', 'The complete updated content differs from independent approved S1.', {},
      {expectedSemanticSha256: expected.semanticSha256, actualSemanticSha256: actual.semanticSha256,
        differences: semanticDifferences(expectedSemantic, actual.semantic)},
      ['review missing, unexpected or reordered content against approved S1 before layout']);
  }
  return {candidate, semantic: actual.semantic, changes, boundaryMappings, geometryTransfers, baselineSha256: actualHash, baselineBinding,
    expectedSemanticSha256: semanticHash(expectedSemantic), semanticSha256: actual.semanticSha256};
}
