import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertCustomization, assertBeforeApplyUpdate } from '../scripts/assert-customization.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(skillRoot, 'scripts/assert-customization.mjs');

test('assert-customization exits 0 for a matching fixture', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-assert-ok-'));
  try {
    const tracked = path.join(root, 'tracked.txt');
    fs.writeFileSync(tracked, 'canonical\n');
    const sha = crypto.createHash('sha256').update(fs.readFileSync(tracked)).digest('hex');
    fs.writeFileSync(path.join(root, 'customization-manifest.json'), JSON.stringify({
      schemaVersion: 1, files: [{ path: 'tracked.txt', sha256: sha }],
    }));
    const result = assertCustomization({ root });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.mismatches.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assert-customization exits non-zero when a listed file is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-assert-miss-'));
  try {
    fs.writeFileSync(path.join(root, 'customization-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      files: [{ path: 'gone.txt', sha256: 'a'.repeat(64) }],
    }));
    const result = assertCustomization({ root });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.mismatches[0].reason, 'missing');
    assert.throws(() => assertBeforeApplyUpdate({ root }), /customization-manifest drift/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assert-customization exits non-zero when a listed hash is tampered', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-assert-tamper-'));
  try {
    const tracked = path.join(root, 'tracked.txt');
    fs.writeFileSync(tracked, 'canonical\n');
    fs.writeFileSync(path.join(root, 'customization-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      files: [{ path: 'tracked.txt', sha256: 'b'.repeat(64) }],
    }));
    const result = assertCustomization({ root });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.mismatches[0].reason, 'hash-mismatch');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assert-customization CLI prints JSON and uses a non-zero exit on live drift or zero when clean', () => {
  const cli = spawnSync(process.execPath, [script], { cwd: skillRoot, encoding: 'utf8' });
  assert.ok([0, 1].includes(cli.status), cli.stderr);
  const parsed = JSON.parse(cli.stdout);
  assert.equal(typeof parsed.ok, 'boolean');
  assert.equal(parsed.exitCode, parsed.ok ? 0 : 1);
});
