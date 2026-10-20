import { createHash } from 'node:crypto';
import { parse, serialize } from 'parse5';

const SVG = 'http://www.w3.org/2000/svg';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const attrs = (node) => Object.fromEntries((node.attrs || []).map(({ name, value }) => [name.toLowerCase(), value]));
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const stable = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => order(a, b))) : item);
const equal = (a, b) => stable(a) === stable(b);
const boundaryKey = ({ kind, label }) => JSON.stringify([kind, label]);
const pointer = (value) => String(value).replaceAll('~', '~0').replaceAll('/', '~1');
const diagnostic = (code, message, subject = {}, evidence = {}) => ({
  code, severity: 'warning', message, subject, evidence,
  supportedFixes: ['compare artifacts with unique authored stable IDs and the same canonical renderer', 'explain affected owners and inspect the matching rendered screenshots'],
});

function* descendants(node) {
  for (const child of node.childNodes || []) { yield child; yield* descendants(child); }
}
const text = (node) => node.nodeName === '#text' ? node.value : (node.childNodes || []).map(text).join('');
const svgElements = (node) => [...descendants(node)].filter((item) => item.namespaceURI === SVG);
const numbers = (value) => value === undefined ? undefined : String(value).trim().split(/[\s,]+/).map(Number);
const number = (value) => value !== undefined && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : value;
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
const geometryKeys = ['x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'dx', 'dy', 'textlength', 'lengthadjust', 'pathlength'];
const presentationKeys = ['class', 'id', 'color', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'vector-effect', 'paint-order',
  'font-size', 'font-family', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'opacity', 'display', 'visibility', 'marker-start', 'marker-mid', 'marker-end', 'filter', 'clip-path', 'mask', 'href'];

function declarations(value = '') {
  const result = {};
  for (const declaration of value.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    // Animation scheduling is viewer state, not a change to the drawn graph.
    if (property === '--step' || property.startsWith('animation') || property.startsWith('transition')) continue;
    result[property] = declaration.slice(colon + 1).trim();
  }
  return result;
}

function transformChain(node, root) {
  const transforms = [];
  for (let current = node; current && current.namespaceURI === SVG; current = current.parentNode) {
    const value = attrs(current), style = declarations(value.style);
    if (value.transform !== undefined || style.transform !== undefined || style['transform-origin'] !== undefined) {
      transforms.unshift({ ...(value.transform !== undefined ? { attribute: value.transform } : {}), ...pick(style, ['transform', 'transform-origin']) });
    }
    if (current === root) break;
  }
  return transforms;
}

function geometry(node, root) {
  const value = attrs(node);
  return {
    ...Object.fromEntries(Object.entries(pick(value, geometryKeys)).map(([key, item]) => [key, number(item)])),
    ...(value.d !== undefined ? { d: value.d } : {}),
    ...(value.points !== undefined ? { points: numbers(value.points) } : {}),
    ...(value.viewbox !== undefined ? { viewBox: numbers(value.viewbox) } : {}),
    ...(value.preserveaspectratio !== undefined ? { preserveAspectRatio: value.preserveaspectratio } : {}),
    ...(value['data-composition-points'] !== undefined ? { routePoints: value['data-composition-points'].trim().split(/[;\s]+/).map((point) => numbers(point)) } : {}),
    transforms: transformChain(node, root),
  };
}

function presentation(node) {
  const value = attrs(node), style = declarations(value.style);
  delete style.transform; delete style['transform-origin'];
  const inherit = [];
  for (let current = node.parentNode; current?.namespaceURI === SVG; current = current.parentNode) {
    const inherited = attrs(current);
    const properties = pick(inherited, ['class', 'id', 'fill', 'stroke', 'color', 'font-size', 'font-family', 'font-weight', 'opacity', 'visibility', 'display']);
    const inline = declarations(inherited.style);
    delete inline.transform; delete inline['transform-origin'];
    if (Object.keys(properties).length || Object.keys(inline).length) inherit.unshift({ ...properties, ...(Object.keys(inline).length ? { style: inline } : {}) });
  }
  return {
    ...pick(value, presentationKeys), ...(Object.keys(style).length ? { style } : {}),
    ...(inherit.length ? { inheritedAttributes: inherit } : {}),
    ...(value.fill || style.fill ? { authoredFill: style.fill || value.fill } : {}),
  };
}

const graphicTags = new Set(['rect', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textPath', 'image', 'use', 'svg']);
function graphics(node, root) {
  const items = svgElements(node).filter((item) => graphicTags.has(item.tagName));
  return {
    geometry: items.map((item) => ({ element: item.tagName, ...geometry(item, root) })),
    presentation: items.map((item) => ({ element: item.tagName, ...presentation(item) })),
    content: items.filter((item) => item.tagName === 'text').map((item) => ({
      role: Object.hasOwn(attrs(item), 'data-node-label') ? 'label' : attrs(item)['data-text-field'] || 'text', text: text(item),
    })),
  };
}

function unique(items, identity, diagnostics, kind) {
  const counts = new Map();
  for (const item of items) {
    const id = identity(item);
    if (!id) diagnostics.push(diagnostic('artifact/stable-id-required', `A ${kind} has no stable authored identity; array positions are not matched.`, { kind }));
    else counts.set(id, (counts.get(id) || 0) + 1);
  }
  for (const [id, count] of counts) if (count > 1) diagnostics.push(diagnostic('artifact/identity-ambiguous', `Multiple ${kind} objects share one identity.`, { kind, id }, { count }));
}

/** Read only canonical primary SVG markup. This is not browser computed layout,
 * text bounding-box measurement, visual acceptance, or evidence of delivery. */
export function extractArtifactGeometry(html) {
  const document = parse(String(html));
  const all = [...descendants(document)];
  const candidates = all.filter((node) => node.tagName === 'svg' && node.namespaceURI === SVG
    && attrs(node).role === 'img' && String(attrs(node)['aria-labelledby'] || '').split(/\s+/).includes('archify-diagram-title'));
  if (candidates.length !== 1) {
    const error = new Error('Expected exactly one canonical Architecture primary SVG.');
    error.code = 'artifact/primary-svg-ambiguous';
    error.archifyDiagnostics = [diagnostic(error.code, error.message, {}, { count: candidates.length })];
    throw error;
  }
  const root = candidates[0], elements = svgElements(root), diagnostics = [];
  const viewBox = numbers(attrs(root).viewbox);
  if (!Array.isArray(viewBox) || viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value)) || viewBox[2] <= 0 || viewBox[3] <= 0) {
    diagnostics.push(diagnostic('artifact/viewbox-invalid', 'The primary SVG needs a finite four-number viewBox.', { kind: 'viewport' }, { value: attrs(root).viewbox }));
  }
  const nodes = elements.filter((node) => node.tagName === 'g' && Object.hasOwn(attrs(node), 'data-node-id')).map((node) => {
    const value = attrs(node), captured = graphics(node, root);
    return { id: value['data-node-id'], kind: value['data-node-kind'], ...captured };
  });
  if (!nodes.length) diagnostics.push(diagnostic('artifact/nodes-missing', 'No Architecture component identities were found in the primary SVG.'));
  const paths = elements.filter((node) => node.tagName === 'path' && Object.hasOwn(attrs(node), 'data-edge-from'));
  const labelGroups = elements.filter((node) => node.tagName === 'g' && Object.hasOwn(attrs(node), 'data-edge-from'));
  const edges = paths.map((node) => {
    const value = attrs(node);
    const route = geometry(node, root);
    if (!route.d || /\b(?:NaN|Infinity)\b/.test(route.d) || route.routePoints?.some((point) => point.length !== 2 || point.some((coordinate) => !Number.isFinite(coordinate)))) {
      diagnostics.push(diagnostic('artifact/route-invalid', 'An edge path or its canonical route points are missing or non-finite.', { id: value['data-edge-id'] || null }, { d: route.d, routePoints: value['data-composition-points'] }));
    }
    const labels = labelGroups.filter((group) => value['data-edge-id'] && attrs(group)['data-edge-id'] === value['data-edge-id']);
    if (labels.length > 1) diagnostics.push(diagnostic('artifact/edge-label-ambiguous', 'More than one label group matches the authored edge ID.', { id: value['data-edge-id'] }));
    return {
      id: value['data-edge-id'] || null, from: value['data-edge-from'], to: value['data-edge-to'],
      geometry: { path: route, labels: labels.map((group) => graphics(group, root).geometry) },
      presentation: { path: presentation(node), labels: labels.map((group) => graphics(group, root).presentation) },
      content: { label: value['data-edge-label'] || '', labels: labels.map((group) => text(group).trim()) },
    };
  });
  for (const label of labelGroups) {
    const id = attrs(label)['data-edge-id'];
    if (!id || !edges.some((edge) => edge.id === id)) diagnostics.push(diagnostic('artifact/edge-label-identity-missing', 'A label has no uniquely identified path; it cannot be compared by array index.', { id: id || null }));
  }
  const frames = elements.filter((node) => attrs(node)['data-graph-role'] === 'structural-frame');
  const titles = elements.filter((node) => attrs(node)['data-graph-role'] === 'structural-frame-label');
  const boundaries = frames.map((node) => {
    const value = attrs(node), identity = { kind: value['data-composition-frame-kind'], label: value['data-composition-frame-label'] };
    const labels = titles.filter((title) => {
      const item = attrs(title);
      return item['data-composition-frame-kind'] === identity.kind && item['data-composition-frame-label'] === identity.label;
    });
    if (labels.length !== 1) diagnostics.push(diagnostic('artifact/boundary-title-ambiguous', 'A boundary must match exactly one title by kind + label.', identity, { count: labels.length }));
    return { ...identity, geometry: { frame: geometry(node, root), titles: labels.map((title) => graphics(title, root).geometry) },
      presentation: { frame: presentation(node), titles: labels.map((title) => graphics(title, root).presentation) },
      content: labels.map((label) => text(label).trim()) };
  });
  for (const title of titles) {
    const value = attrs(title);
    if (!boundaries.some((boundary) => boundary.kind === value['data-composition-frame-kind'] && boundary.label === value['data-composition-frame-label'])) {
      diagnostics.push(diagnostic('artifact/boundary-title-orphan', 'A boundary title has no matching structural frame.', { kind: value['data-composition-frame-kind'], label: value['data-composition-frame-label'] }));
    }
  }
  unique(nodes, (node) => node.id, diagnostics, 'node');
  unique(edges, (edge) => edge.id, diagnostics, 'edge');
  unique(boundaries, (boundary) => boundary.kind && boundary.label ? boundaryKey(boundary) : null, diagnostics, 'boundary');
  const stylesheets = all.filter((node) => node.tagName === 'style').map((node) => hash(text(node)));
  return { schemaVersion: 1, inspection: 'canonical-svg-static', htmlSha256: hash(String(html)),
    viewport: { viewBox, transforms: transformChain(root, root) },
    presentation: { ...pick(attrs(root), ['class', 'lang', 'data-preset', 'data-engineering-profile']), ...presentation(root) },
    definitions: elements.filter((node) => node.tagName === 'defs').map((node) => hash(serialize(node))),
    nodes, edges, boundaries, stylesheets, diagnostics, complete: diagnostics.length === 0,
    styleResolution: 'SVG attributes, inline declarations, and inherited attributes; CSS references are retained, not browser computed colors',
  };
}

function changedFields(before, after, prefix = '') {
  if (equal(before, after)) return [];
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object'
    || Array.isArray(before) || Array.isArray(after)) return [prefix || '/'];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(order)
    .flatMap((key) => changedFields(before[key], after[key], `${prefix}/${pointer(key)}`));
}

/** Compare delivered HTML without invoking render/finalize or touching files.
 * Affected lists declare scope; they do not certify necessity or aesthetics. */
export function auditArtifactGeometry(baseHtml, headHtml, {
  affectedNodes = [], affectedEdges = [], affectedBoundaries = [], boundaryMappings = [], viewportChangeReason, presentationChangeReason,
} = {}) {
  let base, head;
  const diagnostics = [];
  for (const [side, html] of [['base', baseHtml], ['head', headHtml]]) {
    try { const snapshot = extractArtifactGeometry(html); if (side === 'base') base = snapshot; else head = snapshot; }
    catch (error) { diagnostics.push(...(error.archifyDiagnostics || [diagnostic('artifact/extraction-failed', error.message)]).map((item) => ({ ...item, side }))); }
  }
  if (!base || !head) return { schemaVersion: 1, ok: false, complete: false, changes: [], uncertainties: diagnostics.map((item) => ({ kind: 'extraction', scope: 'unknown', reason: item.message })), diagnostics,
    summary: { changedOwners: 0, geometry: 0, presentation: 0, content: 0, unexplained: 0, unknown: diagnostics.length }, visualAcceptance: 'human-required' };
  diagnostics.push(...base.diagnostics.map((item) => ({ ...item, side: 'base' })), ...head.diagnostics.map((item) => ({ ...item, side: 'head' })));
  const affected = { node: new Set(affectedNodes), edge: new Set(affectedEdges), boundary: new Set(affectedBoundaries.map((item) => typeof item === 'string' ? item : boundaryKey(item))) };
  const aliases = new Map(), targets = new Set();
  const beforeKeys = new Set(base.boundaries.map(boundaryKey)), afterKeys = new Set(head.boundaries.map(boundaryKey));
  for (const mapping of boundaryMappings) {
    const from = boundaryKey(mapping?.from || {}), to = boundaryKey(mapping?.to || {});
    if (!beforeKeys.has(from) || !afterKeys.has(to) || aliases.has(from) || targets.has(to)
      || (from !== to && (beforeKeys.has(to) || afterKeys.has(from)))) {
      diagnostics.push(diagnostic('artifact/boundary-mapping-invalid', 'Boundary identity mappings must be explicit, present, unambiguous and one-to-one.', {}, { mapping }));
    } else { aliases.set(from, to); targets.add(to); }
  }
  const changes = [];
  const compareOwners = (before, after, kind, key) => {
    const baseIds = before.map(key), headIds = after.map(key);
    const ambiguous = new Set([...baseIds, ...headIds].filter((id) => baseIds.filter((value) => value === id).length > 1 || headIds.filter((value) => value === id).length > 1));
    const valid = (id, values) => id !== null && id !== undefined && id !== '' && !ambiguous.has(id) && values.filter((value) => value === id).length === 1;
    const beforeIndex = new Map(before.filter((item) => valid(key(item), baseIds)).map((item) => [kind === 'boundary' ? aliases.get(key(item)) || key(item) : key(item), item]));
    const afterIndex = new Map(after.filter((item) => valid(key(item), headIds)).map((item) => [key(item), item]));
    for (const id of [...new Set([...beforeIndex.keys(), ...afterIndex.keys()])].sort(order)) {
      const previous = beforeIndex.get(id), current = afterIndex.get(id);
      const fields = changedFields(previous, current);
      if (!fields.length) continue;
      const classifications = previous && current
        ? ['geometry', 'presentation', 'content'].filter((name) => fields.some((field) => field.startsWith(`/${name}`)))
        : ['geometry', 'presentation', 'content'];
      if (fields.some((field) => ['/kind', '/label', '/from', '/to'].includes(field)) && !classifications.includes('content')) classifications.push('content');
      const scoped = affected[kind].has(id) || (previous && kind === 'boundary' && affected.boundary.has(key(previous)));
      changes.push({ kind, id, changeType: !previous ? 'added' : !current ? 'removed' : 'modified', classifications, changedFields: fields,
        scope: scoped ? 'affected' : 'unexplained', scopeReason: scoped ? 'declared affected owner' : 'outside declared affected owners', base: previous, head: current });
    }
  };
  compareOwners(base.nodes, head.nodes, 'node', (node) => node.id);
  compareOwners(base.edges, head.edges, 'edge', (edge) => edge.id);
  compareOwners(base.boundaries, head.boundaries, 'boundary', (boundary) => boundary.kind && boundary.label ? boundaryKey(boundary) : null);
  if (!equal(base.viewport, head.viewport)) changes.push({ kind: 'viewport', id: 'primary-svg', changeType: 'modified', classifications: ['geometry'],
    changedFields: changedFields(base.viewport, head.viewport), scope: typeof viewportChangeReason === 'string' && viewportChangeReason.trim() ? 'affected' : 'unknown',
    scopeReason: viewportChangeReason || 'viewport affects the full diagram; an affected-node list does not explain a canvas change', base: base.viewport, head: head.viewport });
  if (!equal(base.presentation, head.presentation)) changes.push({ kind: 'diagram-style', id: 'primary-svg', changeType: 'modified', classifications: ['presentation'],
    changedFields: changedFields(base.presentation, head.presentation), scope: typeof presentationChangeReason === 'string' && presentationChangeReason.trim() ? 'affected' : 'unknown',
    scopeReason: presentationChangeReason || 'global SVG presentation needs an explicit explanation', base: base.presentation, head: head.presentation });
  const uncertainties = diagnostics.map((item) => ({ kind: 'identity', scope: 'unknown', reason: item.message, code: item.code, subject: item.subject }));
  if (!equal(base.stylesheets, head.stylesheets)) {
    const item = diagnostic('artifact/stylesheets-changed', 'Stylesheet changes need browser inspection; static attributes cannot establish their effect on the diagram or distinguish it from UI-only styling.', { kind: 'stylesheets' }, { base: base.stylesheets, head: head.stylesheets });
    diagnostics.push(item); uncertainties.push({ kind: 'stylesheets', scope: 'unknown', reason: item.message });
  }
  if (!equal(base.definitions, head.definitions)) {
    const item = diagnostic('artifact/definitions-changed', 'SVG definitions changed; marker, pattern, filter and clip dependencies need browser inspection.', { kind: 'definitions' }, { base: base.definitions, head: head.definitions });
    diagnostics.push(item); uncertainties.push({ kind: 'definitions', scope: 'unknown', reason: item.message });
  }
  const unexplained = changes.filter((change) => change.scope === 'unexplained').length;
  const unknown = changes.filter((change) => change.scope === 'unknown').length + uncertainties.length;
  const complete = diagnostics.length === 0;
  return { schemaVersion: 1, ok: complete && unexplained === 0 && unknown === 0, complete, inspection: 'canonical-svg-static',
    base, head, changes, uncertainties, diagnostics,
    summary: { changedOwners: changes.length, geometry: changes.filter((change) => change.classifications.includes('geometry')).length,
      presentation: changes.filter((change) => change.classifications.includes('presentation')).length,
      content: changes.filter((change) => change.classifications.includes('content')).length, unexplained, unknown },
    visualAcceptance: 'human-required',
    limitations: ['Canonical SVG attributes and route points are compared, not screenshot pixels or beauty.',
      'CSS references and transform chains are preserved; browser computed colors, font shaping and text bounding boxes are not inferred.',
      'Declared affected scope is an explanation request, not proof that each movement is necessary.',
      'No stable edge ID means identity is ambiguous; array indices and endpoint pairs are never used as substitutes.'],
  };
}
