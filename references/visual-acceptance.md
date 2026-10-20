# Visual acceptance: composition before compliance

This checklist is the human-facing *quality gate* for Archify outputs. Technical `finalize`, `check` and `browser-check` never substitute for seeing the actual composed diagram. Preserve all user-required nodes, edge directions, conditions and labels while improving presentation.

## 1. Design before JSON coordinates

1. State internally what the reader must understand in five seconds. Identify the **single primary journey**, ordered by real connections; distinguish true branches, feedback loops, shared services and auxiliary detail.
2. Choose a coherent composition: nearby stages, branches beside their owner, secondary nodes grouped by role, physical outputs next to their drivers. For 8+ components prefer meaningful two/three-row rhythm over a very wide top strip. Follow the actual graph, not a fixed row quota.
3. Use clearly legible main node labels, smaller secondary annotations, meaningful contrast and simple, consistently styled arrows. Reserve space for the *actual* edge labels. Keep card content subordinate to the diagram; do not invent connections to improve symmetry.
4. Only after this plan, assign schema-correct positions/lanes/columns. The visual editor's proposed layout is not authoritative; default to the canonical renderer and review the resulting HTML.

## 2. Mandatory screenshot review

Required for every new or repaired Architecture, and for **Workflow >=8 nodes**, every explicitly requested polished figure, and every reported visual regression. Use the same gate regardless of the authoring model. For other diagrams it is recommended and becomes mandatory when a compact receipt suggests route or readability risk. The mandatory delivery helper captures all five types; no additional capture call is needed for unchanged output.

Identical typed JSON and renderer produce deterministic geometry. Model choice can still affect source interpretation, grouping and authored placement; do not promise identical beauty from different descriptions or different candidate JSON. Preserve the original renderer's typography, palette and automatic routing, then judge every final image against the same criteria below. Do not weaken the checklist for a smaller model, and do not substitute auto-layout previews for the canonical image.

The normal `editor/deliver.mjs` path already captures the images: inspect those files without another capture. Only when an artifact was finalized outside that wrapper, call `node bin/archify.mjs visual-check <html> --out-dir <fresh-evidence-folder> --summary --require-provenance`. Inspect the actual **1440x900** light and dark PNGs, plus 2048x1320 for complex diagrams. The capture receipt `ok:true` merely proves browser/capture checks completed. It **does not** constitute human visual review.

## CLI ok is not visual acceptance

Receipt fields `ok: true`, a passing `finalize`, and `visualReview: "pending"` / `"pending-image-inspection"` only prove automated gates/capture completed. They never mean a human accepted the composition.

Deliver and visual-check receipts set `visualAcceptance: "human-required"`. **Code never writes `visualAcceptance: "passed"` or `visualReview: "passed"`.** "human-required" means a perceptual look at the real images is required: a CLI `ok`/finalize success can never be reported as a visual pass by itself. It does **not** mean handing acceptance to the user or stopping to ask them. The agent itself must open and inspect the screenshots (light and dark when present). If it sees defects such as edge crossings, an overly tall or wide canvas, overlaps, or clipped/tiny labels, it must repair the layout, rerun delivery, and inspect the new screenshots on its own, iterating within the bounded repair rules below until the result is acceptable. Only then may it report `visual_review: passed` in the final reply, citing the absolute screenshot paths (light and dark when present) and the viewport sizes from the receipt. If acceptable quality cannot be reached within the repair bound, report `visual_review: failed` with the concrete remaining defects instead of asking the user to judge.

Inspect in this order:

| Dimension | Acceptance question | Measurement / repair trigger |
| --- | --- | --- |
| Main path | Can a reader trace the main story without searching for arrows? | Main edge order must read naturally. A wrong-order detour requires regrouping. |
| Hierarchy | Does the primary journey visually dominate rather than scatter? | Do not mix peer groups with unrelated roles; auxiliary nodes stay near owners. |
| Text | Are node labels, edge labels and descriptions readable at native 1440px viewport? | Prefer >=7.5px projected context text; <=6px fails automated checks, 6–7.5px requires explicit review and often compact reflow. Do not call tiny text polished just because it passes. |
| Layout | Is width justified by meaning? Are whitespace and card balance intentional? | ViewBox very wide for viewport, large empty bands, or remote physical output nodes require investigation and usually reflow. |
| Connections | Are arrows traceable, consistently attached, visually centered, and colored by a clear relationship meaning? | No avoidable proper crossings, hidden overlaps, misleading shared corridors, sprawling detours or tiny labels. For Architecture, every box side carrying exactly one connection must meet it at that side's midpoint, with a perpendicular box-adjacent segment, whether the connection is incoming, outgoing, straight or bent. An off-center lone attachment fails review even when showcase passes. A main path that switches line color without a change in relationship meaning fails review. Review resolvedCrossovers even if showcase passes. |
| Contrast | Can colored roles and semantic text be distinguished in both themes? | Any illegible faint lines/labels fail visual acceptance. |
| Semantics | Do group boxes, labels and arrows still match source meaning? | Wrong relationship, missing branch/gate or decorative false flow fails. |

The numbers are diagnostic **targets**, not authority to delete meaningful facts or violate user-fixed geometry. Compare the actual screenshot at the specified viewport rather than assuming a measured `pass` is attractive.

For every final or repaired Architecture candidate, obtain its resolved points once with `validate architecture <candidate.json> --layout-json` alongside the screenshots. This invocation measures attachments; it is not a second delivery gate. Count connection endpoints on **each side of each box**, including both sources and targets. A side with exactly one endpoint must use its geometric midpoint (`x + width/2` for top/bottom; `y + height/2` for left/right, allowing only rendering pixel rounding). The first or last segment touching that box must be perpendicular to the side. This applies even when the route bends, the opposite endpoint happens to align elsewhere, or automatic routing chooses a shorter path. A side with two or more connections may spread its endpoints. Record each lone offset by box, side, relationship and distance; visual acceptance requires zero unresolved lone offsets. Repair by moving the connected boxes or changing the attachment side without changing facts; if those do not work, pin the centered `fromPort`/`toPort` (`[0,0.5]` left, `[1,0.5]` right, `[0.5,0]` top, `[0.5,1]` bottom) and verify all surrounding routes. Do not silently override user-fixed geometry or an explicit off-center port: if it conflicts with this requirement, report the conflict and withhold visual acceptance. Rerun delivery and inspect both themes after a repair. Automated browser or containment passes do not settle this visual check.

Also trace the ordered main path through `connections[].variant` and the light/dark screenshots. The same relationship role should keep a consistent line and label treatment across its full path; a few highlighted middle edges with unexplained default-colored edges before or after are a visual defect. Distinct branches, security links, and configuration links may use different variants when that distinction is real and legible. If several line treatments appear, explain their meanings in the diagram and verify the explanation against the rendered colors in both themes. Node type colors do not establish connection meaning.

## 3. Outcome and bounded repair

- `visual_review: passed` — only after **actually viewing** the screenshot and confirming *all* relevant items above. State viewport and whether dark theme was inspected.
- `visual_review: failed` — screenshot observed with specific defects. Do not mark the figure "polished" or "accepted" even when all CLI checks pass.
- `visual_review: skipped` — screenshot could not be inspected or capture failed. Report why, and never imply visual acceptance.
- `visual_review: not_required` — only for genuinely simple diagrams with no trigger.

Repair the connected group responsible for the defect, not unrelated coordinates. At most **two** evidence-based composition repairs per generation request, each with new `finalize --out-dir` and new screenshot evidence. Compare before/after *at the same viewport*, preserve the better verified result and history; if unsuccessful, report the specific visual gap instead of repeatedly shifting arbitrary nodes.

## 4. Regression discipline

Use `scripts/visual-regression.mjs` to compare fixed original Archify fixtures (unchanged official examples), a canonical Workflow, and any user-provided project candidate. Run it before and after changing rendering/layout/skill workflow. Preserve separate screenshot directories for old/new versions. The script checks deterministic content integrity, CLI/Chrome gates, and measured metrics; **humans still compare images**. An exact pixel hash is informational because Chrome/font environments can legitimately change.

Keep renderer changes separate from editor improvements. A new editor cannot silently change a frozen JSON fixture or its independently rendered output. Always identify baseline renderer version and candidate checksum when making a regression claim.

## Durable Architecture review record

For the semantic/intent workflow, follow [Architecture quality workflow](architecture-quality-workflow.md). One request state records initial image inspection, at most two subsequent repairs, screenshot/candidate/HTML hashes, specific affected subjects, next action and best-version replacement. New filenames and structural alternatives do not restart the budget. A checked receipt is not visual testimony; the actual reviewer must inspect both desktop themes and keep its review separate from machine receipts.
