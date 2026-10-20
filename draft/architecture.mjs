import {compactPoints, readingMetrics} from './quality.mjs';
import {planAutoLayout} from '../renderers/shared/architecture-auto-layout.mjs';
import {minimumNodeTextWidth, nodeTextFit} from '../renderers/shared/text-fit.mjs';
import {labelGeometry, componentTextGeometry} from '../renderers/shared/text-style.mjs';
import {validateSchema} from '../renderers/shared/validator.mjs';
import {throwDiagnosticError} from '../renderers/shared/diagnostics.mjs';
import {collectAmbiguousCorridors} from '../renderers/shared/geometry.mjs';
import {declaredWideReadabilityBudget, DESKTOP_READER_DIAGRAM_WIDTH} from '../renderers/shared/desktop-readability.mjs';
import {resolveComposition, compositionPositions} from './composition.mjs';
import {validateArchitectureIntent, rejectIntent} from './intent.mjs';
import {architectureIntentDrafts} from './intent-layout.mjs';

// Lay out ownership boundaries as compound nodes. Independent strips put every
// external actor far above its actual owner; collapsing groups retains the
// inter-group graph and prevents unrelated nodes from appearing inside a frame.
function compoundPositions(candidate, direction, innerDirection, spacing, labelGap) {
  const nodes = new Map(candidate.components.map(node => [node.id, node]));
  const groups = [];
  for (const boundary of candidate.boundaries || []) {
    const members = new Set(boundary.wraps);
    if (groups.some(group => group.members.size === members.size && [...members].every(id => group.members.has(id)))) continue;
    for (const group of groups) {
      const intersection = [...members].filter(id => group.members.has(id)).length;
      if (intersection && intersection !== members.size && intersection !== group.members.size) {
        throwDiagnosticError('Automatic drafting requires disjoint or nested ownership boundaries.', [{
          code: 'draft/overlapping-boundaries', subject: {label: boundary.label}, evidence: {},
          supportedFixes: ['preserve the overlapping memberships and use manual geometry; do not change ownership to satisfy drafting'],
        }]);
      }
    }
    let id = `__draft_group_${groups.length}`;
    while (nodes.has(id)) id += '_';
    groups.push({id, members, padding: 42});
  }
  const root = {id: '__root', members: new Set(nodes.keys()), padding: 0};
  for (const group of groups) {
    group.parent = groups.filter(parent => parent !== group && parent.members.size > group.members.size
      && [...group.members].every(id => parent.members.has(id))).sort((a, b) => a.members.size - b.members.size)[0] || root;
  }
  function arrange(group) {
    const children = groups.filter(child => child.parent === group);
    const direct = [...group.members].filter(id => !children.some(child => child.members.has(id)));
    const parts = children.map(child => ({id: child.id, ...arrange(child), members: child.members}));
    parts.push(...direct.map(id => ({id, size: nodes.get(id).size, positions: {[id]: [0, 0]}, members: new Set([id])})));
    const owner = new Map(parts.flatMap(part => [...part.members].map(id => [id, part.id])));
    const edges = (candidate.connections || []).filter(edge => owner.has(edge.from) && owner.has(edge.to)
      && owner.get(edge.from) !== owner.get(edge.to)).map(edge => ({from: owner.get(edge.from), to: owner.get(edge.to)}));
    const plan = planAutoLayout({components: parts.map(part => ({id: part.id, size: part.size})), connections: edges}, {
      direction: group === root ? direction : innerDirection,
      layerGap: Math.min(320, Math.ceil(labelGap * spacing)), nodeGap: Math.min(240, Math.ceil(88 * spacing)),
      componentGap: Math.min(400, Math.ceil(120 * spacing)), margin: 24,
    });
    const positions = {};
    let maxX = 0, maxY = 0;
    for (const part of parts) {
      const [x, y] = plan.positions[part.id].map(value => value - 24);
      for (const [id, point] of Object.entries(part.positions)) positions[id] = [point[0] + x + group.padding, point[1] + y + group.padding];
      maxX = Math.max(maxX, x + part.size[0]); maxY = Math.max(maxY, y + part.size[1]);
    }
    // Align an external leaf with the actual endpoint inside a compound node,
    // rather than with the compound rectangle's centre. Keep the move only
    // when it fits the allocated strip and cannot overlap another component.
    const axis = (group === root ? direction : innerDirection) === 'LR' ? 1 : 0;
    for (const id of direct) {
      const edge = (candidate.connections || []).find(edge => (edge.from === id || edge.to === id)
        && children.some(child => child.members.has(edge.from === id ? edge.to : edge.from)));
      if (!edge) continue;
      const target = edge.from === id ? edge.to : edge.from;
      const point = [...positions[id]], size = nodes.get(id).size;
      point[axis] = positions[target][axis] + (nodes.get(target).size[axis] - size[axis]) / 2;
      if (point[axis] < group.padding || point[axis] + size[axis] > (axis ? maxY : maxX) + group.padding) continue;
      const blocked = Object.entries(positions).some(([other, p]) => other !== id
        && point[0] < p[0] + nodes.get(other).size[0] + 24 && point[0] + size[0] + 24 > p[0]
        && point[1] < p[1] + nodes.get(other).size[1] + 24 && point[1] + size[1] + 24 > p[1]);
      if (!blocked) positions[id] = point.map(Math.round);
    }
    return {positions, size: [maxX + group.padding * 2, maxY + group.padding * 2 + (group === root ? 0 : 20)]};
  }
  const {positions} = arrange(root);
  return Object.fromEntries(Object.entries(positions).map(([id, [x, y]]) => [id, [x + 60, y + 60]]));
}

// Drafting is intentionally separate from rendering: existing authored geometry
// remains authoritative, and no runtime/schema defaults change for old inputs.
export function architectureDrafts(semantic, options = {}) {
  validateSchema('architecture', semantic);
  const fixed = [];
  const inspect = (owner, fields, location) => {
    for (const field of fields) if (Object.hasOwn(owner, field)) fixed.push(`${location}.${field}`);
  };
  inspect(semantic, ['layout'], 'diagram');
  inspect(semantic.meta, ['viewBox'], 'meta');
  semantic.components.forEach((node, i) => inspect(node, ['pos', 'size', 'row', 'col'], `components[${i}]`));
  (semantic.boundaries || []).forEach((boundary, i) => inspect(boundary, ['bounds', 'labelOffset', 'pad'], `boundaries[${i}]`));
  (semantic.connections || []).forEach((edge, i) => inspect(edge,
    ['fromSide', 'toSide', 'fromPort', 'toPort', 'via', 'route', 'channelX', 'channelY', 'labelAt', 'labelDx', 'labelDy', 'labelSegment'], `connections[${i}]`));
  if (fixed.length) throwDiagnosticError('Draft accepts semantic input only; supplied geometry must use the existing delivery path.', [{
    code: 'draft/fixed-geometry', subject: {fields: fixed}, evidence: {fields: fixed},
    supportedFixes: ['deliver the existing candidate without drafting', 'for a separate fresh layout, create a semantic copy without geometry; preserve the original'],
  }]);
  const ids = new Set();
  for (const node of semantic.components) {
    if (ids.has(node.id)) throwDiagnosticError('Duplicate component ID.', [{
      code: 'draft/duplicate-id', subject: {id: node.id}, evidence: {}, supportedFixes: ['assign each component a unique ID and update its references'],
    }]);
    ids.add(node.id);
  }
  const missing = (semantic.connections || []).flatMap(edge => [edge.from, edge.to]).concat(
    (semantic.boundaries || []).flatMap(boundary => boundary.wraps)).filter(id => !ids.has(id));
  if (missing.length) throwDiagnosticError('Unknown component references.', [{
    code: 'draft/unknown-component', subject: {ids: [...new Set(missing)]}, evidence: {},
    supportedFixes: ['correct the reference or add the missing component from verified source facts'],
  }]);
  if (options.intent !== undefined && (options.composition !== undefined || options.mainPath !== undefined)) {
    rejectIntent('options', 'Choose an intent file or legacy composition/main-path options, not both.');
  }
  const intent = options.intent === undefined ? null : validateArchitectureIntent(semantic, options.intent);
  const composition = intent ? null : resolveComposition(semantic, options);
  const sized = structuredClone(semantic);
  // New drafts use readable source text; explicit source styling is preserved.
  // This is a draft-only default, never a renderer or schema default.
  sized.meta.font_scale ??= 1.25;
  const scale = sized.meta.font_scale;
  for (const node of sized.components) {
    const sizes = {label: node.font_sizes?.label ?? 11 * scale,
      sublabel: node.font_sizes?.sublabel ?? 9 * scale, tag: node.font_sizes?.tag ?? 7 * scale};
    const keys = ['label', ...(node.sublabel ? ['sublabel'] : []), ...(node.tag ? ['tag'] : [])];
    // Preserve complete text at preferred sizes; never shorten labels to fit.
    const width = Math.max(120, ...keys.map(key => minimumNodeTextWidth(node[key], sizes[key]) + nodeTextFit.horizontalPadding + 16));
    const height = Math.max(72, keys.reduce((sum, key) => sum + sizes[key] * 1.3 + 4, 0) + 32);
    node.size = [Math.ceil(width), Math.ceil(height)];
  }
  if (intent) return architectureIntentDrafts(sized, intent);
  const labelGap = Math.max(80, ...(semantic.connections || []).map(edge => edge.label
    ? labelGeometry(edge.label, edge.font_sizes?.label ?? 9 * scale, [0, 0]).width + 36 : 0));
  const proposals = [];
  const seen = new Set();
  if (composition.composition !== 'layered') {
    const middle = Math.ceil(composition.mainPath.length / 2);
    const splits = composition.composition === 'feedback' ? [middle, middle + 1, middle - 1] : [0];
    for (const split of splits.filter(value => composition.composition !== 'feedback'
      || value >= 2 && composition.mainPath.length - value >= 2)) for (const spacing of [0.85, 1.2]) {
      const candidate = structuredClone(sized);
      const positions = compositionPositions(candidate, composition, {spacing, split});
      if (!positions) continue;
      for (const node of candidate.components) node.pos = positions[node.id];
      const identity = JSON.stringify(positions);
      if (seen.has(identity)) continue;
      seen.add(identity);
      proposals.push({id: `${composition.composition}-${split}-${spacing}`, structure: composition.composition, candidate});
    }
    return proposals;
  }
  for (const direction of ['LR', 'TB']) for (const innerDirection of ['LR', 'TB']) for (const spacing of [0.75, 1.25]) {
    const candidate = structuredClone(sized);
    const positions = compoundPositions(candidate, direction, innerDirection, spacing, labelGap);
    for (const node of candidate.components) node.pos = positions[node.id];
    const identity = JSON.stringify(positions);
    if (seen.has(identity)) continue;
    seen.add(identity);
    proposals.push({id: `${direction.toLowerCase()}-${innerDirection.toLowerCase()}-${spacing}`, structure: 'layered', candidate});
  }
  return proposals;
}

// Advisory ranking only, after unchanged renderer/artifact acceptance. The
// selected layout still needs browser checks and actual screenshot inspection.
export function draftMetrics(layout, candidate, intent) {
  let bends = 0, routeLength = 0, crossings = 0;
  const segments = [];
  for (const [edge, connection] of layout.connections.entries()) {
    const points = compactPoints(connection.points);
    bends += Math.max(0, points.length - 2);
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1], points[i]];
      routeLength += Math.hypot(a[0] - b[0], a[1] - b[1]);
      segments.push({edge, a, b});
    }
  }
  for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
    const s = segments[i], t = segments[j];
    if (s.edge === t.edge) continue;
    const h = s.a[1] === s.b[1] ? s : t, v = h === s ? t : s;
    if (h.a[1] !== h.b[1] || v.a[0] !== v.b[0]) continue;
    if (v.a[0] > Math.min(h.a[0], h.b[0]) && v.a[0] < Math.max(h.a[0], h.b[0])
      && h.a[1] > Math.min(v.a[1], v.b[1]) && h.a[1] < Math.max(v.a[1], v.b[1])) crossings++;
  }
  const counterflowCorridors = collectAmbiguousCorridors({
    routedRelations: layout.connections.map(relation => ({relation, points: relation.points})),
    includeSharedEndpointCounterflow: () => true,
  }).filter(hit => {
    const delta = (entry, index) => entry.points[index + 1].map((value, axis) => value - entry.points[index][axis]);
    const a = delta(hit.left, hit.leftSegment), b = delta(hit.right, hit.rightSegment);
    return a[0] * b[0] + a[1] * b[1] < 0;
  }).map(hit => ({relationships: [hit.left.relation, hit.right.relation].map(edge => ({from: edge.from, to: edge.to})),
    overlapPx: Math.round(hit.overlapLength), start: hit.overlapStart, end: hit.overlapEnd}));
  const [width, height] = layout.viewBox;
  const scale = candidate.meta.font_scale ?? 1;
  const texts = candidate.components.flatMap(node => {
    const sizes = componentTextGeometry(node, scale).sizes;
    return ['label', 'sublabel', 'tag'].filter(field => node[field]).map(field => ({
      owner: {kind: 'component', id: node.id, field}, text: node[field], sourcePx: sizes[field],
    }));
  }).concat((candidate.connections || []).filter(edge => edge.label).map(edge => ({
    owner: {kind: 'connection', from: edge.from, to: edge.to}, text: edge.label,
    sourcePx: edge.font_sizes?.label ?? 8 * scale,
  })));
  const minimumSourceTextPx = Math.min(...texts.map(text => text.sourcePx));
  const budget = declaredWideReadabilityBudget({viewBoxWidth: width, viewBoxHeight: height,
    minimumSourceTextPx, requestedMinimumTextPx: 7.5});
  const availableWidth = budget?.guaranteedSvgWidth ?? DESKTOP_READER_DIAGRAM_WIDTH;
  const projection = Math.min(1, availableWidth / width);
  const desktopText = texts.map(text => ({...text, projectedPx: Math.round(text.sourcePx * projection * 100) / 100}))
    .sort((a, b) => a.projectedPx - b.projectedPx).slice(0, 4);
  const estimatedDiagramHeightPx = Math.round(height * projection);
  const desktopFitTextPx = Math.round(minimumSourceTextPx * Math.min(projection, 774 / height) * 100) / 100;
  const score = counterflowCorridors.length * 3000 + crossings * 700
    + Math.max(0, 7.5 - desktopFitTextPx) * 1500 + Math.max(0, estimatedDiagramHeightPx - 774) * 3
    + bends * 8 + routeLength / 100 + width * height / 100000;
  return {width, height, crossings, bends, edgeCount: layout.connections.length, reading: readingMetrics(layout, candidate, intent), routeLength: Math.round(routeLength), counterflowCorridors,
    desktopText, estimatedDiagramHeightPx, desktopFitTextPx, score: Math.round(score * 100) / 100};
}
