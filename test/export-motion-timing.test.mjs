import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const template = fs.readFileSync(new URL('../assets/template.html', import.meta.url), 'utf8');

function source(name) {
  const start = template.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' missing');
  const end = template.indexOf('\n        }', start);
  assert.notEqual(end, -1, name + ' end missing');
  return template.slice(start, end + '\n        }'.length);
}

const draw = vm.runInNewContext(
  source('pointAlong') + '\n' + source('roundedRectPath') + '\n(' + source('drawMotionFrame') + ')',
);

function scene(gif, durationSec) {
  const delays = [0, 0.64, 1.92, 999];
  return {
    gif, durationSec, x: 0, y: 0, width: 100, height: 100,
    edges: delays.map(delay => ({ delay, width: 2, color: '#22d3ee', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] })),
    nodes: delays.map(delay => ({ delay, x: 0, y: 0, width: 20, height: 20, color: '#22d3ee' })),
  };
}

function frame(motionScene, elapsed) {
  const heads = [], pulses = [];
  const ctx = {
    canvas: { width: 100, height: 100 },
    clearRect() {}, drawImage() {}, save() {}, restore() {}, scale() {}, translate() {},
    beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, fill() {},
    arc(x) { heads.push(x / 100); },
    stroke() { if (this.lineWidth < 3.3) pulses.push(this.globalAlpha * (2)); },
  };
  draw(ctx, {}, motionScene, elapsed);
  return { heads, pulses };
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, actual + ' != ' + expected);
}

for (const durationSec of [0.25, 2, 4, 6]) {
  test('GIF edges traverse once and nodes pulse once over ' + durationSec + ' seconds', () => {
    const s = scene(true, durationSec);
    assert.deepEqual(frame(s, 0), { heads: [], pulses: [] }, 'keep the first GIF frame as the still baseline');
    let previous = 0;
    for (let step = 1; step <= 120; step++) {
      const progress = step / 120;
      const { heads, pulses } = frame(s, progress * durationSec);
      assert.equal(heads.length, s.edges.length, 'authored delays must not hide GIF edges');
      for (const head of heads) close(head, progress);
      assert.ok(heads[0] >= previous, 'progress must never wrap to the beginning');
      previous = heads[0];
      const pulse = Math.sin(Math.PI * progress);
      assert.equal(pulses.length, pulse <= 0.02 ? 0 : s.nodes.length);
      for (const actual of pulses) close(actual, pulse);
    }
    assert.deepEqual(frame(s, durationSec + 0.001), { heads: [], pulses: [] });
  });
}

test('GIF drawing never reads authored edge or node delays', () => {
  const s = scene(true, 6);
  for (const item of [...s.edges, ...s.nodes]) {
    Object.defineProperty(item, 'delay', { get() { throw new Error('authored delay read'); } });
  }
  const result = frame(s, 3);
  assert.deepEqual(result.heads, [0.5, 0.5, 0.5, 0.5]);
  assert.deepEqual(result.pulses, [1, 1, 1, 1]);
});

test('GIF createMotionScene zeros delays and carries encoder durationSec', () => {
  const edge = {
    getAttribute() { return null; },
    style: { getPropertyValue() { throw new Error('authored step read'); } },
    getTotalLength() { return 100; },
    getPointAtLength(x) { return { x, y: 0 }; },
  };
  const node = { ...edge, getBBox() { return { x: 0, y: 0, width: 20, height: 20 }; }, querySelector() { return null; } };
  for (const duration of [250, 2000, 4000, 6000]) {
    const create = vm.runInNewContext('(' + source('createMotionScene') + ')', {
      format: 'gif', duration, vb: { x: 0, y: 0, width: 100, height: 100 },
      getComputedStyle() { return { stroke: '#22d3ee', strokeWidth: '2', getPropertyValue() { return ''; } }; },
    });
    const s = create({
      querySelectorAll(sel) {
        if (String(sel).includes('data-node-id')) return [node, node];
        return [edge, edge];
      },
    });
    assert.equal(s.gif, true);
    assert.equal(s.durationSec, duration / 1000);
    assert.deepEqual(Array.from(s.edges, e => e.delay), [0, 0]);
    assert.deepEqual(Array.from(s.nodes, n => n.delay), [0, 0]);
    const result = frame(s, duration / 2000);
    assert.deepEqual(result.heads, [0.5, 0.5]);
    assert.deepEqual(result.pulses, [1, 1]);
  }
  assert.ok(template.includes('bitmap: motionBitmap, scene: motionScene'));
  assert.ok(template.includes('drawMotionFrame(ctx, bitmap, scene, job.args[0])'));
});

test('non-GIF edges and nodes retain their staggered fixed-duration passes', () => {
  const s = scene(false, 30);
  const early = frame(s, 0.8);
  close(early.heads[0], 0.8 / 1.75);
  close(early.heads[1], (0.8 - 0.64) / 1.75);
  assert.equal(early.heads.length, 2, 'late delayed edges stay hidden before their start');
  // After the first edge finishes its 1.75s pass, later delayed edges can still be mid-flight.
  const late = frame(s, 2.1);
  assert.equal(late.heads.length, 2);
  close(late.heads[0], (2.1 - 0.64) / 1.75);
  close(late.heads[1], (2.1 - 1.92) / 1.75);
  assert.ok(!template.includes('((elapsed - edge.delay) %'));
  assert.ok(!template.includes('((elapsed - node.delay) %'));
});

test('GIF path stores durationSec and fails closed without multi-loop modulo', () => {
  assert.match(template, /durationSec:\s*duration\s*\/\s*1000/);
  assert.match(template, /motionScene\.gif \? elapsed \/ motionScene\.durationSec/);
  assert.match(template, /delay:\s*format === 'gif' \? 0/);
  assert.doesNotMatch(template, /motionScene\.gif && elapsed >= edge\.delay\) progress = \(\(elapsed/);
  assert.doesNotMatch(template, /motionScene\.gif && elapsed >= node\.delay\) progress = \(\(elapsed/);
});

test('flow speed UI defaults to 4s and maps option values onto durationSec', () => {
  assert.match(template, /id="export-flow-speed"/);
  assert.match(template, /option value="4000" selected/);
  assert.match(template, /option value="2000"/);
  assert.match(template, /option value="3000"/);
  assert.match(template, /option value="5000"/);
  assert.match(template, /option value="6000"/);
  assert.match(template, /function motionDurationMs\(/);
  assert.match(template, /MOTION_DURATION\s*=\s*4000/);
  assert.match(template, /duration:\s*motionDurationMs\(\)/);
  // Speed select values are the GIF single-pass duration in ms.
  for (const ms of [2000, 3000, 4000, 5000, 6000]) {
    const create = vm.runInNewContext('(' + source('createMotionScene') + ')', {
      format: 'gif', duration: ms, vb: { x: 0, y: 0, width: 100, height: 100 },
      getComputedStyle() { return { stroke: '#22d3ee', strokeWidth: '2', getPropertyValue() { return ''; } }; },
    });
    const edge = {
      getAttribute() { return null; },
      style: { getPropertyValue() { return ''; } },
      getTotalLength() { return 100; },
      getPointAtLength(x) { return { x, y: 0 }; },
    };
    const s = create({ querySelectorAll() { return [edge]; } });
    assert.equal(s.durationSec, ms / 1000);
    const mid = frame(s, ms / 2000);
    assert.deepEqual(mid.heads, [0.5]);
  }
});

test('GIF preview reuses the export GIF compose path and shared duration clock', () => {
  assert.match(template, /data-action="preview-gif"/);
  assert.match(template, /options\.preview === true && format === 'gif'/);
  assert.match(template, /function previewGif\(/);
  assert.match(template, /preview:\s*true/);
  assert.match(template, /drawMotionFrame\(ctx,\s*backgroundImage,\s*motionScene,\s*elapsed\)/);
  assert.match(template, /data-gif-preview-duration-ms/);
  // Preview and export both feed duration through recordMotion options.
  assert.match(template, /recordMotion\(Object\.assign\(\{[\s\S]*?preview:\s*true[\s\S]*?\}, options \|\| \{\}\), 'gif'\)/);
  assert.ok(template.indexOf("format === 'gif'") !== -1);
});

test('relay GIF keeps downstream signals dark until arrival and preserves export-length scaling', () => {
  for (const durationSec of [2, 4, 6]) {
    const s = scene(true, durationSec);
    s.relay = true; s.cycle = 4;
    s.edges = [0, 1.1, 2.2].map(start => ({ ...s.edges[0], start, travel: 1 }));
    s.nodes = [];
    assert.equal(frame(s, durationSec * 0.125).heads.length, 1, 'only the first hop can travel before arrival');
    close(frame(s, durationSec * 0.125).heads[0], 0.5);
    assert.equal(frame(s, durationSec * 0.4).heads.length, 1, 'the next hop takes over after arrival');
    close(frame(s, durationSec * 0.4).heads[0], 0.5);
    assert.deepEqual(frame(s, durationSec * 0.825).heads, [], 'settled signals never restart before the next GIF loop');
    assert.deepEqual(frame(s, durationSec * 0.4), frame(JSON.parse(JSON.stringify(s)), durationSec * 0.4),
      'the worker receives the same serializable timeline as preview');
  }
});
