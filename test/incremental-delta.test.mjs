import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  ArchitectureDeltaError, canonicalArchitectureJson, compareArchitecture,
  extractArchitectureSvg, extractArtifactCss, buildDeltaSvg,
  renderArchitectureDeltaHtml, validateArchitectureDeltaHtml,
} from '../delta/architecture-delta.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(root, 'schemas/architecture.schema.json'), 'utf8'));
const fixture = () => ({
  schema_version: 1, diagram_type: 'architecture',
  meta: { title: 'Controller', output: 'controller.html' },
  components: [
    { id: 'a', type: 'external', label: 'Input', pos: [80, 170], size: [150, 70] },
    { id: 'b', type: 'backend', label: 'Control', pos: [450, 170], size: [150, 70] },
    { id: 'c', type: 'database', label: 'Store', pos: [820, 170], size: [150, 70] },
  ],
  connections: [{ id: 'a-b', from: 'a', to: 'b', label: 'Data' }, { id: 'b-c', from: 'b', to: 'c' }],
  boundaries: [{ kind: 'region', label: 'System', wraps: ['a', 'b', 'c'] }],
  cards: [{ dot: 'cyan', title: 'Behavior', items: ['Only run when ready'] }],
});

function changed(mutator) {
  const base = fixture(), head = structuredClone(base);
  mutator(head);
  return compareArchitecture(base, head);
}

test('ports and boundary geometry are reported without topology changes', () => {
  const receipt = changed((head) => {
    Object.assign(head.connections[0], { fromPort: [1, 0.25], toPort: [0, 0.75] });
    Object.assign(head.boundaries[0], { bounds: [20, 100, 1010, 220], labelOffset: [12, 4] });
  });
  assert.equal(receipt.completeness, 'complete');
  assert.deepEqual(receipt.changes.connections[0].classifications, ['geometry']);
  assert.equal(receipt.changes.connections[0].status, 'rerouted');
  assert.deepEqual(receipt.changes.connections[0].changedFields, ['/fromPort', '/toPort']);
  assert.deepEqual(receipt.changes.boundaries[0].changedFields, ['/bounds', '/labelOffset']);
  assert.equal(receipt.changes.boundaries[0].status, 'geometry-changed');
  assert.equal(receipt.summary.connections.changed, 0);
});

test('font, color, stroke width and decorative marks are presentation changes', () => {
  const receipt = changed((head) => {
    Object.assign(head.components[0], { icon: 'clock', brand: 'redis', font_sizes: { label: 15 } });
    Object.assign(head.connections[0], { labelColor: '#123456', width: 2, font_sizes: { label: 12 } });
    head.boundaries[0].font_sizes = { label: 14 };
  });
  for (const collection of ['components', 'connections', 'boundaries']) {
    assert.deepEqual(receipt.changes[collection][0].classifications, ['presentation']);
    assert.equal(receipt.changes[collection][0].status, 'changed');
  }
  assert.equal(receipt.summary.presentationChanged, true);
});

test('metadata, card content, card styling, and output relocation have explicit ledgers', () => {
  const receipt = changed((head) => {
    head.meta.font_sizes = { title: 28 };
    head.meta.output = 'updated.html';
    head.meta.translations = { 'app.ready': 'Ready' };
    head.cards[0].items = ['Only run when ready and enabled'];
    head.cards[0].font_sizes = { items: [12] };
  });
  const changes = new Map(receipt.changes.document.map((entry) => [entry.path, entry]));
  assert.deepEqual(changes.get('/meta/font_sizes').classifications, ['presentation']);
  assert.deepEqual(changes.get('/meta/output').classifications, ['evidence']);
  assert.equal(changes.get('/meta/output').base, 'controller.html');
  assert.equal(changes.get('/meta/output').head, 'updated.html');
  assert.deepEqual(changes.get('/meta/translations').classifications, ['semantic']);
  assert.deepEqual(changes.get('/cards/0/items').classifications, ['semantic']);
  assert.deepEqual(changes.get('/cards/0/font_sizes').classifications, ['presentation']);
  assert.deepEqual(receipt.changes.components, []);
});

test('all schema fields have exercised comparison classifications', () => {
  const cases = {
    components: {
      id: ['a-new', 'identity'], type: ['backend', 'semantic'], label: ['Input changed', 'semantic'],
      sublabel: ['Frame', 'semantic'], tag: ['IRQ', 'semantic'], icon: ['clock', 'presentation'],
      brand: ['redis', 'presentation'], sources: [[{ path: 'Core/main.c', line: 5 }], 'evidence'],
      row: [1, 'geometry'], col: [2, 'geometry'], pos: [[90, 180], 'geometry'], size: [[180, 80], 'geometry'],
      font_sizes: [{ label: 16 }, 'presentation'],
    },
    connections: {
      id: ['a-b-new', 'identity'], from: ['c', 'topology'], to: ['c', 'topology'], label: ['Ready only', 'semantic'],
      variant: ['dashed', 'semantic'], fromSide: ['bottom', 'geometry'], toSide: ['top', 'geometry'],
      fromPort: [[1, 0.25], 'geometry'], toPort: [[0, 0.75], 'geometry'], route: ['orthogonal-h', 'geometry'],
      via: [[[300, 200], [300, 250]], 'geometry'], labelAt: [[350, 150], 'geometry'],
      labelDx: [4, 'geometry'], labelDy: [8, 'geometry'], labelSegment: [1, 'geometry'],
      width: [2, 'presentation'], labelColor: ['#abcdef', 'presentation'], font_sizes: [{ label: 12 }, 'presentation'],
    },
    boundaries: {
      kind: ['security-group', 'identity'], label: ['Renamed system', 'identity'], wraps: [['a', 'b'], 'scope'],
      pad: [35, 'geometry'], bounds: [[10, 100, 1030, 250], 'geometry'], labelOffset: [[10, 4], 'geometry'],
      font_sizes: [{ label: 14 }, 'presentation'],
    },
  };
  for (const [collection, fields] of Object.entries(cases)) {
    assert.deepEqual(Object.keys(fields).sort(), Object.keys(schema.properties[collection].items.properties).sort(), `${collection} schema coverage changed; add behavioral expectations`);
    for (const [field, [value, classification]] of Object.entries(fields)) {
      const receipt = changed((head) => { head[collection][0][field] = value; });
      assert.equal(receipt.completeness, 'complete', `${collection}.${field}`);
      const changes = receipt.changes[collection];
      if (classification === 'identity') assert.deepEqual(new Set(changes.map((entry) => entry.status)), new Set(['added', 'removed']), `${collection}.${field}`);
      else {
        assert.equal(changes.length, 1, `${collection}.${field}`);
        assert.ok(changes[0].classifications.includes(classification), `${collection}.${field}`);
        assert.ok(changes[0].changedFields.includes(`/${field}`), `${collection}.${field}`);
      }
    }
  }
});

test('every metadata, layout, and card schema field is retained in the document ledger', () => {
  const cases = {
    meta: {
      title: ['New title', 'semantic'], locale: ['zh-CN', 'presentation'], translations: [{ 'app.ready': '就绪' }, 'semantic'],
      subtitle: ['Realtime', 'semantic'], output: ['new.html', 'evidence'], animation: ['none', 'presentation'],
      visual_preset: ['blueprint', 'presentation'], quality_profile: ['showcase', 'presentation'],
      font_scale: [1.2, 'presentation'], font_sizes: [{ title: 24 }, 'presentation'], line_scale: [2, 'presentation'],
      arrow_scale: [1.5, 'presentation'], engineering_profile: ['deployment-ownership', 'presentation'],
      repository: [{ url: 'https://github.com/example/controller', revision: 'a'.repeat(40) }, 'evidence'],
      views: [[{ id: 'control', label: 'Control', focus: ['b'], note: 'Entry point' }], 'semantic'],
      legend: [{ entries: { backend: { label: 'Control', font_size: 12, visible: true } } }, 'mixed'],
      viewBox: [[1200, 900], 'geometry'],
    },
    layout: {
      mode: ['grid', 'geometry'], origin: [[20, 20], 'geometry'], cols: [3, 'geometry'], gapX: [50, 'geometry'],
      gapY: [40, 'geometry'], cellW: [150, 'geometry'], cellH: [70, 'geometry'],
    },
    cards: { dot: ['amber', 'presentation'], title: ['New behavior', 'semantic'], items: [['Ready before run'], 'semantic'], font_sizes: [{ title: 15 }, 'presentation'] },
  };
  const common = JSON.parse(fs.readFileSync(path.join(root, 'schemas/common.schema.json'), 'utf8'));
  for (const [owner, fields] of Object.entries(cases)) {
    const properties = owner === 'cards' ? common.$defs.cards.items.properties : schema.properties[owner].properties;
    assert.deepEqual(Object.keys(fields).sort(), Object.keys(properties).sort(), `${owner} schema coverage changed`);
    for (const [field, [value, classification]] of Object.entries(fields)) {
      const receipt = changed((head) => {
        if (owner === 'cards') head.cards[0][field] = value;
        else (head[owner] ||= {})[field] = value;
      });
      assert.equal(receipt.completeness, 'complete', `${owner}.${field}`);
      const expectedPath = `/${owner}/${owner === 'cards' ? '0/' : ''}${field}`;
      if (classification === 'mixed') {
        const legend = new Map(receipt.changes.document.map((entry) => [entry.path, entry.classifications]));
        assert.deepEqual(legend.get('/meta/legend/entries/backend/label'), ['semantic']);
        assert.deepEqual(legend.get('/meta/legend/entries/backend/font_size'), ['presentation']);
        assert.deepEqual(legend.get('/meta/legend/entries/backend/visible'), ['presentation']);
      } else assert.deepEqual(receipt.changes.document.find((entry) => entry.path === expectedPath)?.classifications, [classification], expectedPath);
    }
  }
});

test('unknown root, entity, metadata and nested fields cannot silently claim complete', () => {
  const receipt = changed((head) => {
    head.future = { policy: 'preserve' };
    head.components[0].futureOwner = 'safety';
    head.connections[0].futureDirection = true;
    head.boundaries[0].futureScope = 'physical';
    head.meta.futureProperty = 'new';
    head.meta.font_sizes = { futureStyle: 12 };
    head.layout = { mode: 'grid', futureLane: 4 };
    head.cards[0].futureFact = 'required';
  });
  assert.equal(receipt.completeness, 'incomplete');
  assert.equal(receipt.coverage.classified, false);
  for (const expected of ['/future', '/components/0/futureOwner', '/connections/0/futureDirection', '/boundaries/0/futureScope', '/meta/futureProperty', '/meta/font_sizes/futureStyle', '/layout/futureLane', '/cards/0/futureFact']) {
    assert.ok(receipt.coverage.unclassifiedFields.includes(expected), expected);
  }
  for (const collection of ['components', 'connections', 'boundaries']) assert.ok(receipt.changes[collection][0].classifications.includes('unclassified'));
  assert.equal(receipt.diagnostics[0].code, 'delta/unclassified-fields');
  assert.ok(receipt.diagnostics[0].supportedFixes.length);
  const base = fixture(); base.components[0].futureSame = 'same';
  assert.equal(compareArchitecture(base, structuredClone(base)).completeness, 'incomplete', 'unknown unchanged fields still require classification');
});

test('canonical snapshots retain unknown authored fields instead of erasing evidence', () => {
  const base = fixture(), head = structuredClone(base);
  head.future = 'new';
  assert.notEqual(canonicalArchitectureJson(base), canonicalArchitectureJson(head));
  base.meta.repository = { url: 'https://github.com/example/controller', revision: 'a'.repeat(40) };
  head.meta.repository = { ...base.meta.repository, futureProvenance: 'new' };
  delete head.future;
  assert.notEqual(canonicalArchitectureJson(base), canonicalArchitectureJson(head));
  assert.equal(compareArchitecture(base, head).completeness, 'incomplete');
});

test('normalized evidence and scope order still preserve explicit authored-order changes', () => {
  const base = fixture();
  base.components[0].sources = [{ path: 'first.c' }, { path: 'second.c' }];
  const head = structuredClone(base);
  head.components[0].sources.reverse();
  head.boundaries[0].wraps.reverse();
  head.components.reverse();
  head.connections.reverse();
  const receipt = compareArchitecture(base, head);
  assert.equal(canonicalArchitectureJson(base), canonicalArchitectureJson(head));
  assert.deepEqual(receipt.changes.components, []);
  assert.deepEqual(receipt.changes.boundaries, []);
  const changes = receipt.changes.document.filter((entry) => entry.role === 'authored-order');
  assert.equal(changes.length, 4);
  assert.ok(changes.some((entry) => entry.path === '/components'));
  assert.ok(changes.some((entry) => entry.path === '/connections'));
  assert.ok(changes.some((entry) => entry.path.endsWith('/sources') && entry.subjectId === 'a'));
  assert.ok(changes.some((entry) => entry.path.endsWith('/wraps')));
});

test('stable IDs, repository identity and boundary identity remain conservative', () => {
  assert.throws(() => changed((head) => { delete head.components[0].id; }), { code: 'delta/stable-id-required' });
  assert.throws(() => changed((head) => { delete head.connections[0].id; }), { code: 'delta/relationship-id-required' });
  assert.throws(() => changed((head) => { head.components[1].id = 'a'; }), { code: 'delta/duplicate-stable-id' });
  assert.throws(() => changed((head) => { head.boundaries.push(structuredClone(head.boundaries[0])); }), { code: 'delta/boundary-key-ambiguous' });
  assert.throws(() => changed((head) => { head.schema_version = 2; }), { code: 'delta/schema-version-mismatch' });
  assert.throws(() => changed((head) => { head.diagram_type = 'workflow'; }), { code: 'delta/type-mismatch' });
  assert.throws(() => changed((head) => { head.components.forEach((item) => { item.id = `new-${item.id}`; }); }), { code: 'delta/no-shared-component-id' });
  const renamed = changed((head) => { head.boundaries[0].label = 'New system name'; });
  assert.deepEqual(renamed.changes.boundaries.map((entry) => entry.status).sort(), ['added', 'removed']);
  assert.ok(renamed.limitations.some((entry) => entry.includes('Boundary renames')));
  const base = fixture(), head = structuredClone(base);
  base.meta.repository = { url: 'https://github.com/example/controller', revision: 'A'.repeat(40) };
  head.meta.repository = { url: 'https://github.com/EXAMPLE/CONTROLLER.git', revision: 'b'.repeat(40) };
  const receipt = compareArchitecture(base, head, { baseVerified: true, headVerified: true });
  assert.equal(receipt.proofLevel, 'revision-pinned');
  assert.deepEqual(receipt.provenance.changedFields, ['/revision']);
  head.meta.repository.url = 'https://github.com/example/other';
  assert.throws(() => compareArchitecture(base, head), { code: 'delta/repository-mismatch' });
});

test('comparison is deterministic, does not mutate inputs, and output relocation stays out of semantic hash', () => {
  const base = fixture(), head = structuredClone(base);
  head.meta.output = 'relocated.html';
  const before = JSON.stringify({ base, head });
  assert.deepEqual(compareArchitecture(base, head), compareArchitecture(base, head));
  assert.equal(JSON.stringify({ base, head }), before);
  assert.equal(canonicalArchitectureJson(base), canonicalArchitectureJson(head));
  assert.ok(compareArchitecture(base, head).changes.document.some((entry) => entry.path === '/meta/output'));
});

test('empty optional collections are recorded without inventing graph topology changes', () => {
  const base = fixture(); delete base.cards; delete base.connections; delete base.boundaries;
  const head = structuredClone(base); Object.assign(head, { cards: [], connections: [], boundaries: [] });
  const receipt = compareArchitecture(base, head);
  assert.deepEqual(receipt.changes.components, []);
  assert.deepEqual(receipt.changes.connections, []);
  assert.deepEqual(receipt.changes.boundaries, []);
  assert.deepEqual(receipt.changes.document.map((entry) => entry.path).sort(), ['/boundaries', '/cards', '/connections']);
  assert.ok(receipt.changes.document.every((entry) => entry.role === 'collection-presence'));
});

test('real renderer delta HTML retains presentation, geometry and document change contracts', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-incremental-delta-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const base = fixture();
  const render = (diagram, name) => {
    const input = path.join(directory, `${name}.json`), output = path.join(directory, `${name}.html`);
    fs.writeFileSync(input, JSON.stringify(diagram));
    const result = spawnSync(process.execPath, [path.join(root, 'renderers/architecture/render-architecture.mjs'), input, output], { encoding: 'utf8', cwd: root });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    return fs.readFileSync(output, 'utf8');
  };
  const baseHtml = render(base, 'base');
  for (const [name, update] of [
    ['style', (head) => { head.connections[0].labelColor = '#123456'; head.components[0].icon = 'clock'; }],
    ['ports', (head) => { head.connections[0].fromPort = [1, 0.4]; head.connections[0].toPort = [0, 0.4]; }],
    ['frame-style', (head) => { head.boundaries[0].font_sizes = { label: 14 }; }],
    ['frame-geometry', (head) => { head.boundaries[0].bounds = [30, 90, 1020, 220]; head.boundaries[0].labelOffset = [12, 0]; }],
    ['document', (head) => { head.cards[0].items = ['Enable before running <verified>']; head.meta.font_sizes = { title: 24 }; }],
  ]) {
    const head = structuredClone(base); update(head);
    const receipt = compareArchitecture(base, head), headHtml = render(head, name);
    const baseSvg = extractArchitectureSvg(baseHtml), headSvg = extractArchitectureSvg(headHtml);
    const html = renderArchitectureDeltaHtml({ receipt, baseSvg, headSvg, deltaSvg: buildDeltaSvg(baseSvg, headSvg, receipt), baseHtml, headHtml, artifactCss: extractArtifactCss(headHtml) });
    assert.equal(validateArchitectureDeltaHtml(html, receipt).ok, true, name);
    if (name === 'document') {
      assert.ok(html.includes('data-document-path="/cards/0/items"'));
      assert.ok(html.includes('&lt;verified&gt;'));
      assert.ok(!html.includes('No authored architecture changes.</li>'));
      assert.throws(() => validateArchitectureDeltaHtml(html.replace('data-document-path="/cards/0/items"', 'data-document-path="/cards/0/other"'), receipt), ArchitectureDeltaError);
    }
  }
});
