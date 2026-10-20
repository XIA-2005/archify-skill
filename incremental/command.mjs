import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {applyContentChanges} from './changes.mjs';
import {geometryPermissions, updateImpact, incrementalCandidate, assertFixedGeometry, geometryDifference, diagnosticRegion} from './layout.mjs';
import {compareArchitecture} from '../delta/architecture-delta.mjs';
import {compareSemantics, semanticHash} from '../draft/semantic.mjs';
import {centerLoneAttachments, loneAttachmentDefects} from '../draft/attachments.mjs';
import {draftMetrics} from '../draft/architecture.mjs';
import {qualityKey} from '../draft/quality.mjs';
import {createOwnedTempDirectory} from '../renderers/shared/owned-temp-directory.mjs';
import {validateAuthoredOutputPath} from '../renderers/shared/output-path.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => {const bytes = fs.readFileSync(path.resolve(file)); return {path: path.resolve(file), bytes, value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), sha256: digest(bytes)};};
const diagnostic = (code, message, subject = {}, evidence = {}) => ({code, severity: 'error', message, subject, evidence,
  supportedFixes: ['inspect the concrete diagnostic and approved new semantic input; preserve original artifacts and hard constraints']});
const exists = file => {try {fs.lstatSync(file); return true;} catch (error) {if (error.code === 'ENOENT') return false; throw error;}};
function child(args, env) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {cwd: process.cwd(), encoding: 'utf8', windowsHide: true,
    timeout: 45000, maxBuffer: 24 * 1024 * 1024, env: {...process.env, ...env}});
  let receipt; try {receipt = JSON.parse(result.stdout);} catch {}
  const ok = !result.error && result.status === 0 && receipt?.ok === true;
  return {ok, receipt, durationMs: Date.now() - started, diagnostics: receipt?.diagnostics ?? (ok ? [] : [diagnostic('update/child',
    'Canonical renderer/validator did not return a passing receipt.', {}, {status: result.status, error: result.error?.message, stderr: result.stderr?.slice(0, 2000)})])};
}
function resolvedCandidate(candidate, layout) {
  const copy = structuredClone(candidate);
  for (const node of copy.components) {
    const rect = layout.components.find(item => item.id === node.id);
    if (rect) {node.pos = [rect.x, rect.y]; node.size = [rect.width, rect.height];}
  }
  return copy;
}
function singletonRepair(candidate, layout, permission, attachmentEdges) {
  const defects = loneAttachmentDefects(resolvedCandidate(candidate, layout), layout)
    .filter(defect => attachmentEdges.includes(candidate.connections[defect.index]?.id)), allowed = [];
  for (const defect of defects) {
    const edge = candidate.connections[defect.index];
    if (permission.canChange('connections', edge.id, defect.end + 'Side') && permission.canChange('connections', edge.id, defect.end + 'Port')) allowed.push(defect);
  }
  for (const defect of allowed) {
    const edge = candidate.connections[defect.index];
    for (const field of ['route', 'via', 'channelX', 'channelY', 'labelAt', 'labelDx', 'labelDy', 'labelSegment']) {
      if (permission.canChange('connections', edge.id, field)) delete edge[field];
    }
  }
  centerLoneAttachments(candidate, allowed);
  return {defects, repaired: allowed};
}
function scopeFromFailure(result, candidate, current) {
  const found = diagnosticRegion(result.diagnostics, candidate);
  const additions = new Set(found);
  // When legacy constraint diagnostics contain no subject, the known affected
  // group's actual neighbors are the bounded next scope, not every graph node.
  if (!found.length) for (const edge of candidate.connections ?? []) {
    if (current.includes(edge.from) || current.includes(edge.to)) {additions.add(edge.from); additions.add(edge.to);}
  }
  return [...additions];
}

export async function updateArchitecture(baselineFile, proposalFile, approvedFile, outputFile,
  {geometryPolicyPath, repoRoot, mainPath = []} = {}) {
  const receipt = {schemaVersion: 1, command: 'update', type: 'architecture', ok: false,
    requestId: randomUUID(),
    input: path.resolve(baselineFile), output: path.resolve(outputFile), attempts: [], diagnostics: [],
    visualAcceptance: 'human-required', visualReview: 'not-requested', maxRepairs: 2, repairsUsed: 0};
  let temporary;
  try {
    if (exists(receipt.output)) throw Object.assign(Error('Update output already exists; use a new path.'), {code: 'update/output-exists'});
    const baseline = read(baselineFile), proposal = read(proposalFile), approved = read(approvedFile);
    const policyInput = geometryPolicyPath === undefined ? null : read(geometryPolicyPath);
    const bindings = [baseline, proposal, approved, ...(policyInput ? [policyInput] : [])];
    const content = applyContentChanges(baseline.value, proposal.value, {baselineBytes: baseline.bytes, baselineSha256: baseline.sha256, expectedSemantic: approved.value});
    validateAuthoredOutputPath(content.semantic.meta.output);
    const permission = geometryPermissions(baseline.value, policyInput?.value, baseline.sha256, content.boundaryMappings);
    const impact = updateImpact(baseline.value, content.semantic);
    const nodeIds = new Set(content.semantic.components.map(node => node.id));
    if (mainPath.some(id => !nodeIds.has(id)) || new Set(mainPath).size !== mainPath.length
      || mainPath.slice(1).some((id, index) => !(content.semantic.connections ?? []).some(edge => edge.from === mainPath[index] && edge.to === id))) {
      throw Object.assign(Error('Main path must use unique current IDs and real directed relationships.'), {code: 'update/main-path'});
    }
    if ((baseline.value.connections ?? []).some(edge => !edge.id) && impact.directEdges.length) {
      throw Object.assign(Error('Changed relationships require stable IDs on all baseline connections; record an explicit identity migration first.'), {code: 'update/ambiguous-relationship-identity'});
    }
    receipt.baseline = {path: baseline.path, sha256: baseline.sha256};
    receipt.approved = {path: approved.path, sha256: approved.sha256, semanticSha256: semanticHash(approved.value)};
    receipt.proposal = {path: proposal.path, sha256: proposal.sha256};
    receipt.geometryPolicy = {path: policyInput?.path, sha256: policyInput?.sha256, origin: permission.origin};
    receipt.content = {changes: content.changes, boundaryMappings: content.boundaryMappings, geometryTransfers: content.geometryTransfers, baselineBinding: content.baselineBinding};
    receipt.impact = impact;
    const delta = compareArchitecture(baseline.value, content.candidate);
    receipt.authoredDifference = delta;
    if (delta.coverage?.completeness === 'incomplete' || delta.completeness === 'incomplete') throw Object.assign(Error('A changed field cannot be classified; inspect the delta coverage before updating.'), {code: 'update/incomplete-delta'});
    temporary = createOwnedTempDirectory('archify-update-');
    const quality = content.semantic.meta.quality_profile ?? 'showcase';
    const env = {ARCHIFY_DIAGNOSTIC_FORMAT: 'json', ARCHIFY_QUALITY_PROFILE: quality, ...(repoRoot ? {ARCHIFY_REPO_ROOT: repoRoot} : {})};
    const render = (candidate, name) => {
      const file = path.join(temporary.path, name + '.json');
      fs.writeFileSync(file, JSON.stringify(candidate, null, 2) + '\n');
      return {file, ...child([path.join(root, 'renderers/architecture/render-architecture.mjs'), file, path.join(temporary.path, name + '.html'), '--layout-json'], env)};
    };
    const before = render(baseline.value, 'baseline');
    receipt.baselineLayout = {passed: before.ok, durationMs: before.durationMs};
    if (!before.ok) {receipt.diagnostics.push(diagnostic('update/untrusted-baseline', 'Baseline does not pass the current canonical geometry gates.', {}, {diagnostics: before.diagnostics})); return receipt;}
    let selected, expanded = [];
    for (let round = 0; round <= 2; round++) {
      receipt.repairsUsed = round;
      const plan = incrementalCandidate(baseline.value, content.candidate, {permission, impact, expandedNodes: expanded, round});
      assertFixedGeometry(baseline.value, plan.candidate, permission);
      let result = render(plan.candidate, 'round-' + round);
      const attachmentRepairs = [];
      // Endpoint centering is bounded deterministic geometry resolution within
      // this candidate, not another LLM/visual repair request.
      for (let pass = 0; result.receipt?.components?.length && result.receipt?.connections && pass < 2; pass++) {
        const correction = singletonRepair(plan.candidate, result.receipt, permission, plan.attachmentEdges);
        if (!correction.defects.length) break;
        if (!correction.repaired.length) {result.ok = false; result.diagnostics.push(diagnostic('update/fixed-singleton', 'A singleton attachment is off-center and cannot be changed under the geometry policy.', {}, correction)); break;}
        attachmentRepairs.push({pass: pass + 1, ...correction});
        result = render(plan.candidate, 'round-' + round);
      }
      if (result.ok) {
        const remaining = loneAttachmentDefects(resolvedCandidate(plan.candidate, result.receipt), result.receipt)
          .filter(defect => plan.attachmentEdges.includes(plan.candidate.connections[defect.index]?.id));
        if (remaining.length) {result.ok = false; result.diagnostics.push(diagnostic('update/singleton', 'Unresolved singleton endpoint defects.', {}, {remaining}));}
      }
      const attempt = {round, scope: plan.impact.relatedNodes, ledger: plan.ledger, clearedGeometry: plan.cleared,
        layoutPassed: result.ok, durationMs: result.durationMs, attachmentRepairs, diagnostics: [...result.diagnostics], artifactChecked: false};
      receipt.attempts.push(attempt);
      if (result.ok) {
        assertFixedGeometry(baseline.value, plan.candidate, permission);
        const semantic = compareSemantics(content.semantic, plan.candidate);
        if (!semantic.equivalent) throw Object.assign(Error('Geometry update changed approved semantics.'), {code: 'update/semantic-mismatch'});
        const difference = geometryDifference(baseline.value, plan.candidate, before.receipt, result.receipt, plan.impact);
        attempt.geometryDifference = difference;
        if (difference.unexplained.length) {
          attempt.layoutPassed = false;
          attempt.diagnostics.push(diagnostic('update/unexplained-geometry', 'Canonical routes/geometry changed outside the diagnosed region.', {}, {changes: difference.unexplained}));
          receipt.diagnostics.push(...attempt.diagnostics);
          return receipt; // Do not justify our own drift merely by enlarging its declared scope.
        } else {
          const artifact = child([path.join(root, 'bin/archify.mjs'), 'validate', 'architecture', result.file, '--json', '--quality', quality,
            ...(repoRoot ? ['--repo-root', repoRoot] : [])], env);
          attempt.artifactChecked = true; attempt.artifactPassed = artifact.ok; attempt.diagnostics.push(...artifact.diagnostics);
          if (artifact.ok) {
            const normalized = resolvedCandidate(plan.candidate, result.receipt);
            const metrics = draftMetrics(result.receipt, normalized, mainPath.length ? {mainPath} : undefined);
            attempt.metrics = metrics; attempt.rankKey = qualityKey(metrics);
            selected = {candidate: plan.candidate, file: result.file, geometry: result.receipt, attempt, semantic}; break;
          }
        }
      }
      const additions = scopeFromFailure({diagnostics: attempt.diagnostics}, plan.candidate, attempt.scope);
      const previous = [...expanded]; expanded = [...new Set([...expanded, ...additions])];
      attempt.scopeExpansion = {from: previous, to: expanded, reason: 'actual-canonical-diagnostics', diagnostics: attempt.diagnostics.map(item => item.code)};
    }
    if (!selected) {
      receipt.diagnostics.push(diagnostic('update/no-passing-layout', 'No incremental candidate passed within the shared two-repair budget.', {},
        {attempts: receipt.attempts.length, failedDiagnostics: receipt.attempts.map(attempt => ({round: attempt.round, diagnostics: attempt.diagnostics}))})); return receipt;
    }
    for (const input of bindings) if (digest(fs.readFileSync(input.path)) !== input.sha256) throw Object.assign(Error('An input changed during update preparation.'), {code: 'update/stale-input'});
    const bytes = Buffer.from(JSON.stringify(selected.candidate, null, 2) + '\n');
    const staged = path.join(path.dirname(receipt.output), '.archify-update-' + randomUUID() + '.tmp');
    try {fs.writeFileSync(staged, bytes, {flag: 'wx'}); fs.linkSync(staged, receipt.output);}
    finally {if (exists(staged)) fs.unlinkSync(staged);}
    receipt.ok = true; receipt.selected = {round: selected.attempt.round, strategy: 'preserve-and-diagnose-connected-region'};
    receipt.candidate = {path: receipt.output, sha256: digest(bytes), bytes: bytes.length};
    receipt.semantic = selected.semantic; receipt.geometryDifference = selected.attempt.geometryDifference;
    receipt.nextAction = {command: 'editor/deliver.mjs', arguments: ['architecture', receipt.output, content.semantic.meta.output,
      ...(repoRoot ? ['--repo-root', repoRoot] : []), '--json']};
    receipt.reviewWorkflow = {entry: 'draft/quality-session.mjs init-update', remainingRepairs: 2 - receipt.repairsUsed,
      visualAcceptance: 'human-required', note: 'Preparation repairs and later visual repairs share one request budget.'};
    return receipt;
  } catch (error) {
    receipt.diagnostics.push(...(error.archifyDiagnostics ?? [diagnostic(error.code ?? 'update/input-or-output', error.message)])); return receipt;
  } finally {
    if (temporary) try {await temporary.cleanup();} catch (error) {receipt.ok = false; receipt.diagnostics.push(diagnostic('update/cleanup', error.message));}
  }
}
