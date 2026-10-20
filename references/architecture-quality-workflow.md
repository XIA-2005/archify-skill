# Architecture layout-quality workflow

Use this for a fresh Architecture without user-fixed geometry, and for an explicitly authorized **independent** new-layout experiment. Do not call extraction from ordinary render, open, edit, save or export. Existing candidate geometry remains authoritative.

For the same system with a trusted old candidate, use [Architecture incremental update](architecture-incremental-update.md) instead: approve the complete new semantics, apply a raw-hash-bound stable-ID proposal, preserve unknown/fixed geometry, and expand only a justified region. The implemented preparation entry is `node bin/archify.mjs update architecture baseline.json proposal.json approved-semantic.json new-candidate.json --geometry-policy policy.json --main-path input,controller,driver --json` (optional policy/main path; use real IDs). Save its UTF-8 receipt and initialize `node draft/quality-session.mjs init-update request-state.json approved-semantic.json update-receipt.json` before review. Preparation and visual fixes share the two-round budget. Keep failed receipts; neither a new filename nor a failed probe authorizes resetting it. Old factual errors require explicit correction before layout.

For a different system, an attractive reference supplies only applicable composition roles; it does not supply facts or matching identities. For no trustworthy baseline or an unsuitable topology, keep this new-layout route and choose the simplest applicable draft/direct placement; complex intent is not mandatory for every input. Both routes still need complete `editor/deliver.mjs` delivery and real screenshot inspection. Supplemental delivered-SVG auditing via `incremental/artifacts.mjs` detects concrete geometry/style changes and unknown scope; it does not invoke finalize or establish beauty. No route promises every topology will succeed or permits rewriting machine `human-required` receipts.

## 1. Freeze meaning and environment

State the reader question, scope and abstraction depth in the intent question and accompanying source notes. Author the existing Architecture semantic JSON, preserving every component, directed relationship, condition, membership, role, source and card. Keep behavior-changing conditions on the affected node or relationship. Use the existing intent v1 contract: every main-path adjacency is real, all nodes occur once in bands, branches have real anchors, shared-layer targets are real contiguous consumers, and returns are explicit. Do not mark every fanout as a shared layer.

For an independent experiment on an existing candidate, `extractSemantic()` in `draft/semantic.mjs` returns a new copy and an exact owner-specific geometry-removal ledger. Save both. Never recursively remove fields by name or prefix. Any output-path relocation is a separately recorded delivery-only change. `compareSemantics()` preserves array order and all non-geometric fields; it separately accounts for omitted draft defaults (`font_scale: 1.25`, `quality_profile: showcase`).

Freeze input bytes, intent bytes, renderer/generator hashes, Node/Chrome versions, fonts and viewport. Same geometry is reproducible under that environment; perceptual judgment is not guaranteed deterministic.

### Model-backed authoring and diagnostic feedback

Use separate authoring steps: request and validate the coordinate-free semantic
object first, freeze it, then request only an intent for those exact IDs and
directed relationships. A successful HTTP response, JSON mode, or a syntactically
valid object does not establish schema, source fidelity, intent, or visual quality.
Keep the raw response, model ID, parameters, prompt hashes, finish reason and usage.
An incomplete/invalid JSON response stays in the experiment's failure denominator;
do not silently trim braces, discard a failed run, or advertise a repaired response
as a first-attempt success.

When requesting a correction, include the actual structured diagnostic's `code`,
`subject`, `evidence` and `supportedFixes`, not only its generic message. For
`draft/no-passing-layout`, inspect the individual `attempts[].diagnostics` as well;
the top-level error alone does not identify the blocked relationship or label.
Preserve the frozen semantic object during intent/layout corrections. Record input
corrections separately, and never use them to reset an existing request's visual
repair budget or overwrite its failures.

If an intent cannot be represented or rendered, an explicitly recorded attempt
with the existing layered/manual path may preserve the semantics. It still needs
all ordinary gates and screenshot review; fallback availability does not guarantee
a readable layout. A valid semantic object with no passing layout remains an
unfinished generation, rather than a visual acceptance or a reason to weaken gates.

## 2. Generate, inspect selection, deliver once

```bash
node bin/archify.mjs draft architecture semantic.json candidate.json --intent intent.json --json
node draft/quality-session.mjs init request-state.json semantic.json intent.json
node editor/deliver.mjs architecture candidate.json diagram.html --out-dir delivery-0 --json
```

Use a new candidate output and keep `meta.output` equal to the requested HTML path. Add `--repo-root` to draft and delivery for repository-backed inputs. Read `references/architecture-draft.md` for unsupported intent topology and the existing layered/manual fallback; never remove facts to make an intent applicable.

Intent generates at most three structural families: aligned spine, balanced rails, and input-centered shared consumers. Existing spacing probes remain within each family. Band order, branch relationships and boundaries are not rewritten. Renderer/artifact gates reject infeasible probes. Rejected structures, proposal semantics, ranking keys, checks performed and selection reasons are recorded. A lower-ranked unchecked artifact is not an accepted alternative. Do not repeat full delivery for unchanged candidate bytes.

Ordering is lexicographic after semantic/layout gates, then canonical artifact acceptance. Counterflow, crossings, main-path reversals, shared-output readability and coarse row balance precede secondary bends/length/height. Numeric scores retained for historical comparison are no longer the selector. These are advisory quality heuristics, not visual passes. Browser/provenance gates still run in `editor/deliver.mjs`.

## 3. Actually inspect the images

Open the matching 1440x900 light **and** dark PNGs, plus large/full-page images for complex cases. Check the original visual-acceptance checklist including every singleton-side midpoint/perpendicular attachment, full text, semantic line treatment, frame membership, shared-node crowding and useful whitespace. Keep product motion defaults; inspect stable screenshot states.

Create an independent review JSON, never modify the delivery/finalize machine receipts:

```json
{
  "expectedRevision": 1,
  "candidateSha256": "actual candidate digest",
  "artifactSha256": "actual HTML digest",
  "reviewer": "actual image reviewer",
  "images": [
    {"path": "actual 1440x900 light PNG", "sha256": "actual PNG digest"},
    {"path": "actual 1440x900 dark PNG", "sha256": "actual PNG digest"}
  ],
  "decision": "rework",
  "replaceBest": true,
  "comparison": "Specific comparison with the historical best, not a score alone.",
  "defects": [{
    "kind": "shared-crowding",
    "subjects": ["actual node or relationship IDs"],
    "description": "Describe the visible problem and why a connected-group reflow is needed.",
    "unacceptable": false
  }]
}
```

Record it with the real `editable-delivery.json`:

```bash
node draft/quality-session.mjs record request-state.json delivery-0/editable-delivery.json review-0.json
```

The recorder checks passing machine gates, actual artifact/source hashes, exact semantic equivalence, and matching light/dark screenshot hashes. If preserving earlier output requires a different HTML path, add `outputRelocation: {from: "the original meta.output", to: "the candidate meta.output"}` to that review; all other non-geometric metadata must still match exactly. It does not see images or certify the reviewer's testimony. `visualAcceptance: human-required` in machine receipts remains unchanged.

## 4. Act on defects within one request budget

- Label only: local label repair.
- Isolated route: local port/corridor repair.
- Shared-node crowding or a repair moving conflicts elsewhere: reflow the connected group.
- Global imbalance/main-path confusion: compare another structural family or reflow the scene.
- Semantic error: stop treating this as a layout success; record a semantic revision explicitly.

After the initial reviewed candidate, **the whole request** has at most two repair rounds. New candidate names, changed intent or a different structure do not reset the request. Retain the same state file; do not reinitialize one to evade the budget. On reflow, remove stale generated route overrides only in the authorized copy; preserve user-fixed geometry. Deliver changed bytes with a new out-directory, inspect new screenshots and record against the current revision.

Set `replaceBest: true` only when comparison supports improvement with no new unacceptable defect. Set `decision: accept` only for an actually inspected best version. `reject` never replaces best. No improvement retains the historical best and its evidence. After two unsuccessful repairs the state becomes `visual-failed`, not success. `best` identifies the visually improved version; `bestValid` separately retains a verified technical fallback even when the initial version and every repair have unacceptable visual defects. Return `best ?? bestValid` with the concrete remaining defects; never turn technical fallback into visual acceptance. Accepted/failed states are sealed.

## 5. Report evidence and limitations

Report HTML + matching JSON + the actual reachable editor URL privately to the user, gate states, viewed screenshot paths/viewports, semantic/intent/candidate/HTML hashes, selection reasons, repair history, costs and remaining defects. Never publish editor tokens in repository documentation. Missing browser/vision/model access is an explicit validation gap, not a pass. Ten identical deterministic runs do not establish cross-topology quality or model-generation statistics.
