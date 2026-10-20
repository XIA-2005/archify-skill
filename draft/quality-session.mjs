#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {compareSemantics, semanticHash} from './semantic.mjs';
import {geometryPermissions, assertFixedGeometry} from '../incremental/layout.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const requireValue = (condition, message) => { if (!condition) throw Error(message); };
export function createQualitySession(semantic, intent, identity = randomUUID(), preparationRepairsUsed = 0) {
  requireValue(Number.isInteger(preparationRepairsUsed) && preparationRepairsUsed >= 0 && preparationRepairsUsed <= 2, 'Preparation repairs must be within the same two-repair budget.');
  return {schemaVersion: 1, requestId: identity, revision: 1, status: 'awaiting-review',
    semantic, semanticSha256: semanticHash(semantic), intentSha256: semanticHash(intent),
    preparationRepairsUsed, repairsUsed: preparationRepairsUsed, maxRepairs: 2, history: [], best: null, bestValid: null};
}
export function defectAction(defects) {
  if (defects.some(d => d.kind === 'semantic')) return 'correct-semantic-input';
  if (defects.some(d => ['composition', 'shared-crowding', 'repair-conflict'].includes(d.kind))) return 'reflow-connected-group';
  if (defects.some(d => d.kind === 'route')) return 'repair-local-route';
  if (defects.length) return 'repair-local-label';
  return 'accept';
}
// Pure state transition: file/hash/provenance and reviewer evidence are checked
// by recordReview below. Rebuilding a draft cannot reset this request's budget.
export function advanceQualitySession(state, submission) {
  requireValue(state.status === 'awaiting-review', 'This request is sealed; do not reset a repair budget by rebuilding candidates.');
  requireValue(submission.expectedRevision === state.revision, 'Stale quality-session revision.');
  requireValue(submission.technicalPassed && submission.semanticEquivalent, 'Hard failures cannot enter the best-result pool.');
  requireValue(!state.history.some(h => h.candidateSha256 === submission.candidateSha256), 'Unchanged candidate already reviewed; do not repeat full delivery.');
  const preparationRepairsUsed = state.preparationRepairsUsed ?? 0;
  requireValue(Number.isInteger(preparationRepairsUsed) && preparationRepairsUsed >= 0 && preparationRepairsUsed <= 2, 'Invalid preparation repair budget.');
  const repairsUsed = preparationRepairsUsed + Math.max(0, state.history.length);
  requireValue(repairsUsed <= state.maxRepairs, 'The request has exhausted its two repair rounds.');
  const review = submission.review;
  requireValue(['accept', 'rework', 'reject'].includes(review.decision), 'Unknown review decision.');
  requireValue(typeof review.reviewer === 'string' && review.reviewer.trim(), 'A real image reviewer must identify itself.');
  requireValue(Array.isArray(review.defects), 'List specific defects, or an empty list after actual inspection.');
  for (const defect of review.defects) requireValue(
    ['semantic', 'composition', 'shared-crowding', 'repair-conflict', 'route', 'label'].includes(defect.kind)
    && typeof defect.description === 'string' && defect.description.trim()
    && Array.isArray(defect.subjects) && defect.subjects.length > 0,
    'Each defect needs a known kind, affected subjects and a concrete description.');
  const action = defectAction(review.defects);
  requireValue(action !== 'correct-semantic-input', 'Semantic corrections require a separately recorded semantic revision, not a layout success.');
  requireValue(review.decision !== 'accept' || !review.defects.some(d => d.unacceptable), 'Unacceptable defects cannot be visually accepted.');
  const next = structuredClone(state);
  next.repairsUsed = repairsUsed; next.revision++;
  const entry = {round: repairsUsed, candidateSha256: submission.candidateSha256,
    artifactSha256: submission.artifactSha256, delivery: submission.delivery,
    review: structuredClone(review), action, replacesBest: false};
  const version = result => ({candidateSha256: result.candidateSha256, artifactSha256: result.artifactSha256,
    delivery: result.delivery, round: result.round});
  // A technically valid fallback must survive even if every image review fails.
  // Older sessions already contain the verified first delivery in their history.
  next.bestValid ??= version(state.best || state.history[0] || entry);
  if (review.replaceBest === true && review.decision !== 'reject' && !review.defects.some(d => d.unacceptable)) {
    requireValue(typeof review.comparison === 'string' && review.comparison.trim(), 'Replacing the best requires an explicit visual comparison.');
    next.best = {candidateSha256: entry.candidateSha256, artifactSha256: entry.artifactSha256,
      delivery: entry.delivery, round: entry.round}; next.bestValid = structuredClone(next.best); entry.replacesBest = true;
  }
  requireValue(review.decision !== 'accept' || entry.replacesBest, 'Accept only the reviewed best version.');
  next.history.push(entry);
  next.status = review.decision === 'accept' ? 'accepted' : repairsUsed === state.maxRepairs ? 'visual-failed' : 'awaiting-review';
  next.nextAction = next.status === 'accepted' ? 'deliver-best' : next.status === 'visual-failed'
    ? 'return-best-with-explicit-visual-failure' : action;
  return next;
}
export function recordReview(state, deliveryFile, reviewFile) {
  const delivery = read(deliveryFile), review = read(reviewFile);
  requireValue(delivery.ok === true && Object.values(delivery.gates || {}).length >= 4
    && Object.values(delivery.gates).every(gate => gate === 'pass'), 'Use a complete passing editor/deliver.mjs receipt.');
  const sourceBytes = fs.readFileSync(delivery.source), artifactBytes = fs.readFileSync(delivery.artifact.path);
  const candidateSha256 = hash(sourceBytes), artifactSha256 = hash(artifactBytes);
  requireValue(candidateSha256 === delivery.specification.sha256 && artifactSha256 === delivery.artifact.sha256, 'Delivery is stale or hashes do not match.');
  requireValue(review.candidateSha256 === candidateSha256 && review.artifactSha256 === artifactSha256, 'Review targets a different candidate or artifact.');
  const available = new Map((delivery.screenshots || []).map(shot => [path.resolve(shot.path), shot]));
  requireValue(Array.isArray(review.images) && review.images.length >= 2, 'Actually inspect and list light/dark images.');
  const viewed = review.images.map(image => {
    const filename = path.resolve(image.path), shot = available.get(filename);
    requireValue(shot && hash(fs.readFileSync(filename)) === image.sha256, 'Reviewed image is not a matching captured screenshot.');
    return shot;
  });
  for (const theme of ['light', 'dark']) requireValue(viewed.some(shot => shot.width === 1440 && shot.height === 900
    && (shot.resolvedTheme || shot.theme) === theme), 'Review both 1440x900 light and dark captures.');
  const candidate = JSON.parse(sourceBytes);
  if (state.geometryConstraints) {
    const constraints = state.geometryConstraints;
    requireValue(semanticHash(constraints) === state.geometryConstraintsSha256, 'Stored geometry constraints are stale or changed.');
    const permission = geometryPermissions(constraints.baseline, constraints.policy ?? undefined,
      constraints.baselineSha256, constraints.boundaryMappings);
    assertFixedGeometry(constraints.baseline, candidate, permission);
  }
  let outputPath;
  if (candidate.meta.output !== state.semantic.meta.output) {
    const relocation = review.outputRelocation;
    requireValue(relocation?.from === state.semantic.meta.output && relocation?.to === candidate.meta.output,
      'A changed output path needs an explicit delivery-only relocation ledger.');
    outputPath = relocation.to;
  }
  return advanceQualitySession(state, {expectedRevision: review.expectedRevision, technicalPassed: true,
    semanticEquivalent: compareSemantics(state.semantic, candidate, {outputPath}).equivalent,
    candidateSha256, artifactSha256, delivery: path.resolve(deliveryFile), review});
}
function main() {
  const [command, stateFile, ...args] = process.argv.slice(2);
  requireValue(stateFile && ['init', 'init-update', 'record'].includes(command), 'Usage: quality-session.mjs init <new-state.json> <semantic.json> <intent.json> | init-update <new-state.json> <approved-semantic.json> <update-receipt.json> | record <state.json> <editable-delivery.json> <review.json>');
  const lock = `${stateFile}.lock`, fd = fs.openSync(lock, 'wx');
  let temporary, newBinding;
  try {
    if (command === 'init' || command === 'init-update') {
      const semantic = read(args[0]), plan = read(args[1]);
      let preparationRepairsUsed = 0;
      if (command === 'init-update') {
        requireValue(plan.ok === true && plan.command === 'update' && plan.approved?.semanticSha256 === semanticHash(semantic), 'Use the passing update receipt for these approved semantics.');
        requireValue(plan.candidate?.path && hash(fs.readFileSync(plan.candidate.path)) === plan.candidate.sha256, 'Prepared candidate is missing or stale.');
        requireValue(compareSemantics(semantic, read(plan.candidate.path)).equivalent, 'Prepared candidate must match the approved new semantics.');
        preparationRepairsUsed = plan.repairsUsed;
      }
      const state = createQualitySession(semantic, plan, command === 'init-update' ? plan.requestId || semanticHash(plan) : randomUUID(), preparationRepairsUsed);
      if (command === 'init-update') {
        const baselineBytes = fs.readFileSync(plan.baseline.path);
        requireValue(hash(baselineBytes) === plan.baseline.sha256, 'Prepared baseline is stale.');
        let policy = null;
        if (plan.geometryPolicy?.path) {
          const policyBytes = fs.readFileSync(plan.geometryPolicy.path);
          requireValue(hash(policyBytes) === plan.geometryPolicy.sha256, 'Prepared geometry policy is stale.');
          policy = JSON.parse(policyBytes.toString('utf8').replace(/^\uFEFF/, ''));
        }
        state.geometryConstraints = {baseline: JSON.parse(baselineBytes.toString('utf8').replace(/^\uFEFF/, '')),
          baselineSha256: plan.baseline.sha256, policy, boundaryMappings: plan.content?.boundaryMappings ?? []};
        state.geometryConstraintsSha256 = semanticHash(state.geometryConstraints);
        // One prepared receipt has one persistent review history, irrespective
        // of a caller choosing another state filename. This is not a registry
        // for independently declared requests or protection against manual deletion.
        const binding = `${plan.candidate.path}.review-binding.json`;
        requireValue(!fs.existsSync(stateFile), 'State already exists; continue it instead of resetting the request.');
        try {
          fs.writeFileSync(binding, JSON.stringify({requestId: state.requestId, state: path.resolve(stateFile),
            candidateSha256: plan.candidate.sha256}, null, 2) + '\n', {flag: 'wx'});
          newBinding = binding;
        } catch (error) {
          requireValue(error.code !== 'EEXIST', 'This prepared update is already bound to a review history; continue that state rather than changing filenames.');
          throw error;
        }
      }
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', {flag: 'wx'});
      newBinding = undefined;
      console.log(JSON.stringify({ok: true, state: path.resolve(stateFile), revision: state.revision}));
    } else {
      const state = recordReview(read(stateFile), args[0], args[1]);
      temporary = path.join(path.dirname(stateFile), `.quality-${randomUUID()}.tmp`);
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', {flag: 'wx'});
      fs.renameSync(temporary, stateFile); temporary = undefined;
      console.log(JSON.stringify({ok: true, state: path.resolve(stateFile), revision: state.revision,
        status: state.status, repairsUsed: state.repairsUsed, best: state.best, bestValid: state.bestValid, nextAction: state.nextAction}));
    }
  } finally {
    if (newBinding) try {fs.unlinkSync(newBinding);} catch {}
    if (temporary) fs.unlinkSync(temporary);
    fs.closeSync(fd); fs.unlinkSync(lock);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(JSON.stringify({ok: false, message: error.message})); process.exitCode = 1; }
}
