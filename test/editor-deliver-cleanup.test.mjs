import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const deliver = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../editor/deliver.mjs'),
  'utf8',
);

test('deliver kills the Windows editor process tree on startup failure', () => {
  assert.match(deliver, /function killEditorTree\s*\(/);
  assert.match(deliver, /taskkill'[\s\S]*?\/PID'[\s\S]*?\/T'[\s\S]*?\/F'/);
  assert.match(deliver, /killEditorTree\(\)/);
  assert.match(deliver, /editorPid:\s*child\.pid/);
});

test('deliver does not unref the editor child before the URL is reachable', () => {
  const timeoutCheck = deliver.indexOf("if(!url)throw Error('Editor startup timed out");
  const unrefCall = deliver.indexOf('child.unref();');
  const killCall = deliver.indexOf('killEditorTree();');
  assert.ok(timeoutCheck > 0, 'timeout check present');
  assert.ok(unrefCall > timeoutCheck, 'unref after URL timeout check');
  assert.ok(killCall > 0, 'kill on failure');
  assert.ok(unrefCall < killCall, 'success-path unref() precedes catch killEditorTree()');
});