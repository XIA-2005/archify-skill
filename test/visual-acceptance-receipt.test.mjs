import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  'editor/deliver.mjs',
  'bin/visual-check.mjs',
  'bin/finalize.mjs',
].map((rel) => ({ rel, text: fs.readFileSync(path.join(root, rel), 'utf8') }));

test('delivery sources never assign visualAcceptance or visualReview to passed', () => {
  for (const { rel, text } of sources) {
    assert.doesNotMatch(text, /visualAcceptance\s*:\s*['"]passed['"]/, rel);
    assert.doesNotMatch(text, /visualReview\s*:\s*['"]passed['"]/, rel);
  }
});

test('deliver receipt locks human-required acceptance and pending image inspection', () => {
  const text = sources.find((entry) => entry.rel === 'editor/deliver.mjs').text;
  assert.match(text, /visualAcceptance\s*:\s*'human-required'/);
  assert.match(text, /visualReview\s*:\s*'pending-image-inspection'/);
  assert.match(text, /screenshotEvidence\s*\(/);
  assert.match(text, /screenshots\s*:\s*screenshotEvidence\(capture\)/);
});

test('visual-check and finalize receipts mark acceptance as human-required', () => {
  const visual = sources.find((entry) => entry.rel === 'bin/visual-check.mjs').text;
  const finalize = sources.find((entry) => entry.rel === 'bin/finalize.mjs').text;
  assert.match(visual, /visualAcceptance:\s*capture \? 'human-required'/);
  assert.match(finalize, /visualAcceptance:\s*'human-required'/);
});
