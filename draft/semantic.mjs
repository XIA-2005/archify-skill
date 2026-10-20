import {createHash} from 'node:crypto';

// Exact, owner-specific geometry fields. Never strip by prefix, recursion or
// field name alone: cards, conditions, roles, colors and sources stay intact.
export const GEOMETRY_FIELDS = Object.freeze({
  diagram: ['layout'], meta: ['viewBox'],
  component: ['pos', 'size', 'row', 'col'],
  boundary: ['bounds', 'labelOffset', 'pad'],
  connection: ['fromSide', 'toSide', 'fromPort', 'toPort', 'via', 'route', 'channelX', 'channelY', 'labelAt', 'labelDx', 'labelDy', 'labelSegment'],
});
export const stableJSON = value => JSON.stringify(canonical(value));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
export const semanticHash = value => createHash('sha256').update(stableJSON(value)).digest('hex');

// Explicit opt-in only. Rendering/editor saving never calls this function.
export function extractSemantic(candidate) {
  const semantic = structuredClone(candidate), removed = [];
  const strip = (owner, fields, location) => {
    if (!owner) return;
    for (const field of fields) if (Object.hasOwn(owner, field)) {
      removed.push({path: `${location}.${field}`, value: owner[field], reason: 'independent-new-layout'});
      delete owner[field];
    }
  };
  strip(semantic, GEOMETRY_FIELDS.diagram, 'diagram');
  strip(semantic.meta, GEOMETRY_FIELDS.meta, 'meta');
  semantic.components.forEach((node, i) => strip(node, GEOMETRY_FIELDS.component, `components[${i}]`));
  (semantic.boundaries || []).forEach((node, i) => strip(node, GEOMETRY_FIELDS.boundary, `boundaries[${i}]`));
  (semantic.connections || []).forEach((node, i) => strip(node, GEOMETRY_FIELDS.connection, `connections[${i}]`));
  return {semantic, removed, semanticSha256: semanticHash(semantic)};
}
export function compareSemantics(source, candidate, {outputPath} = {}) {
  const actual = extractSemantic(candidate).semantic;
  const defaults = [], deliveryRelocations = [];
  if (outputPath !== undefined && candidate.meta.output === outputPath) {
    deliveryRelocations.push({path: 'meta.output', from: source.meta.output, to: outputPath});
    actual.meta.output = source.meta.output;
  }
  for (const [field, value] of [['font_scale', 1.25], ['quality_profile', 'showcase']]) {
    if (!Object.hasOwn(source.meta, field) && actual.meta?.[field] === value) {
      defaults.push({path: `meta.${field}`, value}); delete actual.meta[field];
    }
  }
  const expectedSha256 = semanticHash(source), actualSha256 = semanticHash(actual);
  return {equivalent: expectedSha256 === actualSha256, expectedSha256, actualSha256, defaults, deliveryRelocations};
}
