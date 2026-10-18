import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {architectureDrafts, draftMetrics} from './architecture.mjs';
import {createOwnedTempDirectory} from '../renderers/shared/owned-temp-directory.mjs';
import {validateAuthoredOutputPath} from '../renderers/shared/output-path.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (code, message, subject = {}, evidence = {}, fixes = []) => ({
  code, severity: 'error', message, subject, evidence, supportedFixes: fixes,
});

function run(args, env) {
  const child = spawnSync(process.execPath, args, {encoding: 'utf8', timeout: 30000,
    maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: {...process.env, ...env}});
  let receipt;
  try { receipt = JSON.parse(child.stdout); } catch { /* Report unusable output below. */ }
  const ok = !child.error && child.status === 0 && receipt?.ok === true;
  const diagnostics = receipt?.diagnostics || (ok ? [] : [failure('draft/child-failed',
    'The renderer/checker did not produce a passing receipt.', {},
    {status: child.status, reason: child.error?.message || child.stderr?.slice(0, 2000)},
    ['inspect the child failure before retrying; no quality gate was bypassed'])]);
  return {ok, receipt, diagnostics};
}

export async function draftArchitecture(input, output, {repoRoot, composition, mainPath} = {}) {
  const inputPath = path.resolve(input), outputPath = path.resolve(output);
  const receipt = {schemaVersion: 1, command: 'draft', type: 'architecture', ok: false,
    input: inputPath, output: outputPath, attempts: [], diagnostics: [], visualReview: 'not-requested'};
  let temporary;
  try {
    // Only publish new candidates: never replace an existing file or symlink,
    // including an input alias. Failed planning leaves all prior work intact.
    if (fs.existsSync(outputPath) || (() => { try { fs.lstatSync(outputPath); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } })()) {
      receipt.diagnostics.push(failure('draft/output-exists', 'Draft output already exists.', {output: outputPath}, {}, ['choose a new candidate path; keep the existing candidate']));
      return receipt;
    }
    const inputBytes = fs.readFileSync(inputPath);
    receipt.inputSha256 = hash(inputBytes);
    const semantic = JSON.parse(inputBytes.toString('utf8'));
    // Schema validation runs inside the planner before accessing required fields.
    const proposals = architectureDrafts(semantic, {composition, mainPath});
    validateAuthoredOutputPath(semantic.meta.output);
    const quality = semantic.meta.quality_profile ?? 'showcase';
    temporary = createOwnedTempDirectory('archify-draft-');
    const env = {ARCHIFY_DIAGNOSTIC_FORMAT: 'json', ARCHIFY_QUALITY_PROFILE: quality,
      ...(repoRoot ? {ARCHIFY_REPO_ROOT: repoRoot} : {})};
    const passing = [];
    for (const proposal of proposals) {
      proposal.candidate.meta.quality_profile = quality;
      const candidatePath = path.join(temporary.path, `${proposal.id}.json`);
      fs.writeFileSync(candidatePath, JSON.stringify(proposal.candidate, null, 2) + '\n', {flag: 'wx'});
      const result = run([path.join(root, 'renderers/architecture/render-architecture.mjs'), candidatePath,
        path.join(temporary.path, 'unused.html'), '--layout-json'], env);
      const attempt = {id: proposal.id, layoutPassed: result.ok, artifactChecked: false, diagnostics: result.diagnostics};
      receipt.attempts.push(attempt);
      if (result.ok) {
        attempt.metrics = draftMetrics(result.receipt, proposal.candidate);
        passing.push({...proposal, candidatePath, attempt});
      }
    }
    passing.sort((a, b) => a.attempt.metrics.score - b.attempt.metrics.score || a.id.localeCompare(b.id));
    let selected;
    for (const proposal of passing) {
      const validation = run([path.join(root, 'bin/archify.mjs'), 'validate', 'architecture', proposal.candidatePath,
        '--json', '--quality', quality, ...(repoRoot ? ['--repo-root', repoRoot] : [])], env);
      proposal.attempt.artifactChecked = true;
      proposal.attempt.artifactPassed = validation.ok;
      proposal.attempt.diagnostics.push(...validation.diagnostics);
      if (validation.ok) { selected = proposal; break; }
    }
    if (!selected) {
      receipt.diagnostics.push(failure('draft/no-passing-layout', 'No generated layout passed the existing checks.', {},
        {attempts: receipt.attempts.length}, ['inspect attempt diagnostics; preserve the semantic input and use manual geometry under the authoring contract']));
      return receipt;
    }
    const bytes = fs.readFileSync(selected.candidatePath);
    // A hard link publishes complete bytes with no replacement. Stage alongside
    // the output so publication stays on one filesystem, including Windows.
    const staged = path.join(path.dirname(outputPath), `.archify-draft-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(staged, bytes, {flag: 'wx'});
      fs.linkSync(staged, outputPath);
    } finally {
      if (fs.existsSync(staged)) fs.unlinkSync(staged);
    }
    receipt.ok = true;
    receipt.selected = selected.id;
    receipt.candidate = {path: outputPath, sha256: hash(bytes), bytes: bytes.length};
    receipt.quality = quality;
    const metrics = selected.attempt.metrics;
    receipt.reviewRecommendations = [];
    if (metrics.desktopText[0]?.projectedPx < 7.5) receipt.reviewRecommendations.push({
      code: 'draft/desktop-text', severity: 'warning', subject: metrics.desktopText[0].owner,
      evidence: {viewport: [1440, 900], targetPx: 7.5, texts: metrics.desktopText, estimateOnly: true},
      supportedFixes: ['compact empty corridors or choose another composition; preserve complete text and explicit font sizes; inspect the actual desktop screenshots'],
    });
    if (metrics.estimatedDiagramHeightPx > 774) receipt.reviewRecommendations.push({
      code: 'draft/tall-composition', severity: 'warning', subject: {composition: composition || 'layered'},
      evidence: {estimatedDiagramHeightPx: metrics.estimatedDiagramHeightPx, availableHeightPx: 774, estimateOnly: true},
      supportedFixes: ['for a real loop use feedback with its directed main path; otherwise reflow the connected scene; verify full-diagram readability in screenshots'],
    });
    for (const corridor of metrics.counterflowCorridors) receipt.reviewRecommendations.push({
      code: 'draft/counterflow-corridor', severity: 'warning', subject: {relationships: corridor.relationships},
      evidence: corridor,
      supportedFixes: ['separate the incoming and outgoing sides of the shared node; reserve a distinct return corridor and recheck every affected relationship'],
    });
    receipt.nextAction = {command: 'editor/deliver.mjs', arguments: ['architecture', outputPath, semantic.meta.output,
      ...(repoRoot ? ['--repo-root', repoRoot] : []), '--json']};
    return receipt;
  } catch (error) {
    receipt.diagnostics.push(...(error.archifyDiagnostics || [failure('draft/input-or-output', error.message,
      {input: inputPath, output: outputPath}, {systemCode: error.code}, ['correct the reported input or filesystem error and retry with a new output path'])]));
    return receipt;
  } finally {
    if (temporary) try { await temporary.cleanup(); } catch (error) {
      receipt.ok = false;
      receipt.diagnostics.push(failure('draft/cleanup', error.message, {directory: temporary.path}, {}, ['inspect the retained temporary directory']));
    }
  }
}
