#!/usr/bin/env node
// Fail-closed check: on-disk skill files must match customization-manifest.json.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function assertCustomization({
  root = defaultRoot,
  manifestPath = path.join(root, 'customization-manifest.json'),
} = {}) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      exitCode: 1,
      error: error.code === 'ENOENT' ? 'manifest-missing' : 'manifest-unreadable',
      detail: error.message,
      mismatches: [],
    };
  }
  if (!Array.isArray(manifest.files)) {
    return { ok: false, exitCode: 1, error: 'manifest-invalid', mismatches: [] };
  }

  const mismatches = [];
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      mismatches.push({ path: entry?.path || '(invalid-entry)', reason: 'manifest-entry-invalid' });
      continue;
    }
    const file = path.join(root, entry.path);
    let bytes;
    try {
      bytes = fs.readFileSync(file);
    } catch (error) {
      mismatches.push({
        path: entry.path,
        reason: error.code === 'ENOENT' ? 'missing' : 'unreadable',
        expected: entry.sha256,
        detail: error.message,
      });
      continue;
    }
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== entry.sha256) {
      mismatches.push({
        path: entry.path,
        reason: 'hash-mismatch',
        expected: entry.sha256,
        actual,
      });
    }
  }

  if (mismatches.length) {
    return {
      ok: false,
      exitCode: 1,
      error: 'customization-drift',
      filesChecked: manifest.files.length,
      mismatches,
    };
  }
  return {
    ok: true,
    exitCode: 0,
    filesChecked: manifest.files.length,
    mismatches: [],
  };
}

export function assertBeforeApplyUpdate(options = {}) {
  const result = assertCustomization(options);
  if (!result.ok) {
    const error = new Error('Refusing to apply an update while customization-manifest drift is present. Compare editor/, SKILL.md, and other listed files before any whole-package overwrite.');
    error.code = 'CUSTOMIZATION_DRIFT';
    error.result = result;
    throw error;
  }
  return result;
}

const isMain = Boolean(process.argv[1])
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const result = assertCustomization();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.exitCode);
}
