import {architectureNodeBox} from '../renderers/shared/architecture-position.mjs';
import {minimumNodeTextWidth, nodeTextFit} from '../renderers/shared/text-fit.mjs';
import {labelGeometry} from '../renderers/shared/text-style.mjs';
import {GEOMETRY_FIELDS, extractSemantic, stableJSON} from '../draft/semantic.mjs';

const same = (a, b) => stableJSON(a) === stableJSON(b);
const boundaryKey = b => JSON.stringify([b.kind, b.label]);
const geometry = (owner, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(owner ?? {}, field)).map(field => [field, owner[field]]));
const fail = (code, message, subject = {}, evidence = {}) => {
  const error = Error(message); error.code = code;
  error.archifyDiagnostics = [{code, severity: 'error', message, subject, evidence,
    supportedFixes: ['preserve approved semantics and user-fixed geometry; correct the reported update or expand only the justified generated region']}];
  throw error;
};
const object = (value, fields, location) => {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !fields.includes(key))) {
    fail('update/geometry-policy', 'Unknown or invalid geometry-policy fields.', {location});
  }
};

// The policy is a declaration from the caller/producer, bound to actual baseline
// bytes. A generated declaration is not inferred from a coordinate or a name.
export function geometryPermissions(baseline, policy, baselineSha256, boundaryMappings = []) {
  const aliases = new Map(boundaryMappings.map(mapping => [boundaryKey(mapping.to), boundaryKey(mapping.from)]));
  const generated = {components: new Set(), connections: new Set(), boundaries: new Set()};
  const fixed = {components: new Map(), connections: new Map(), meta: new Set(), layout: false};
  if (policy !== undefined) {
    object(policy, ['schemaVersion', 'baselineSha256', 'origin', 'generated', 'fixed'], 'policy');
    if (policy.schemaVersion !== 1 || policy.baselineSha256 !== baselineSha256 || typeof policy.origin !== 'string' || !policy.origin.trim()) {
      fail('update/geometry-policy', 'Geometry policy must identify its origin and match the baseline hash.');
    }
    object(policy.generated ?? {}, ['components', 'connections', 'boundaries'], 'generated');
    for (const kind of ['components', 'connections', 'boundaries']) {
      const values = policy.generated?.[kind] ?? [];
      if (!Array.isArray(values)) fail('update/geometry-policy', 'Generated owners must be arrays.', {kind});
      const known = new Set((baseline[kind] ?? []).map(owner => kind === 'boundaries' ? boundaryKey(owner) : owner.id));
      for (const value of values) {
        const key = kind === 'boundaries' ? boundaryKey(value) : value;
        if (!known.has(key) || generated[kind].has(key)) fail('update/geometry-policy', 'Unknown or duplicate generated owner.', {kind, value});
        if (kind === 'boundaries') object(value, ['kind', 'label'], 'generated.boundaries');
        generated[kind].add(key);
      }
    }
    object(policy.fixed ?? {}, ['components', 'connections', 'meta', 'layout'], 'fixed');
    for (const kind of ['components', 'connections']) {
      const values = policy.fixed?.[kind] ?? [];
      if (!Array.isArray(values)) fail('update/geometry-policy', 'Fixed owners must be arrays.', {kind});
      for (const entry of values) {
        object(entry, ['id', 'fields'], 'fixed.' + kind);
        const fields = GEOMETRY_FIELDS[kind === 'components' ? 'component' : 'connection'];
        if (!(baseline[kind] ?? []).some(owner => owner.id === entry.id) || fixed[kind].has(entry.id)
          || !Array.isArray(entry.fields) || entry.fields.some(field => !fields.includes(field))) {
          fail('update/geometry-policy', 'Unknown fixed owner or geometry field.', {kind, entry});
        }
        fixed[kind].set(entry.id, new Set(entry.fields));
      }
    }
    if (policy.fixed?.meta !== undefined && (!Array.isArray(policy.fixed.meta) || policy.fixed.meta.some(field => field !== 'viewBox'))) {
      fail('update/geometry-policy', 'Only geometric metadata may be fixed.');
    }
    fixed.meta = new Set(policy.fixed?.meta ?? []);
    if (policy.fixed?.layout !== undefined && typeof policy.fixed.layout !== 'boolean') fail('update/geometry-policy', 'fixed.layout must be boolean.');
    fixed.layout = policy.fixed?.layout ?? false;
  }
  return {
    origin: policy?.origin ?? 'unknown-preserved', generated, fixed, boundaryMappings,
    canChange(kind, id, field) {
      if (kind === 'boundaries') id = aliases.get(id) ?? id;
      const existed = (baseline[kind] ?? []).some(owner => (kind === 'boundaries' ? boundaryKey(owner) : owner.id) === id);
      return !existed || (generated[kind].has(id) && !fixed[kind]?.get(id)?.has(field));
    },
  };
}

export function updateImpact(baseline, semantic) {
  const before = extractSemantic(baseline).semantic;
  const directNodes = new Set(), geometryRelevantNodes = new Set(), relatedNodes = new Set(), directEdges = new Set(), boundaries = new Set(), reasons = [];
  const previousNodes = new Map(before.components.map(node => [node.id, node]));
  const nextNodes = new Map(semantic.components.map(node => [node.id, node]));
  for (const id of new Set([...previousNodes.keys(), ...nextNodes.keys()])) {
    if (!same(previousNodes.get(id), nextNodes.get(id))) { directNodes.add(id); reasons.push({kind: 'content', node: id}); }
    const old = previousNodes.get(id), next = nextNodes.get(id);
    if (!old || !next || ['label', 'sublabel', 'tag', 'font_sizes', 'icon', 'brand'].some(field => !same(old[field], next[field]))) geometryRelevantNodes.add(id);
  }
  const previousEdges = new Map((before.connections ?? []).map(edge => [edge.id, edge]));
  const nextEdges = new Map((semantic.connections ?? []).map(edge => [edge.id, edge]));
  for (const id of new Set([...previousEdges.keys(), ...nextEdges.keys()])) if (!same(previousEdges.get(id), nextEdges.get(id))) {
    directEdges.add(id);
    for (const edge of [previousEdges.get(id), nextEdges.get(id)].filter(Boolean)) { relatedNodes.add(edge.from); relatedNodes.add(edge.to); }
    reasons.push({kind: 'relationship-content', edge: id});
  }
  for (const id of directNodes) relatedNodes.add(id);
  const beforeBoundaries = new Map((before.boundaries ?? []).map(boundary => [boundaryKey(boundary), boundary]));
  for (const boundary of semantic.boundaries ?? []) {
    const key = boundaryKey(boundary);
    if (!same(beforeBoundaries.get(key), boundary)) {
      boundaries.add(key); for (const id of [...(boundary.wraps ?? []), ...(beforeBoundaries.get(key)?.wraps ?? [])]) relatedNodes.add(id);
      reasons.push({kind: 'boundary-content', boundary: {kind: boundary.kind, label: boundary.label}});
    }
  }
  for (const boundary of before.boundaries ?? []) if (!(semantic.boundaries ?? []).some(next => boundaryKey(next) === boundaryKey(boundary))) {
    boundaries.add(boundaryKey(boundary)); for (const id of boundary.wraps) relatedNodes.add(id);
    reasons.push({kind: 'boundary-removed-or-renamed', boundary: {kind: boundary.kind, label: boundary.label}});
  }
  const globalText = !same(before.meta.font_scale, semantic.meta.font_scale) || !same(before.meta.font_sizes, semantic.meta.font_sizes)
    || !same(before.meta.line_scale, semantic.meta.line_scale) || !same(before.meta.arrow_scale, semantic.meta.arrow_scale);
  if (globalText) {
    for (const node of semantic.components) relatedNodes.add(node.id);
    reasons.push({kind: 'global-geometry-style', fields: ['font_scale', 'font_sizes', 'line_scale', 'arrow_scale']});
  }
  return {directNodes: [...directNodes], geometryRelevantNodes: [...geometryRelevantNodes], relatedNodes: [...relatedNodes], directEdges: [...directEdges],
    boundaries: [...boundaries], reasons, globalStyle: globalText,
    contentChanged: !same(before, semantic)};
}

function textSize(node, spec, {fresh = true} = {}) {
  const scale = spec.meta.font_scale ?? 1;
  const keys = ['label', ...(node.sublabel ? ['sublabel'] : []), ...(node.tag ? ['tag'] : [])];
  const sizes = {label: node.font_sizes?.label ?? spec.meta.font_sizes?.label ?? 11 * scale,
    sublabel: node.font_sizes?.sublabel ?? spec.meta.font_sizes?.sublabel ?? 9 * scale,
    tag: node.font_sizes?.tag ?? spec.meta.font_sizes?.tag ?? 7 * scale};
  return [Math.ceil(Math.max(fresh ? 120 : 0, ...keys.map(key => minimumNodeTextWidth(node[key], sizes[key]) + nodeTextFit.horizontalPadding + 16))),
    Math.ceil(Math.max(fresh ? 72 : 0, keys.reduce((sum, key) => sum + sizes[key] * 1.3 + 4, 0) + 32))];
}
const overlaps = (a, b, gap = 28) => a[0] < b[0] + b[2] + gap && a[0] + a[2] + gap > b[0]
  && a[1] < b[1] + b[3] + gap && a[1] + a[3] + gap > b[1];
const box = node => [...node.pos, ...node.size];

function seedNodes(candidate, baseline, permission, scope, ledger) {
  const oldNodes = new Map(baseline.components.map(node => [node.id, node]));
  for (const node of candidate.components) {
    const old = oldNodes.get(node.id), required = textSize(node, candidate, {fresh: !old});
    if (old) {
      const resolved = architectureNodeBox(old, baseline);
      node.pos ??= [resolved.x, resolved.y]; node.size ??= [resolved.w, resolved.h];
      if (!scope.has(node.id)) continue;
      const nextSize = node.size.map((size, i) => Math.max(size, required[i]));
      if (!same(nextSize, node.size)) {
        if (!permission.canChange('components', node.id, 'size')) fail('update/fixed-text-size', 'Complete text needs more room in a fixed node.', {node: node.id}, {size: node.size, required});
        ledger.push({kind: 'resize-text', node: node.id, from: [...node.size], to: nextSize}); node.size = nextSize;
      }
    } else node.size = required;
  }
  for (const node of candidate.components.filter(node => !node.pos)) {
    const edges = (candidate.connections ?? []).filter(edge => edge.from === node.id || edge.to === node.id);
    const neighbors = edges.map(edge => candidate.components.find(other => other.id === (edge.from === node.id ? edge.to : edge.from))).filter(other => other?.pos);
    const anchor = neighbors[0] ?? candidate.components.find(other => other.pos);
    if (!anchor) { node.pos = [60, 80]; continue; }
    // A new peer on the same row should share its anchor's centerline. Keep
    // existing boxes untouched and grow only the new box when needed.
    node.size[1] = Math.max(node.size[1], anchor.size[1]);
    const placed = candidate.components.filter(other => other !== node && other.pos);
    const maxX = Math.max(...placed.map(other => other.pos[0] + other.size[0]));
    const maxY = Math.max(...placed.map(other => other.pos[1] + other.size[1]));
    const gapX = Math.max(88, ...edges.map(edge => edge.label ? labelGeometry(edge.label, edge.font_sizes?.label ?? 8 * (candidate.meta.font_scale ?? 1), [0, 0]).width + 40 : 0));
    const options = [[anchor.pos[0] + anchor.size[0] + gapX, anchor.pos[1]],
      [anchor.pos[0], anchor.pos[1] + anchor.size[1] + 100], [maxX + gapX, anchor.pos[1]],
      [anchor.pos[0] - node.size[0] - gapX, anchor.pos[1]], [anchor.pos[0], maxY + 100]];
    const possible = options.filter(point => point[0] >= 40 && point[1] >= 60
      && !placed.some(other => overlaps([...point, ...node.size], box(other))));
    possible.sort((a, b) => Math.hypot(a[0] - anchor.pos[0], a[1] - anchor.pos[1]) - Math.hypot(b[0] - anchor.pos[0], b[1] - anchor.pos[1]));
    node.pos = possible[0] ?? [maxX + gapX, maxY + 100];
    ledger.push({kind: 'place-new-node', node: node.id, anchor: anchor.id, to: [...node.pos]});
  }
}

function reserveChangedLabelSpace(candidate, baseline, permission, scope, ledger) {
  for (const edge of candidate.connections ?? []) {
    const old = (baseline.connections ?? []).find(item => item.id === edge.id);
    if (!old || !edge.label || (same(old.label, edge.label) && same(old.font_sizes, edge.font_sizes)
      && same(baseline.meta.font_scale, candidate.meta.font_scale))) continue;
    const source = candidate.components.find(node => node.id === edge.from);
    const target = candidate.components.find(node => node.id === edge.to);
    if (!source?.pos || !target?.pos) continue;
    const horizontal = Math.abs(source.pos[1] + source.size[1] / 2 - target.pos[1] - target.size[1] / 2) < 1;
    if (!horizontal || target.pos[0] <= source.pos[0] + source.size[0]) continue;
    const required = Math.ceil(labelGeometry(edge.label, edge.font_sizes?.label ?? 8 * (candidate.meta.font_scale ?? 1), [0, 0]).width + 40);
    const gap = target.pos[0] - source.pos[0] - source.size[0];
    if (gap >= required) continue;
    // Preserve the suffix's internal alignment (including shared outputs)
    // rather than creating a dogleg after moving only this target. Cycles
    // cannot use this acyclic local translation and retain canonical routing.
    const tail = new Set([target.id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const relation of candidate.connections ?? []) if (tail.has(relation.from) && !tail.has(relation.to)) {
        tail.add(relation.to); changed = true;
      }
    }
    if (tail.has(source.id)) continue;
    const shift = required - gap;
    const movers = candidate.components.filter(node => tail.has(node.id));
    if (movers.some(node => !permission.canChange('components', node.id, 'pos'))) {
      fail('update/fixed-label-channel', 'A changed label needs additional space beside fixed downstream geometry.',
        {edge: edge.id, nodes: movers.map(node => node.id)}, {gap, required});
    }
    for (const node of movers) {
      const next = [node.pos[0] + shift, node.pos[1]];
      ledger.push({kind: 'changed-label-channel', edge: edge.id, node: node.id, from: [...node.pos], to: next,
        evidence: {gap, required, shift, reason: 'measured changed label; preserve downstream alignment'}});
      node.pos = next; scope.add(node.id);
    }
  }
}

function sharedGroups(candidate, baseline) {
  const groups = [];
  for (const node of baseline.components) {
    const edges = (baseline.connections ?? []).filter(edge => edge.from === node.id);
    if (edges.length < 2) continue;
    const targets = edges.map(edge => baseline.components.find(target => target.id === edge.to));
    if (targets.some(target => !target?.pos || !target.size) || !node.pos || !node.size) continue;
    const left = Math.min(...targets.map(target => target.pos[0]));
    const right = Math.max(...targets.map(target => target.pos[0] + target.size[0]));
    if (targets.every(target => target.pos[1] === targets[0].pos[1] && target.pos[1] > node.pos[1])
      && node.size[0] >= (right - left) * 0.75) {
      const current = candidate.components.find(item => item.id === node.id);
      const currentEdges = (candidate.connections ?? []).filter(edge => edge.from === node.id);
      const currentTargets = currentEdges.map(edge => candidate.components.find(target => target.id === edge.to));
      if (current && currentTargets.length >= 2 && currentTargets.every(Boolean) && new Set(currentTargets.map(target => target.id)).size === currentTargets.length) groups.push({source: current, targets: currentTargets, edges: currentEdges});
    }
  }
  return groups;
}

function layoutShared(candidate, baseline, permission, scope, ledger, expandedNodes) {
  for (const group of sharedGroups(candidate, baseline)) {
    if (!scope.has(group.source.id) && !group.targets.some(target => scope.has(target.id))) continue;
    const old = baseline.components.find(node => node.id === group.source.id);
    const oldTargets = (baseline.connections ?? []).filter(edge => edge.from === old.id).map(edge => baseline.components.find(node => node.id === edge.to));
    const owners = group.targets.map(target => stableJSON((candidate.boundaries ?? []).filter(boundary => boundary.wraps.includes(target.id)).map(boundaryKey).sort()));
    if (new Set(owners).size > 1) continue; // A migrated consumer is no longer one shared row.
    const changedGroup = !same(oldTargets.map(node => node.id), group.targets.map(node => node.id))
      || group.targets.some(target => {const prior = oldTargets.find(node => node.id === target.id); return !prior || !same(prior.size, target.size);});
    const diagnosed = expandedNodes.some(id => id === group.source.id || group.targets.some(target => target.id === id));
    if (!changedGroup && !diagnosed) continue;
    const center = old.pos[0] + old.size[0] / 2;
    const widths = group.targets.map(target => target.size[0]);
    const sortedOld = [...oldTargets].sort((a, b) => a.pos[0] - b.pos[0]);
    const oldGaps = sortedOld.slice(1).map((target, index) => target.pos[0] - sortedOld[index].pos[0] - sortedOld[index].size[0]);
    const gap = Math.max(48, oldGaps.length ? oldGaps.reduce((sum, value) => sum + value, 0) / oldGaps.length : 88);
    const width = widths.reduce((sum, value) => sum + value, 0) + gap * (widths.length - 1);
    let x = Math.max(40, center - width / 2);
    const y = Math.max(...group.targets.filter(target => baseline.components.some(oldNode => oldNode.id === target.id)).map(target => target.pos[1]), group.source.pos[1] + group.source.size[1] + 120);
    const left = x;
    for (const target of group.targets) {
      const next = [Math.round(x), y];
      if (!same(target.pos, next)) {
        if (!permission.canChange('components', target.id, 'pos')) fail('update/fixed-shared-target', 'A shared group needs a fixed target to move.', {node: target.id});
        ledger.push({kind: 'shared-group-alignment', node: target.id, from: target.pos, to: next, owner: group.source.id});
        target.pos = next;
      }
      scope.add(target.id); x += target.size[0] + gap;
    }
    const size = [Math.max(width, textSize(group.source, candidate)[0]), group.source.size[1]];
    const pos = [Math.round(left + (width - size[0]) / 2), group.source.pos[1]];
    for (const [field, value] of [['pos', pos], ['size', size]]) if (!same(group.source[field], value)) {
      if (!permission.canChange('components', group.source.id, field)) fail('update/fixed-shared-source', 'A shared source has fixed geometry.', {node: group.source.id, field});
      ledger.push({kind: 'shared-source-span', node: group.source.id, field, from: group.source[field], to: value}); group.source[field] = value;
    }
    scope.add(group.source.id);
    for (let index = 0; index < group.edges.length; index++) {
      const edge = group.edges[index], target = group.targets[index];
      const desired = {fromSide: 'bottom', toSide: 'top', fromPort: [(target.pos[0] + target.size[0] / 2 - group.source.pos[0]) / group.source.size[0], 1], toPort: [0.5, 0]};
      for (const [field, value] of Object.entries(desired)) {
        if (permission.canChange('connections', edge.id, field)) edge[field] = value;
        else if (Object.hasOwn(edge, field) && !same(edge[field], value)) fail('update/fixed-shared-port', 'Shared output conflicts with fixed ports.', {edge: edge.id, field});
      }
    }
  }
}

function rehomeMigratedMembers(candidate, baseline, permission, scope, ledger) {
  for (const boundary of candidate.boundaries ?? []) {
    const prior = (baseline.boundaries ?? []).find(item => boundaryKey(item) === boundaryKey(boundary))
      ?? [...(baseline.boundaries ?? [])].sort((a, b) => b.wraps.filter(id => boundary.wraps.includes(id)).length - a.wraps.filter(id => boundary.wraps.includes(id)).length)[0];
    if (!prior) continue;
    const anchors = boundary.wraps.filter(id => prior.wraps.includes(id)).map(id => candidate.components.find(node => node.id === id)).filter(Boolean);
    if (!anchors.length) continue;
    for (const id of boundary.wraps.filter(id => !prior.wraps.includes(id) && baseline.components.some(node => node.id === id))) {
      const node = candidate.components.find(item => item.id === id);
      if (!node || !scope.has(id)) continue;
      const right = Math.max(...anchors.map(item => item.pos[0] + item.size[0]));
      const relation = (candidate.connections ?? []).find(edge => edge.to === id && anchors.some(anchor => anchor.id === edge.from));
      const anchor = anchors.find(item => item.id === relation?.from) ?? anchors[0];
      const next = [right + 100, anchor.pos[1]];
      if (!same(node.pos, next)) {
        if (!permission.canChange('components', id, 'pos')) fail('update/fixed-migrated-member', 'Ownership migration conflicts with a fixed position.', {node: id});
        ledger.push({kind: 'ownership-migration', node: id, boundary: [boundary.kind, boundary.label], from: node.pos, to: next}); node.pos = next;
      }
    }
  }
}

export function incrementalCandidate(baseline, updated, {permission, impact, expandedNodes = [], round = 0} = {}) {
  const candidate = structuredClone(updated), ledger = [];
  const scope = new Set([...impact.relatedNodes, ...expandedNodes]);
  const measureScope = new Set([...(impact.globalStyle ? impact.relatedNodes : impact.geometryRelevantNodes ?? impact.directNodes), ...expandedNodes]);
  seedNodes(candidate, baseline, permission, measureScope, ledger);
  rehomeMigratedMembers(candidate, baseline, permission, scope, ledger);
  layoutShared(candidate, baseline, permission, scope, ledger, expandedNodes);
  reserveChangedLabelSpace(candidate, baseline, permission, scope, ledger);
  // In a diagnosed repair round, preserve row order and push only conflicting
  // authorized boxes. This is a connected-region repair, never a global grid.
  if (round > 0) {
    const ordered = [...candidate.components].sort((a, b) => a.pos[1] - b.pos[1] || a.pos[0] - b.pos[0] || a.id.localeCompare(b.id, 'en'));
    for (let pass = 0; pass < candidate.components.length; pass++) for (let i = 0; i < ordered.length; i++) {
      const node = ordered[i];
      if (!scope.has(node.id) || !permission.canChange('components', node.id, 'pos')) continue;
      const blocker = ordered.find((other, j) => j < i && overlaps(box(node), box(other), 44));
      if (blocker) {
        const next = [blocker.pos[0] + blocker.size[0] + 100, node.pos[1]];
        ledger.push({kind: 'diagnosed-region-collision', node: node.id, blocker: blocker.id, from: [...node.pos], to: next}); node.pos = next;
      }
    }
  }
  // Existing generated routes are cleared only for a changed relationship or
  // an affected endpoint. Unknown/user-authored geometry stays authoritative.
  const changedGeometry = new Set(candidate.components.filter(node => {
    const old = baseline.components.find(item => item.id === node.id); if (!old) return true;
    const resolved = architectureNodeBox(old, baseline);
    return !same(node.pos, [resolved.x, resolved.y]) || !same(node.size, [resolved.w, resolved.h]);
  }).map(node => node.id));
  const cleared = [];
  for (const edge of candidate.connections ?? []) if (impact.directEdges.includes(edge.id) || changedGeometry.has(edge.from) || changedGeometry.has(edge.to)) {
    for (const field of GEOMETRY_FIELDS.connection) if (Object.hasOwn(edge, field) && permission.canChange('connections', edge.id, field)) {
      cleared.push({owner: 'connection', id: edge.id, field, value: edge[field]}); delete edge[field];
    }
  }
  for (const boundary of candidate.boundaries ?? []) {
    if (!impact.boundaries.includes(boundaryKey(boundary)) && !boundary.wraps.some(id => changedGeometry.has(id))) continue;
    for (const field of GEOMETRY_FIELDS.boundary) if (Object.hasOwn(boundary, field) && permission.canChange('boundaries', boundaryKey(boundary), field)) {
      cleared.push({owner: 'boundary', key: [boundary.kind, boundary.label], field, value: boundary[field]}); delete boundary[field];
    }
  }
  // Reapply the verified shared-row attachments after invalidated routes have
  // been removed. Unchanged groups keep their original attachments byte-for-byte.
  for (const group of sharedGroups(candidate, baseline)) {
    if (!changedGeometry.has(group.source.id) && !group.targets.some(target => changedGeometry.has(target.id))
      && !group.edges.some(edge => impact.directEdges.includes(edge.id))) continue;
    const owners = group.targets.map(target => stableJSON((candidate.boundaries ?? []).filter(boundary => boundary.wraps.includes(target.id)).map(boundaryKey).sort()));
    if (new Set(owners).size > 1 || !group.targets.every(target => target.pos[1] === group.targets[0].pos[1] && target.pos[1] > group.source.pos[1])) continue;
    for (let index = 0; index < group.edges.length; index++) {
      const edge = group.edges[index], target = group.targets[index];
      const desired = {fromSide: 'bottom', toSide: 'top', fromPort: [(target.pos[0] + target.size[0] / 2 - group.source.pos[0]) / group.source.size[0], 1], toPort: [0.5, 0]};
      for (const [field, value] of Object.entries(desired)) if (permission.canChange('connections', edge.id, field)) edge[field] = value;
    }
  }
  // Temporary resolved defaults are useful for computation, but adding them
  // to an unchanged grid/default-size owner would alter authored geometry.
  for (const node of candidate.components) {
    const old = baseline.components.find(item => item.id === node.id); if (!old) continue;
    const resolved = architectureNodeBox(old, baseline);
    if (!Object.hasOwn(old, 'pos') && same(node.pos, [resolved.x, resolved.y])) delete node.pos;
    if (!Object.hasOwn(old, 'size') && same(node.size, [resolved.w, resolved.h])) delete node.size;
  }
  const changedIncidence = new Set();
  for (const node of candidate.components) {
    const incidence = spec => (spec.connections ?? []).filter(edge => edge.from === node.id || edge.to === node.id).map(edge => [edge.id, edge.from, edge.to]);
    if (!same(incidence(baseline), incidence(candidate))) changedIncidence.add(node.id);
  }
  const attachmentEdges = (candidate.connections ?? []).filter(edge => impact.directEdges.includes(edge.id) || changedGeometry.has(edge.from)
    || changedGeometry.has(edge.to) || changedIncidence.has(edge.from) || changedIncidence.has(edge.to)).map(edge => edge.id);
  return {candidate, impact: {...impact, relatedNodes: [...scope]}, ledger, cleared, attachmentEdges};
}

export function assertFixedGeometry(baseline, candidate, permission) {
  for (const [kind, fields] of [['components', GEOMETRY_FIELDS.component], ['connections', GEOMETRY_FIELDS.connection], ['boundaries', GEOMETRY_FIELDS.boundary]]) {
    for (const owner of baseline[kind] ?? []) {
      const key = kind === 'boundaries' ? boundaryKey(owner) : owner.id;
      const mapping = kind === 'boundaries' && permission.boundaryMappings.find(item => boundaryKey(item.from) === key);
      const nextKey = mapping ? boundaryKey(mapping.to) : key;
      const next = (candidate[kind] ?? []).find(value => (kind === 'boundaries' ? boundaryKey(value) : value.id) === nextKey);
      if (!next) continue; // Approved removal/rename is owned by the content gate.
      for (const field of fields) if (!permission.canChange(kind, nextKey, field) && !same(owner[field], next[field])) {
        // Materializing default grid coordinates/sizes is a change as well.
        fail('update/fixed-geometry', 'The update changed geometry without producer/user authorization.', {kind, id: key, field}, {before: owner[field], after: next[field]});
      }
    }
  }
  if (!same(baseline.layout, candidate.layout)) fail('update/fixed-layout', 'Incremental updates preserve the authored grid layout.');
  if (!same(baseline.meta.viewBox, candidate.meta.viewBox)) fail('update/fixed-viewbox', 'Incremental updates preserve authored canvas bounds.');
  return true;
}

function canonicalRelation(candidate, relation, index) { return {id: candidate.connections?.[index]?.id ?? `index:${index}`, ...relation}; }
export function geometryDifference(baseline, candidate, before, after, impact) {
  if ((baseline.connections ?? []).some(edge => !edge.id)
    && !same(baseline.connections, candidate.connections)) fail('update/ambiguous-relationship-identity',
      'Legacy relationships without stable IDs cannot be geometrically matched after authored relationship changes.');
  const prior = new Map(before.components.map(node => [node.id, node]));
  const expected = new Set(impact.relatedNodes), nodes = [];
  for (const node of after.components) {
    const old = prior.get(node.id); if (!old) continue;
    const a = [old.x, old.y, old.width, old.height], b = [node.x, node.y, node.width, node.height];
    if (!same(a, b)) nodes.push({id: node.id, before: a, after: b, displacement: Math.hypot(b[0] - a[0], b[1] - a[1]),
      explanation: expected.has(node.id) ? 'approved-or-diagnosed-region' : 'unexplained'});
  }
  const oldRelations = new Map(before.connections.map((edge, index) => { const item = canonicalRelation(baseline, edge, index); return [item.id, item]; }));
  const edges = [];
  for (const [index, relation] of after.connections.entries()) {
    const next = canonicalRelation(candidate, relation, index), old = oldRelations.get(next.id); if (!old) continue;
    const oldLabel = before.labels?.find(label => label.text === old.label && same(label.labelAt, old.labelAt));
    const nextLabel = after.labels?.find(label => label.text === next.label && same(label.labelAt, next.labelAt));
    if (!same(old.points, next.points) || !same(old.labelAt, next.labelAt) || !same(oldLabel, nextLabel)) {
      edges.push({id: next.id, before: {points: old.points, labelAt: old.labelAt, label: oldLabel}, after: {points: next.points, labelAt: next.labelAt, label: nextLabel},
        explanation: impact.directEdges.includes(next.id) || expected.has(next.from) || expected.has(next.to) ? 'approved-or-diagnosed-region' : 'unexplained-resolved-route'});
    }
  }
  const oldBoundaries = new Map((before.boundaries ?? []).map(owner => [boundaryKey(owner), owner]));
  const boundaries = (after.boundaries ?? []).filter(owner => oldBoundaries.has(boundaryKey(owner)) && !same(owner, oldBoundaries.get(boundaryKey(owner))))
    .map(owner => ({key: [owner.kind, owner.label], before: oldBoundaries.get(boundaryKey(owner)), after: owner,
      explanation: owner.wraps.some(id => expected.has(id)) ? 'approved-or-diagnosed-region' : 'unexplained-boundary'}));
  return {nodes, connections: edges, boundaries, viewBox: {before: before.viewBox, after: after.viewBox},
    unchangedNodeCount: after.components.filter(node => prior.has(node.id)).length - nodes.length,
    unexplained: [...nodes, ...edges, ...boundaries].filter(item => item.explanation.startsWith('unexplained')),
    interpretation: 'Resolved canonical geometry, including automatic routes and label anchors; viewport pixel changes are not aesthetic acceptance.'};
}

export function diagnosticRegion(diagnostics, candidate) {
  const ids = new Set();
  const known = new Set(candidate.components.map(node => node.id));
  function visit(value, key = '') {
    if (typeof value === 'string' && known.has(value) && ['node', 'nodeId', 'nodes', 'component', 'components', 'componentId', 'from', 'to', 'id'].includes(key)) ids.add(value);
    if (Array.isArray(value)) for (const entry of value) visit(entry, key);
    else if (value && typeof value === 'object') for (const [field, entry] of Object.entries(value)) visit(entry, field);
  }
  for (const diagnostic of diagnostics) { visit(diagnostic.subject); visit(diagnostic.evidence); }
  return [...ids];
}
