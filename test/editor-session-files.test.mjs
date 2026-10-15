import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startEditor } from './editor-test-helpers.mjs';
import { createSessionFiles } from '../editor/session-files.mjs';

function candidate(schema) {
  const c = schema ? JSON.parse(fs.readFileSync(new URL('../examples/agent-tool-call.workflow.json', import.meta.url), 'utf8'))
    : { schema_version: 1, diagram_type: 'architecture', meta: { title: 'Synthetic session' }, components: [{ id: 'a', type: 'backend', label: 'Synthetic A', pos: [200,200], size: [160,80] }] };
  c.meta.output = 'views/inner/diagram.html';
  return c;
}
function setup(dir) { fs.mkdirSync(path.join(dir, 'views/inner'), { recursive: true }); }
async function refused(base, route, status, code) {
  const response = await fetch(base + route);
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, code);
  assert.ok(body.message);
}

for (const schema of [false, true]) {
  const label = schema ? 'schema' : 'architecture';
  for (const existing of [false, true]) test(`${label} original reads support ${existing ? 'existing' : 'initially absent'} files and safe updates`, async t => {
    const { base, dir, server } = await startEditor(t, candidate(schema), schema, dir => {
      setup(dir);
      if (existing) fs.writeFileSync(path.join(dir, 'views/inner/diagram.html'), '<p>synthetic first</p>');
    });
    const output = path.join(dir, 'views/inner/diagram.html');
    if (existing) assert.equal(await (await fetch(base + 'original')).text(), '<p>synthetic first</p>');
    else await refused(base, 'original', 404, 'EDITOR_FILE_NOT_FOUND');
    fs.writeFileSync(output, '<p>synthetic current</p>');
    assert.equal(await (await fetch(base + 'original')).text(), '<p>synthetic current</p>');
    const replacement = path.join(dir, 'views/inner/replacement.html');
    fs.writeFileSync(replacement, '<p>synthetic replacement</p>');
    fs.renameSync(replacement, output);
    assert.equal(await (await fetch(base + 'original')).text(), '<p>synthetic replacement</p>');
    fs.unlinkSync(output);
    fs.mkdirSync(output);
    await refused(base, 'original', 409, 'EDITOR_FILE_UNSAFE');
    fs.rmdirSync(output);
    await refused(base, 'original', 404, 'EDITOR_FILE_NOT_FOUND');
    assert.equal((await fetch(base + 'api/spec')).status, 200);
    assert.equal(server.exitCode, null);
  });

  test(`${label} refuses a replaced ancestor and requires a new session`, async t => {
    const { base, dir } = await startEditor(t, candidate(schema), schema, setup);
    const views = path.join(dir, 'views');
    fs.renameSync(views, views + '-old');
    setup(dir);
    fs.writeFileSync(path.join(views, 'inner/diagram.html'), 'synthetic replacement');
    await refused(base, 'original', 409, 'EDITOR_SESSION_CHANGED');
    fs.rmSync(views, { recursive: true });
    fs.renameSync(views + '-old', views);
    await refused(base, 'api/spec', 409, 'EDITOR_SESSION_CHANGED');
  });

  for (const existing of [false, true]) test(`${label} ${process.platform === 'win32' ? 'junction' : 'directory symlink'} redirect fails closed (${existing ? 'existing' : 'absent'} original)`, async t => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-session-synthetic-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.mkdirSync(path.join(outside, 'inner'));
    fs.writeFileSync(path.join(outside, 'inner/diagram.html'), 'SYNTHETIC_OUTSIDE_MARKER');
    const { base, dir, server } = await startEditor(t, candidate(schema), schema, dir => {
      setup(dir);
      if (existing) fs.writeFileSync(path.join(dir, 'views/inner/diagram.html'), 'synthetic original');
    });
    const before = await fetch(base + 'original');
    assert.equal(before.status, existing ? 200 : 404);
    const views = path.join(dir, 'views');
    fs.renameSync(views, views + '-old');
    fs.symlinkSync(outside, views, process.platform === 'win32' ? 'junction' : 'dir');
    await refused(base, 'original', 409, 'EDITOR_SESSION_CHANGED');
    await refused(base, 'api/spec', 409, 'EDITOR_SESSION_CHANGED');
    const response = await fetch(base + 'api/save', { method: 'POST', headers: {
      origin: new URL(base).origin, 'x-archify-editor': '1', 'content-type': 'application/json',
    }, body: JSON.stringify({ candidate: candidate(schema), expectedHash: 'unused' }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'EDITOR_SESSION_CHANGED');
    assert.equal(fs.readFileSync(path.join(outside, 'inner/diagram.html'), 'utf8'), 'SYNTHETIC_OUTSIDE_MARKER');
    assert.deepEqual(fs.readdirSync(outside), ['inner']);
    assert.equal(server.exitCode, null);
  });
}

test('read rechecks directories after a change during descriptor capture', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-session-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  setup(dir);
  const output = path.join(dir, 'views/inner/diagram.html');
  fs.writeFileSync(output, 'synthetic original');
  const files = createSessionFiles(dir, [output]);
  const open = fs.openSync;
  let swapped = false;
  t.mock.method(fs, 'openSync', function(file, ...args) {
    if (file === output && !swapped) {
      swapped = true;
      fs.renameSync(path.join(dir, 'views'), path.join(dir, 'old-views'));
      setup(dir);
      fs.writeFileSync(output, 'synthetic replacement');
    }
    return open.call(this, file, ...args);
  });
  assert.throws(() => files.read(output), { code: 'EDITOR_SESSION_CHANGED' });
  assert.equal(swapped, true);
});

for (const schema of [false, true]) test(`unchanged ${schema ? 'schema' : 'architecture'} session can preview, save and back up`, { timeout: 120000 }, async t => {
  const c = candidate(schema);
  c.meta.quality_profile = 'standard';
  const { base, dir, input } = await startEditor(t, c, schema, setup);
  const originalBytes = fs.readFileSync(input);
  const spec = await (await fetch(base + 'api/spec')).json();
  const post = (route, payload) => fetch(base + route, { method: 'POST', headers: {
    origin: new URL(base).origin, 'x-archify-editor': '1', 'content-type': 'application/json',
  }, body: JSON.stringify(payload) });
  const preview = await post(schema ? 'api/preview' : 'api/image-preview', schema ? { candidate: c } : c);
  assert.equal(preview.status, 200, JSON.stringify(await preview.json()));
  c.meta.title = 'Synthetic saved title';
  const saved = await post('api/save', { candidate: c, expectedHash: spec.expectedHash });
  const result = await saved.json();
  assert.equal(saved.status, 200, JSON.stringify(result));
  assert.equal(result.ok, true);
  assert.deepEqual(fs.readFileSync(result.backup), originalBytes);
  assert.equal(JSON.parse(fs.readFileSync(input)).meta.title, c.meta.title);
  const original = await fetch(base + 'original');
  assert.equal(original.status, 200);
  assert.match(await original.text(), /Synthetic saved title/);
});

for (const schema of [false, true]) test(`${schema ? 'schema' : 'architecture'} rejects a leaf link without returning its target`, async t => {
  const { base, dir, server } = await startEditor(t, candidate(schema), schema, setup);
  const target = path.join(dir, 'synthetic-target.html');
  fs.writeFileSync(target, 'SYNTHETIC_LINK_TARGET');
  try { fs.symlinkSync(target, path.join(dir, 'views/inner/diagram.html'), 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Windows file symlink privilege unavailable; junction cases run separately');
      return;
    }
    throw error;
  }
  await refused(base, 'original', 409, 'EDITOR_FILE_UNSAFE');
  assert.equal(server.exitCode, null);
});

test('read rejects file replacement during content capture', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-session-file-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'diagram.html');
  fs.writeFileSync(file, 'synthetic before');
  const files = createSessionFiles(dir, [file]);
  const read = fs.readSync;
  let swapped = false;
  t.mock.method(fs, 'readSync', function(...args) {
    const count = read.apply(this, args);
    if (!swapped) {
      swapped = true;
      fs.renameSync(file, path.join(dir, 'old.html'));
      fs.writeFileSync(file, 'synthetic after');
    }
    return count;
  });
  assert.throws(() => files.read(file), { code: 'EDITOR_FILE_UNSAFE' });
  assert.equal(swapped, true);
  t.mock.restoreAll();
  assert.equal(files.read(file, 'utf8'), 'synthetic after');
});
