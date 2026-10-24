import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouter} from '../renderers/architecture/routing.mjs';

const box = (id, x, y) => ({id, x, y, width: 240, height: 88, cx: x + 120, cy: y + 44});
const components = () => new Map([
  ['serial', box('serial', 420, 150)],
  ['control', box('control', 800, 150)],
  ['servo', box('servo', 420, 390)],
]);
const main = toPort => ({id: 'main', from: 'serial', to: 'control',
  fromSide: 'right', toSide: 'left', fromPort: [1, 0.5], toPort});
const branch = () => ({id: 'branch', from: 'control', to: 'servo',
  fromSide: 'left', toSide: 'right', fromPort: [0, 0.75], toPort: [1, 0.5]});

test('authored off-axis ports remain authoritative even for aligned boxes', () => {
  const connection = main([0, 0.25]);
  const router = createRouter(components(), [connection, branch()], {distinctAutomaticPorts: true});
  const {points} = router.pathFor(connection);
  assert.deepEqual(points[0], [660, 194]);
  assert.deepEqual(points.at(-1), [800, 172]);
  assert.ok(points.length > 2, 'the explicit 22px offset requires a bend');
  assert.deepEqual(connection.toPort, [0, 0.25]);
});

test('joint endpoint repair keeps the main connection straight and branch distinct', () => {
  const connection = main([0, 0.5]);
  const fanout = branch();
  const router = createRouter(components(), [connection, fanout], {distinctAutomaticPorts: true});
  assert.deepEqual(router.pathFor(connection).points, [[660, 194], [800, 194]]);
  const {points} = router.pathFor(fanout);
  assert.deepEqual(points[0], [800, 216]);
  assert.deepEqual(points.at(-1), [660, 434]);
  assert.equal(points[0][1] - 194, 22, 'the branch does not share the main arrow attachment');
  assert.equal(points[0][1], points[1][1], 'branch leaves the left side perpendicularly');
  assert.equal(points.at(-1)[1], points.at(-2)[1], 'branch enters the singleton right midpoint perpendicularly');
});
