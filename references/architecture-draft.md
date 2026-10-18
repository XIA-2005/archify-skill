# Deterministic Architecture draft

An optional starting aid for a **new architecture without fixed geometry**.
For a clear directed chain or feedback cycle, supply its main path so the
compiler can arrange the composition without model-authored coordinates. A
general layered draft can still be tall or indirect. Other modes keep their
existing authoring path. Supplied positions, sizes, routes and editor geometry
remain authoritative: send those candidates directly to delivery.

## Author meaning, then compile placement

Write `semantic.json` using the Architecture v1 schema. Include `schema_version`,
`diagram_type`, `meta.title`, `meta.output`, components and their actual connections.
Keep conditions on the affected relationships, meaningful labels, boundary
memberships, cards, styling and verified sources. Declare components and edges in
the intended reading order. No new semantic schema or special model mode is needed.

Omit `layout`, `meta.viewBox`, component `pos`/`size`/`row`/`col`, boundary
`bounds`/`labelOffset`/`pad`, and every connection geometry control (`route`, ports,
sides, waypoints and label coordinates). Read the schema before adding fields.
The command rejects explicit geometry rather than silently overwriting it.

```sh
node <skill-root>/bin/archify.mjs draft architecture semantic.json candidate.json --json
```

For a main chain, add `--composition flow --main-path client,api,queue,worker`.
For a closed loop, use `--composition feedback --main-path sensor,gateway,rules,actuator`.
These are ID examples, not facts to copy. Every adjacent pair must be a real
directed relationship; feedback also requires the final node to connect back
to the first. Use at least four distinct nodes for feedback and two for flow.
Keep branches, conditions and ownership in the same semantic JSON. Do not add
edges to make a chosen composition applicable. `layered` remains the default
when there is no supplied main path. The compiler does not guess the story.

Add `--repo-root <evidence-repository>` for repository-backed input. Save stdout as
`draft-receipt.json`. The output path must be new and its parent directory must
exist; an existing output, including a symlink, is never replaced. Keep the
semantic input and first candidate for comparison during repairs.

The compiler measures complete text at preferred font sizes. Flow places the
main chain on a rail with side branches near their actual neighbors; feedback
uses two rails with a return path. Boundary checks reject proposals that would
enclose unrelated nodes. Complicated nested ownership can require the layered
or manual path. The compiler tries at most eight deterministic combinations.
The layered strategy reuses the editor's planner. It uses the
canonical renderer. Schema, source evidence, renderer and artifact acceptance
remain unchanged. Disjoint and nested boundaries are supported; overlapping
non-nested memberships need manual geometry and are never rewritten.

Candidates retain every semantic field. Computed positions and sizes are added,
along with omitted defaults: `quality_profile: "showcase"` and `font_scale: 1.25`.
Explicit `standard`, font scale and per-element font sizes stay unchanged.
Existing fonts, labels and sources are never reduced to fit.

## Read the result

- `ok: true`: a new candidate was written after renderer and artifact checks.
  `selected` and `candidate.sha256` identify it. Follow `nextAction` through
  `editor/deliver.mjs`; inspect its real light/dark screenshots before visual
  acceptance. A draft does not run browser checks, start an editor or prove beauty.
- Each `attempts[]` item separates `layoutPassed`, `artifactChecked` and, when
  checked, `artifactPassed`. Unchecked proposals are not accepted alternatives.
  Desktop text projection, height, counterflow, crossings, bends and length
  rank proposals; they are advisory metrics.
- `reviewRecommendations[]` names small text, tall composition or specific
  relationships sharing a counterflow corridor. Its projection is an estimate,
  not browser evidence or a new acceptance gate. Preserve complete labels;
  compact empty space or choose a suitable composition before increasing font
  size and remeasuring. Counterflow needs separate incoming/outgoing sides and
  a distinct return corridor. Inspect every affected relationship in screenshots.
- `ok: false`: inspect `diagnostics` and the individual attempt diagnostics. No
  failing layout is published. Correct actual input errors; for a layout that
  cannot pass, keep the semantic input and author geometry under
  [Authoring defaults](authoring-defaults.md#layout-and-routing). Do not delete
  facts, change ownership or lower the quality profile to make drafting pass.

For an unattractive but technically passing result, use
[Architecture layout repair](architecture-layout-repair.md). Keep the better
verified candidate; at most two evidence-based composition repairs. There is no
quality exemption for a smaller model and no automatic model escalation.
