import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse, serialize } from 'parse5';
import { extractArtifactGeometry, auditArtifactGeometry } from '../incremental/artifacts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = () => ({
  schema_version: 1, diagram_type: 'architecture', meta: { title: 'Controller', output: 'controller.html' },
  components: [
    { id: 'a', type: 'external', label: 'Input', pos: [80, 170], size: [150, 70] },
    { id: 'b', type: 'backend', label: 'Control', pos: [450, 170], size: [150, 70] },
    { id: 'c', type: 'database', label: 'Store', pos: [820, 170], size: [150, 70] },
  ],
  connections: [{ id: 'a-b', from: 'a', to: 'b', label: 'Data' }, { id: 'b-c', from: 'b', to: 'c' }],
  boundaries: [{ kind: 'region', label: 'System & Devices', wraps: ['a', 'b', 'c'] }],
});
let directory, baseHtml;
let sequence = 0;
function render(mutator = () => {}) {
  const diagram = fixture(); mutator(diagram);
  const name = `scene-${sequence++}`;
  const input = path.join(directory, `${name}.json`), output = path.join(directory, `${name}.html`);
  fs.writeFileSync(input, JSON.stringify(diagram));
  const result = spawnSync(process.execPath, [path.join(root, 'renderers/architecture/render-architecture.mjs'), input, output], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return fs.readFileSync(output, 'utf8');
}
function mutateHtml(html, fn) {
  const document = parse(html);
  const visit = (node) => { fn(node); for (const child of node.childNodes || []) visit(child); };
  visit(document);
  return serialize(document);
}
const attr = (node, name) => (node.attrs || []).find((item) => item.name.toLowerCase() === name.toLowerCase());
const edgeChange = (result, id) => result.changes.find((change) => change.kind === 'edge' && change.id === id);
before(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-artifact-audit-')); baseHtml = render(); });
after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

test('canonical SVG extraction reads exact stable identities, route points and boundary title geometry', () => {
  const snapshot = extractArtifactGeometry(baseHtml);
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.nodes.map((node) => node.id), ['a', 'b', 'c']);
  assert.deepEqual(snapshot.edges.map((edge) => edge.id), ['a-b', 'b-c']);
  const first = snapshot.edges[0];
  assert.equal(first.from, 'a'); assert.equal(first.to, 'b');
  assert.ok(first.geometry.path.d.startsWith('M'));
  assert.deepEqual(first.geometry.path.routePoints[0], [230, 205]);
  assert.deepEqual(first.geometry.path.routePoints.at(-1), [450, 205]);
  const label = first.geometry.labels[0].find((item) => item.element === 'text');
  assert.equal(typeof label.x, 'number'); assert.equal(typeof label.y, 'number');
  assert.equal(first.presentation.labels[0].find((item) => item.element === 'text')['font-size'], '8');
  assert.equal(snapshot.boundaries[0].label, 'System & Devices');
  assert.equal(snapshot.boundaries[0].kind, 'region');
  assert.equal(typeof snapshot.boundaries[0].geometry.frame.width, 'number');
  assert.ok(snapshot.boundaries[0].geometry.titles[0].some((item) => item.element === 'text' && typeof item.x === 'number'));
  assert.equal(snapshot.viewport.viewBox.length, 4);
  const audit = auditArtifactGeometry(baseHtml, baseHtml);
  assert.equal(audit.ok, true); assert.equal(audit.complete, true);
  assert.deepEqual(audit.changes, []); assert.equal(audit.visualAcceptance, 'human-required');
});

test('real connection label font changes report both drawn label geometry and presentation', () => {
  const headHtml = render((diagram) => { diagram.connections[0].font_sizes = { label: 12 }; });
  const result = auditArtifactGeometry(baseHtml, headHtml, { affectedEdges: ['a-b'] });
  const change = edgeChange(result, 'a-b');
  assert.ok(change.classifications.includes('presentation'));
  assert.ok(change.classifications.includes('geometry'), 'actual label mask grows with font size');
  assert.equal(change.scope, 'affected');
  assert.equal(change.head.presentation.labels[0].find((item) => item.element === 'text')['font-size'], '12');
  assert.equal(result.summary.unexplained, 0);
});

test('explicit labelColor is recognized without claiming a browser computed color', () => {
  const headHtml = render((diagram) => { diagram.connections[0].labelColor = '#123456'; });
  const result = auditArtifactGeometry(baseHtml, headHtml, { affectedEdges: ['a-b'] });
  const change = edgeChange(result, 'a-b');
  assert.deepEqual(change.classifications, ['presentation']);
  assert.equal(change.head.presentation.labels[0].find((item) => item.element === 'text').authoredFill, '#123456 !important');
  assert.equal(result.ok, true);
  assert.ok(result.head.styleResolution.includes('not browser computed'));
});

test('boundary title offset and font changes match kind + decoded label rather than array index', () => {
  const headHtml = render((diagram) => { diagram.boundaries[0].labelOffset = [12, -8]; diagram.boundaries[0].font_sizes = { label: 14 }; });
  const result = auditArtifactGeometry(baseHtml, headHtml, { affectedBoundaries: [{ kind: 'region', label: 'System & Devices' }] });
  const change = result.changes.find((item) => item.kind === 'boundary');
  assert.equal(change.changeType, 'modified'); assert.equal(change.scope, 'affected');
  assert.ok(change.classifications.includes('geometry')); assert.ok(change.classifications.includes('presentation'));
  assert.deepEqual(change.base.geometry.frame, change.head.geometry.frame, 'title moves without moving the frame');
  const beforeText = change.base.geometry.titles[0].find((item) => item.element === 'text');
  const afterText = change.head.geometry.titles[0].find((item) => item.element === 'text');
  assert.equal(afterText.x - beforeText.x, 12);
  assert.equal(change.head.presentation.titles[0].find((item) => item.element === 'text')['font-size'], '14');
});

test('an unrelated actual route is unexplained even if another region is declared affected', () => {
  const headHtml = render((diagram) => {
    Object.assign(diagram.connections[1], { fromSide: 'bottom', toSide: 'bottom', via: [[525, 330], [895, 330]] });
  });
  const result = auditArtifactGeometry(baseHtml, headHtml, { affectedNodes: ['a'], affectedEdges: ['a-b'] });
  const change = edgeChange(result, 'b-c');
  assert.equal(change.scope, 'unexplained');
  assert.ok(change.classifications.includes('geometry'));
  assert.notEqual(change.base.geometry.path.d, change.head.geometry.path.d);
  assert.ok(result.summary.unexplained > 0); assert.equal(result.ok, false);
});

test('missing authored edge IDs cause unknown identity instead of positional equivalence', () => {
  const noIds = mutateHtml(baseHtml, (node) => { if (node.attrs) node.attrs = node.attrs.filter((item) => item.name !== 'data-edge-id'); });
  const result = auditArtifactGeometry(noIds, noIds);
  assert.equal(result.complete, false); assert.equal(result.ok, false);
  assert.ok(result.summary.unknown > 0);
  assert.ok(result.diagnostics.some((item) => item.code === 'artifact/stable-id-required' && item.subject.kind === 'edge'));
  assert.deepEqual(result.changes.filter((item) => item.kind === 'edge'), []);
  assert.ok(result.base.edges.every((edge) => edge.id === null));
});

test('duplicate semantic paths are ambiguous and cannot be invented as removed or added', () => {
  let copied = false;
  const duplicate = mutateHtml(baseHtml, (node) => {
    if (!copied && node.tagName === 'path' && attr(node, 'data-edge-id')?.value === 'a-b') {
      const sibling = { ...node, attrs: node.attrs.map((item) => ({ ...item })), childNodes: [] };
      const index = node.parentNode.childNodes.indexOf(node);
      node.parentNode.childNodes.splice(index + 1, 0, sibling); copied = true;
    }
  });
  const result = auditArtifactGeometry(duplicate, baseHtml);
  assert.equal(result.complete, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'artifact/identity-ambiguous' && item.subject.id === 'a-b'));
  assert.ok(!result.changes.some((item) => item.kind === 'edge' && item.id === 'a-b'));
});

test('explicit one-to-one boundary rename mappings preserve comparison identity', () => {
  const renamed = render((diagram) => { diagram.boundaries[0].label = 'Runtime zone'; });
  const mapping = { from: { kind: 'region', label: 'System & Devices' }, to: { kind: 'region', label: 'Runtime zone' } };
  const result = auditArtifactGeometry(baseHtml, renamed, { boundaryMappings: [mapping], affectedBoundaries: [mapping.to] });
  assert.equal(result.changes.filter((item) => item.kind === 'boundary').length, 1);
  assert.equal(result.changes.find((item) => item.kind === 'boundary').changeType, 'modified');
  assert.equal(result.changes.find((item) => item.kind === 'boundary').scope, 'affected');
  assert.ok(result.changes.find((item) => item.kind === 'boundary').classifications.includes('content'));
  const invalid = auditArtifactGeometry(baseHtml, renamed, { boundaryMappings: [mapping, mapping] });
  assert.equal(invalid.complete, false);
  assert.ok(invalid.diagnostics.some((item) => item.code === 'artifact/boundary-mapping-invalid'));
});

test('body titles, scripts and animation scheduling do not become architecture changes', () => {
  const head = mutateHtml(baseHtml, (node) => {
    if (node.tagName === 'h1' || node.tagName === 'script' || node.tagName === 'title' && node.namespaceURI !== 'http://www.w3.org/2000/svg') {
      node.childNodes = [{ nodeName: '#text', value: 'UI changes only', parentNode: node }];
    }
    if (node.attrs && attr(node, 'data-animate')) {
      const style = attr(node, 'style');
      if (style) style.value = '--step:12;animation-delay:2s';
    }
  });
  const result = auditArtifactGeometry(baseHtml, head);
  assert.equal(result.ok, true); assert.deepEqual(result.changes, []);
});

test('stylesheet and SVG definition changes remain unknown until browser inspection', () => {
  let styleChanged = false, markerChanged = false;
  const head = mutateHtml(baseHtml, (node) => {
    if (node.tagName === 'style' && !styleChanged) {
      node.childNodes.push({ nodeName: '#text', value: '\n.t-primary { fill: red; }', parentNode: node }); styleChanged = true;
    }
    if (node.tagName === 'marker' && !markerChanged) {
      attr(node, 'markerWidth').value = '10'; markerChanged = true;
    }
  });
  const result = auditArtifactGeometry(baseHtml, head);
  assert.equal(result.complete, false); assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'artifact/stylesheets-changed'));
  assert.ok(result.diagnostics.some((item) => item.code === 'artifact/definitions-changed'));
  assert.equal(result.changes.length, 0, 'uncertainty is not fabricated as an observed geometry change');
});

test('viewBox and global preset changes need an explicit scope explanation', () => {
  const head = mutateHtml(baseHtml, (node) => {
    if (node.tagName === 'svg' && attr(node, 'role')?.value === 'img') {
      attr(node, 'viewbox').value = '0 0 1600 1000';
      attr(node, 'data-preset').value = 'blueprint';
    }
  });
  const result = auditArtifactGeometry(baseHtml, head);
  assert.ok(result.changes.some((item) => item.kind === 'viewport' && item.scope === 'unknown'));
  assert.ok(result.changes.some((item) => item.kind === 'diagram-style' && item.scope === 'unknown'));
  const explained = auditArtifactGeometry(baseHtml, head, { viewportChangeReason: 'Approved canvas expansion', presentationChangeReason: 'Approved preset update' });
  assert.equal(explained.ok, true);
});

test('missing or multiple primary SVGs fail explicitly', () => {
  assert.throws(() => extractArtifactGeometry('<html><svg></svg></html>'), { code: 'artifact/primary-svg-ambiguous' });
  const result = auditArtifactGeometry('<p>No diagram</p>', baseHtml);
  assert.equal(result.complete, false); assert.equal(result.ok, false);
  assert.ok(result.summary.unknown > 0);
  assert.equal(result.diagnostics[0].side, 'base');
});

test('non-finite route points and viewBox cannot claim a complete comparison', () => {
  const malformed = mutateHtml(baseHtml, (node) => {
    if (node.tagName === 'svg' && attr(node, 'role')?.value === 'img') attr(node, 'viewbox').value = '0 0 Infinity 900';
    if (node.tagName === 'path' && attr(node, 'data-edge-id')?.value === 'a-b') attr(node, 'data-composition-points').value = '230,NaN;450,205';
  });
  const result = auditArtifactGeometry(malformed, malformed);
  assert.equal(result.complete, false); assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'artifact/route-invalid'));
  assert.ok(result.diagnostics.some((item) => item.code === 'artifact/viewbox-invalid'));
  assert.ok(result.summary.unknown > 0);
});
