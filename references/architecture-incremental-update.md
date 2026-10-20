# Architecture incremental updates

Prepared update receipts carry a request ID. `init-update` binds a receipt to one
persistent state via a sibling `candidate.json.review-binding.json`; changing the
state filename cannot reopen that receipt's budget. The state also snapshots the
baseline geometry policy and checks it on every later visual-review candidate.
This guards normal request continuation, not manual deletion or a caller falsely
declaring the same work to be an independent request.

Use this explicit authoring path when the **same system and scope** already have
a trusted editable Architecture candidate and a source baseline. It prepares a
new candidate from approved new content while preserving applicable old geometry.
It does not run from ordinary render, open, edit, save or export, and does not
replace the canonical renderer or mandatory complete delivery.

This document describes the implemented contracts. Availability of the commands,
passing tests, or a successful prepared candidate is not evidence that all
topologies are supported or that model generation and visual quality are accepted.

## Choose the route before changing the diagram

| Situation | Route |
| --- | --- |
| Same system, same scope, trusted candidate and source baseline | This incremental path |
| Old diagram omits facts or contains errors | Independently approve those corrections first; include them explicitly in the proposal and S1 |
| Different system with an attractive reference | Transfer applicable composition roles only; do not inherit facts, stable IDs or fixed coordinates by name similarity |
| No trustworthy old candidate, major scope change, or unsuitable old topology | Use the [new-layout workflow](architecture-quality-workflow.md) and the simplest applicable [draft](architecture-draft.md) or direct placement |
| Only an old screenshot exists | Treat it as a visual reference; reconstruction and its identity/geometry uncertainty are separate work |
| Unchanged candidate only needs handoff | Use the existing delivery path; do not run an update or new layout |

Do not route an ordinary update through `draft` by stripping all old geometry.
New layouts may use flow, feedback, layered placement or representable intent;
complex intent is not a mandatory intermediary for every incremental update.

## Freeze the baseline and approve S1

Keep the original JSON, matching HTML, viewed light/dark screenshots, review and
source revision/snapshot intact. Record raw-byte SHA256 values and the scope,
abstraction depth, source facts, conditions, directions and geometry origins.
An attractive old diagram is not automatically factually correct. If the old
source is unavailable, disclose that the complete code-change impact is unknown.

Approve a **complete new semantic Architecture object**, S1, independently of the
proposal producer. Use the existing schema with no geometry fields, as defined
by the exact owner-specific list in `draft/semantic.mjs`. Preserve all styling,
cards, sources, array order and metadata, including `meta.output`. Conditions
that affect behavior belong on their relevant nodes or relationships rather
than only in explanatory cards.

The content condition is `extractSemantic(newCandidate) == S1`, not equality
with old semantics. Neither schema validity nor evidence strings verify source
truth. Trace the relevant source context and independently review S1.

All baseline connections need unique stable IDs for the current update CLI's
delta comparison. A legacy relationship without an ID requires an explicit,
reviewed identity migration first; array indices and endpoint similarity are
not substitutes. Keep a component ID through a label rename. Splits, merges
and actual identity replacements need explicit additions/removals and evidence.

## Bounded content proposal

`incremental/changes.mjs` applies a transaction to a copy. The proposal has only:

```json
{
  "schemaVersion": 1,
  "baselineSha256": "replace with the SHA256 of the exact baseline JSON bytes",
  "operations": []
}
```

There may be at most 128 operations. Unknown proposal/operation fields, stale
hashes, mismatched old values, duplicate identities, dangling references,
unsupported deletions, geometry in content, and disagreement with S1 are rejected.
No half-applied candidate is returned. Hash the original file bytes, including
their actual newline/BOM encoding, before any reformatting.

| Target | Supported operations and selector |
| --- | --- |
| `component`, `connection` | `add` with full semantic `value`; `update` with `id`, `before`, `set` and/or `unset`; `remove` with `id`, `before` |
| `boundary` | Same operations; update/remove use `selector: {kind, label}` for the current identity instead of `id` |
| `meta` | `update` only; complete semantic `before`, plus `set` and/or `unset` |
| `cards` | `update` only; complete current array in `before` (`null` if absent), complete replacement array in `value` (`null` removes the property) |

Every operation also needs a nonempty `evidence` array of nonempty source or
reviewed-requirement strings. For update/remove, `before` is the **complete
semantic owner at that transaction step**, not merely the changed fields. It
excludes only that owner's geometry. Repeated operations observe preceding
operations. Cards are an atomic ordered array; there is no invented card ID.

For example, if a component's full semantic owner is exactly
`{"id":"controller","type":"backend","label":"Control"}`, an update is:

```json
{
  "op": "update",
  "target": "component",
  "id": "controller",
  "before": {"id": "controller", "type": "backend", "label": "Control"},
  "set": {"label": "Control when ready"},
  "evidence": ["reviewed requirement: execute control only after readiness"]
}
```

This is an illustrative operation, not a project fact. Include any real
`sublabel`, `tag`, `sources`, `font_sizes`, `brand`, etc. in `before`. `set` merges
top-level owner fields; `unset` lists distinct existing field names. It is not a
generic JSON-pointer patch. Do not put `pos`, `size`, ports, routes, label anchors
or boundary bounds into content operations.

For a new HTML location, explicitly update `meta.output` through a `meta`
operation and use that same value in S1 and delivery. Metadata `before` includes
all existing semantic metadata, including its old output path. The update command
does not silently relocate output. Keep the old HTML untouched.

Prefer a boundary update for a rename, with its old `selector` and the new label
in `set`. The content result records explicit old/new boundary mappings and
geometry-transfer provenance. Replacements do not erase unknown/user constraints;
ambiguous boundary inheritance is rejected. The general delta viewer still uses
kind + label identity and can display a rename as removal plus addition.

## Geometry origins and permissions

`--geometry-policy` is optional. Omission means `unknown-preserved`: existing
geometry remains authoritative, even if it looks machine generated. Do not
infer permission from coordinate regularity, an ID, or visual convenience.

The policy has version 1, the same raw `baselineSha256`, a nonempty truthful
`origin`, and optional `generated` and `fixed` groups. Example structure:

```json
{
  "schemaVersion": 1,
  "baselineSha256": "replace with the exact baseline JSON SHA256",
  "origin": "documented generator run and reviewed geometry provenance",
  "generated": {
    "components": ["controller", "driver"],
    "connections": ["control-driver"],
    "boundaries": [{"kind": "region", "label": "Firmware"}]
  },
  "fixed": {
    "components": [{"id": "controller", "fields": ["pos"]}],
    "connections": [{"id": "control-driver", "fields": ["fromPort", "via"]}],
    "meta": ["viewBox"],
    "layout": true
  }
}
```

Use only actual existing owners. Generated declarations permit necessary changes
under the bounded layout stage; they are not instructions to move everything.
Explicit fixed fields take precedence. Geometry fields come from
`draft/semantic.mjs`; only `viewBox` is accepted in `fixed.meta`, and `fixed.layout`
is boolean. Version 1 has no `fixed.boundaries` field: omit a boundary from
`generated.boundaries` to retain its existing geometry conservatively.

The planner preserves unaffected placement, measures changed content, handles
applicable shared rows/ownership changes, and clears only stale **permitted**
generated routing. Actual canonical diagnostics can expand a connected region.
For a changed horizontal relationship label, measured text clearance can require
translating its acyclic downstream group while retaining that group's internal
alignment. Such movement has an explicit per-node ledger; a short label edit
does not guarantee zero movement. New same-row peers align with their anchor's
centerline without resizing existing nodes merely for uniformity.
Hard user constraints, uncertain origins and facts cannot be discarded to obtain
a passing arrangement. A required movement conflicting with them is a concrete
failure, not permission for a hidden full reflow. Not every topology is supported.

## Prepare, then deliver and inspect

From the diagram's working directory, use the installed package path where needed:

```sh
node bin/archify.mjs update architecture baseline.json proposal.json approved-semantic.json new-candidate.json --geometry-policy policy.json --main-path input,controller,driver --json
```

`--main-path` is optional and must use unique current IDs with real directed
adjacencies. `--geometry-policy` is optional as described above. Add
`--repo-root <evidence-repository>` for repository-backed inputs. The new candidate
path must not exist and its parent must exist. The baseline is never overwritten.

Save stdout as UTF-8 `update-receipt.json` and preserve the command's exit status.
For Windows PowerShell, avoid the default UTF-16 redirection:

```powershell
$updateReceiptText = node bin/archify.mjs update architecture baseline.json proposal.json approved-semantic.json new-candidate.json --geometry-policy policy.json --main-path input,controller,driver --json
$updateExitCode = $LASTEXITCODE
[System.IO.File]::WriteAllText("update-receipt.json", ($updateReceiptText -join [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
if ($updateExitCode -ne 0) { throw "Inspect update-receipt.json; update did not pass." }
```

Read the content ledger, delta coverage, `attempts[].diagnostics`, scope expansion,
cleared geometry, resolved geometry differences and selected attempt. The command
checks the baseline under the current canonical gates and does not treat a
historically attractive but currently invalid baseline as trustworthy. Its
`ok:true` means candidate preparation passed; it does not finalize, start an
editor, inspect screenshots or certify visual acceptance.

Initialize the update's review state using its actual passing receipt:

```sh
node draft/quality-session.mjs init-update request-state.json approved-semantic.json update-receipt.json
node editor/deliver.mjs architecture new-candidate.json new-diagram.html --out-dir delivery-0 --json
```

`new-diagram.html` must match approved `meta.output`. Forward the same
`--repo-root` to delivery. `init-update` verifies the prepared candidate hash and
new semantic equivalence and imports `repairsUsed`. Use `editor/deliver.mjs` as
the sole complete finalize/screenshot/matching-editor owner. Do not finalize
unchanged candidate bytes again just to collect auxiliary comparison data.

## Supplemental artifact comparison

In addition to the CLI's authored and resolved-layout ledgers, use
`incremental/artifacts.mjs` on the already delivered, hash-matched old/new HTML.
This is a library API, not another CLI or a replacement for full delivery:

```js
import fs from 'node:fs';
import { auditArtifactGeometry } from './incremental/artifacts.mjs';

const update = JSON.parse(fs.readFileSync('update-receipt.json', 'utf8'));
const audit = auditArtifactGeometry(
  fs.readFileSync('baseline.html', 'utf8'),
  fs.readFileSync('new-diagram.html', 'utf8'),
  {
    affectedNodes: ['controller'],
    affectedEdges: ['control-driver'],
    affectedBoundaries: [{ kind: 'region', label: 'Firmware' }],
    boundaryMappings: update.content.boundaryMappings
  }
);
fs.writeFileSync('artifact-geometry-audit.json', JSON.stringify(audit, null, 2) + '\n');
```

Replace the illustrative IDs with the justified actual selected scope. Do not
whitelist the entire scene to hide unexplained changes. The audit compares stable
node/edge IDs, actual SVG path `d`/route points, label positions/font/explicit
colors, boundary frames/title geometry, viewBox and authored SVG presentation.
Outside-scope changes are `unexplained`; missing/duplicate identities are
`unknown`. It never matches unidentified edges by array index. Boundary mappings
must be explicit one-to-one old/new `{kind,label}` pairs.

A changed global viewBox or SVG preset needs its own honest
`viewportChangeReason` or `presentationChangeReason` to be marked affected.
Stylesheet/definition changes remain unresolved for browser inspection; static
parsing cannot claim computed theme colors, font shaping or text bounds. Body
titles, scripts and animation scheduling are not architecture changes. The audit
does not verify delivery provenance itself and cannot infer beauty from pixel
differences, displacement totals or its `ok` value.

Actually inspect matching 1440x900 light **and** dark screenshots, and larger/full
views for complex cases. Compare the same viewport with the old reviewed version:
complete text, main path, shared consumers, boundaries, single-side centered
attachments, feedback/physical channels, useful whitespace and readability.

## One request budget and truthful completion

The initial candidate plus **at most two repair rounds** covers preparation and
later visual fixes together. `init-update` imports preparation rounds, so a
candidate selected after two preparation repairs has no subsequent repair round
left. Deterministic measurement/endpoint resolution within an attempt is recorded
in that attempt; rejected probes and diagnostics remain in the receipt.

Record real image reviews with the same state and the existing review contract:

```sh
node draft/quality-session.mjs record request-state.json delivery-0/editable-delivery.json review-0.json
```

See the [review JSON and screenshot-hash contract](architecture-quality-workflow.md#3-actually-inspect-the-images).
Never rewrite machine `visualAcceptance: human-required` to `passed`. A changed
candidate needs complete new delivery and matching screenshots. Renaming files,
switching structures, semantic corrections or failed preparation do not authorize
starting a new budget. Preserve failed receipts; the per-invocation CLI limit is
not a global retry registry, and a caller must not discard failures and submit
them as fresh requests. If request history cannot be carried forward, disclose
that enforcement gap rather than claim it was globally enforced.

Keep the best candidate satisfying **S1**, with its actual review evidence.
Separately retain the old accepted version and any technically valid S1 fallback;
an obsolete old diagram cannot satisfy a new request. No visually acceptable S1
version means the request remains failed/unfinished even when technical gates
pass. Report concrete defects, spent repairs and limitations. Final handoff still
requires checked HTML, matching editable JSON, a reachable private editor URL and
honest technical/visual statuses. Do not publish editor tokens or model secrets.
