import {loneAttachmentDefects, centerLoneAttachments} from './attachments.mjs';
import {compareSemantics} from './semantic.mjs';
import {compareDrafts, qualityKey, repairRecommendations} from './quality.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {architectureDrafts, draftMetrics} from './architecture.mjs';
import {INTENT_CONTRACT, rejectIntent} from './intent.mjs';
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

export async function draftArchitecture(input, output, {repoRoot, composition, mainPath, intentPath} = {}) {
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
    let intent;
    if (intentPath !== undefined) {
      if (composition !== undefined || mainPath !== undefined) {
        rejectIntent('options', 'Choose --intent or legacy composition/main-path options, not both.');
      }
      const source = path.resolve(intentPath);
      try {
        const bytes = fs.readFileSync(source);
        intent = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
        receipt.intent = {contract: INTENT_CONTRACT, path: source, sha256: hash(bytes), bytes: bytes.length};
      } catch (error) {
        rejectIntent('input', 'Could not read the intent JSON.', {path: source}, {reason: error.message});
      }
    }
    // Schema, fixed-geometry and intent checks all run before sizing/placement.
    const proposals = architectureDrafts(semantic, {composition, mainPath, intent});
    if (receipt.intent) receipt.intent.plan = proposals[0]?.intent;
    receipt.selectionPolicy = 'semantic-and-artifact-gates-then-lexicographic-v1';
    receipt.structures = [...new Set(proposals.map(p => p.structure || p.id))];
    receipt.rejectedStructures = proposals.rejected || [];
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
      let result = run([path.join(root, 'renderers/architecture/render-architecture.mjs'), candidatePath,
        path.join(temporary.path, 'unused.html'), '--layout-json'], env);
      const geometryRepairs = [];
      for (let pass = 0; result.ok && pass < 2; pass++) {
        const defects = loneAttachmentDefects(proposal.candidate, result.receipt);
        if (!defects.length) break;
        geometryRepairs.push({pass: pass + 1, defects});
        centerLoneAttachments(proposal.candidate, defects);
        fs.writeFileSync(candidatePath, JSON.stringify(proposal.candidate, null, 2) + '\n');
        result = run([path.join(root, 'renderers/architecture/render-architecture.mjs'), candidatePath,
          path.join(temporary.path, 'unused.html'), '--layout-json'], env);
      }
      if (result.ok) {
        const defects = loneAttachmentDefects(proposal.candidate, result.receipt);
        if (defects.length) result = {ok: false, diagnostics: [failure('draft/lone-attachment',
          'Generated singleton attachments remain off-center.', {}, {defects})]};
      }
      const attempt = {id: proposal.id, structure: proposal.structure, geometryRepairs,
        layoutPassed: result.ok, artifactChecked: false, diagnostics: result.diagnostics};
      receipt.attempts.push(attempt);
      if (result.ok) {
        attempt.semantic = compareSemantics(semantic, proposal.candidate);
        if (!attempt.semantic.equivalent) {
          attempt.layoutPassed = false;
          attempt.diagnostics.push(failure('draft/semantic-mismatch', 'A layout proposal changed non-geometric content.'));
          attempt.selectionReason = 'semantic-mismatch';
          continue;
        }
        attempt.metrics = draftMetrics(result.receipt, proposal.candidate, proposal.intent);
        attempt.rankKey = qualityKey(attempt.metrics);
        passing.push({...proposal, candidatePath, attempt});
      }
    }
    passing.sort(compareDrafts);
    receipt.ranked = passing.map(proposal => proposal.id);
    let selected;
    for (const proposal of passing) {
      const validation = run([path.join(root, 'bin/archify.mjs'), 'validate', 'architecture', proposal.candidatePath,
        '--json', '--quality', quality, ...(repoRoot ? ['--repo-root', repoRoot] : [])], env);
      proposal.attempt.artifactChecked = true;
      proposal.attempt.artifactPassed = validation.ok;
      proposal.attempt.diagnostics.push(...validation.diagnostics);
      if (validation.ok) { selected = proposal; proposal.attempt.selectionReason = 'best-ranked-artifact-valid'; break; }
      proposal.attempt.selectionReason = 'artifact-gate-failed';
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
    receipt.semantic = selected.attempt.semantic;
    for (const attempt of receipt.attempts) attempt.selectionReason ??= attempt.layoutPassed
      ? 'lower-ranked-not-artifact-checked' : 'layout-gate-failed';
    receipt.reviewRecommendations = repairRecommendations(metrics);
    receipt.reviewWorkflow = {entry: 'draft/quality-session.mjs', maxRepairs: 2,
      action: 'record-real-image-review-after-delivery', visualAcceptance: 'human-required'};
    if (metrics.desktopText[0]?.projectedPx < 7.5) receipt.reviewRecommendations.push({
      code: 'draft/desktop-text', severity: 'warning', subject: metrics.desktopText[0].owner,
      evidence: {viewport: [1440, 900], targetPx: 7.5, texts: metrics.desktopText, estimateOnly: true},
      supportedFixes: ['compact empty corridors or choose another composition; preserve complete text and explicit font sizes; inspect the actual desktop screenshots'],
    });
    if (metrics.estimatedDiagramHeightPx > 774) receipt.reviewRecommendations.push({
      code: 'draft/tall-composition', severity: 'warning', subject: {composition: receipt.intent ? 'intent-bands' : composition || 'layered'},
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
