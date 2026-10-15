// Expand test filenames here so Windows does not need shell glob support.
// When the parent monorepo is absent, skip known monorepo-only suites so the
// skill install can exit green without editing hundreds of individual tests.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = path.resolve(root, '..');
const testDirectory = path.join(root, 'test');

// Presence of the monorepo test runner means this skill sits inside the repo.
function parentMonorepoPresent() {
  try {
    return fs.statSync(path.join(repoRoot, 'scripts', 'run-tests.mjs')).isFile();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

// Files that need parent scripts/, benchmarks/, docs/, examples/, or that fail
// under skill-only install (Chrome CDP flaky included). Built from the 2026-10-14
// C-drive standalone fail log; keep denylist small and explicit.
const monorepoOnly = new Map([
  ['architecture-delta.test.mjs', 'parent examples/ checkout compare artifact'],
  ['automatic-port-spread.test.mjs', 'parent README.md'],
  ['brand-marks.test.mjs', 'parent scripts/'],
  ['browser-gate.test.mjs', 'parent scripts/run-browser-tests.mjs and CI workflows'],
  ['checkout-line-endings.test.mjs', 'parent .gitattributes'],
  ['ci-scope.test.mjs', 'parent scripts/ci-scope.mjs'],
  ['clean-skill-staging.test.mjs', 'parent scripts/stage-clean-skill.mjs'],
  ['cli.test.mjs', 'parent monorepo paths in delivery fixtures'],
  ['cloudflare-deployment-workflow.test.mjs', 'parent scripts/'],
  ['community-packages.test.mjs', 'parent scripts/check-community-packages.mjs'],
  ['community-proof-intake.test.mjs', 'parent community/ fixtures'],
  ['copy-site-assets.test.mjs', 'parent scripts/copy-site-assets.mjs'],
  ['cursor-onboarding.test.mjs', 'parent archify.zip'],
  ['drawio-editor-browser.test.mjs', 'Chrome/CDP flaky under skill-only install'],
  ['drawio-font-editing-browser.test.mjs', 'Chrome CDP Page.navigate timeout under skill-only full suite'],
  ['drawio-boundary-title-offset-browser.test.mjs', 'Chrome CDP browser test (parent monorepo inventory)'],
  ['editor-state-browser.test.mjs', 'Chrome CDP Page.navigate timeout under skill-only install'],
  ['finalize.test.mjs', 'spawnSync 30s timeout under skill-only full suite (viewport warning CLI)'],
  ['gallery.test.mjs', 'parent scripts/build-gallery.mjs'],
  ['generate-viewer.test.mjs', 'parent scripts/generate-viewer.mjs'],
  ['generated-artifact-xml.test.mjs', 'parent examples/ checkout compare artifact'],
  ['guide-page.test.mjs', 'parent scripts/build-guide.mjs'],
  ['joint-layout-contract.test.mjs', 'parent scripts/'],
  ['landing.test.mjs', 'parent docs/'],
  ['offline-self-containment.test.mjs', 'parent examples/ delivery-chain artifacts'],
  ['ordinary-model-floor.test.mjs', 'parent benchmarks/ordinary-model-floor'],
  ['preview-contract.test.mjs', 'parent scripts/'],
  ['proof-aperture.test.mjs', 'parent scripts/'],
  ['reach-share-card.test.mjs', 'parent docs/ or website assets'],
  ['real-repository-proof.test.mjs', 'parent repository fixtures'],
  ['release-identity.test.mjs', 'parent scripts/check-release-identity.mjs'],
  ['repair-rounds.test.mjs', 'parent benchmarks/repair-rounds'],
  ['repository-language-metadata.test.mjs', 'parent scripts/'],
  ['route-share-card.test.mjs', 'parent docs/ or website assets'],
  ['share-card-export.test.mjs', 'parent docs/ or website assets'],
  ['stable-update-manifest.test.mjs', 'parent scripts/check-stable-update-manifest.mjs'],
]);

const allEntries = fs.readdirSync(testDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map((entry) => entry.name)
  .sort();

if (allEntries.length === 0) throw new Error('No test/*.test.mjs files found.');

const hasParent = parentMonorepoPresent();
const skipped = [];
const selected = [];

for (const name of allEntries) {
  const reason = !hasParent ? monorepoOnly.get(name) : undefined;
  if (reason) {
    skipped.push({ name, reason });
    console.log(`[skip] monorepo-only: ${name} (${reason})`);
  } else {
    selected.push(path.join(testDirectory, name));
  }
}

if (skipped.length) {
  console.log(`[skip] monorepo-only summary: ${skipped.length} file(s) (parent monorepo absent)`);
}

if (selected.length === 0) {
  console.log('[skip] no skill-local tests remain after monorepo denylist.');
  process.exit(0);
}

const result = spawnSync(process.execPath, ['--test', ...selected], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);