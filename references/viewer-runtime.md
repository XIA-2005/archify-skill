# Viewer Runtime reference

Read this only when the user asks for a reader-facing capability. Ordinary generation does not require implementing or re-documenting these features; they are already in the generated HTML.

## Exploration

- Diagram Guide lists current actions and shortcuts.
- Reading Depth starts at READ at the default 100% scale, reveals FULL detail at 175%, and falls back to MAP only below 100%. Focus, route, and semantic interactions reveal their exact facts at any scale.
- Semantic Lens summarizes selected node/relationship kinds without changing authored geometry.
- Intent Trace previews a fine-pointer or keyboard target before committed focus.
- Node Finder searches labels and stable IDs.
- Semantic Passport opens on focus, shows authored upstream/downstream facts, supports a copyable deep link, has an explicit close action, closes on true outside activation and Escape, and never enters canonical export.
- Semantic Radar mirrors the visible viewport and authored graph without becoming a second source of truth.
- Direct Relationship Pin makes a unique compiled relationship operable while preserving the authored line and stable relationship identity. It must fail closed on conflicting source/target/label/ID metadata.
- Route Probe resolves exactly two endpoints over authored directed relationships. It never infers a route from geometry.

## Motion and presentation

`meta.animation: "trace"` enables a finite reader-controlled Live/Still trace. Static is the default. Still, reduced motion, page hiding, print, and canonical export preserve complete static meaning. Presentation Stage changes viewer chrome and framing, never authored geometry. This is not a mobile product feature; narrow layouts get containment only.

## Canonical exports

The export menu can copy/download full-diagram PNG, download JPEG/WebP, download a dual-theme SVG, and record a trace-enabled WebM. Viewer state—Guide, Lens, finder, focus, route, camera, radar, presentation, motion ownership, and temporary overlays—must be removed from canonical export.

### Route Share Card

After a real directed Route Probe resolves, the reader may use **Export → Route Share Card**. It reuses the exact ordered route snapshot and the shared Share Card seam: `format=share-card`, `variant=route`. The isolated clone may use only static `data-share-route-*` decoration. It is download-only, fails closed for stale/unreachable/conflicting routes, and never becomes the canonical artifact.

### Reach Share Card

After a non-empty authored reachability query, the reader may use **Export → Reach Share Card**. It consumes the already resolved upstream/downstream node and edge set without rerunning traversal: `format=share-card`, `variant=reach`. The isolated clone may use only static `data-share-reach-*` decoration. It is download-only. Call it authored reachability—not impact, blast radius, breakage, or runtime causality.

## Truth boundary

Viewer exports are communication assets. They do not replace the checked HTML, the deterministic delivery receipt, or a real visual review. Do not add a hosted service, storage surface, dependency, schema branch, or mobile product surface for these viewer-only capabilities.

## Large-export recovery

Large exports must leave the editor/Viewer usable after completion or failure: unload decoded export image sources and handlers, clear canvas backing stores, stop recording tracks/timers, and revoke temporary URLs. Bound GIF pixel readback and compression buffers without changing sampling positions, palette, output pixels, timing or requested scale. Verify repeated exports, cleanup on injected failures, before/after animation frame intervals, and byte-identical GIFs from frozen inputs; distinguish measured resource improvements from a reproduced user-visible lag.

GIF frame drawing, bounded pixel readback, palette, quantization and LZW run in a disposable inline Blob Worker with OffscreenCanvas when supported. Rasterize the SVG once at the full requested native dimensions and transfer that ImageBitmap; never enlarge a low-resolution preview. This keeps Route/zoom on the page's thread. Close bitmaps and offscreen canvases, terminate the worker and revoke its URL on success or failure. Keep exact main-canvas and cooperative fallbacks for shells without OffscreenCanvas/Worker or blocked worker startup. Measure interaction and frame gaps **during encoding**, separately from native snapshot preparation, post-export recovery and download transport. A very large native snapshot can briefly stall preparation; do not promise zero dropped frames. Preserve native sizes, frame rate, duration, alpha and palette quality; compare decoded RGBA frames when lossless GIF packing changes the file bytes.

GIF motion repeats throughout the clip, including static diagrams; missing authored `--step` uses the relationship/node ordering rather than zero. Preserve WebM's finite trace. At 50 FPS, a six-second GIF must contain exactly 300 frames, each with a 20 ms delay, and moving flow in its final two seconds. The first frame is a clean, persistent full-resolution base. Subsequent frames contain the rectangle differing from that base and use GIF89a restore-to-previous disposal, so transparent movement leaves no trails. Validate every decoded RGBA frame against the full-frame reference in both opaque and transparent modes; never drop frames or lower scale to make playback smoother. Actual playback remains subject to the receiving application's decoder and available memory.

For a reported gray background after selecting transparency, reproduce through the actual menu checkbox and inspect the downloaded GIF, not just an API export. Search existing delivered/downloaded files before requesting another copy. A transparent delivery must explicitly enable `transparentBackground: true`, use a distinguishable `-transparent.gif` filename, and verify alpha 0 across empty regions spanning grid lines in every frame. Also preview the native GIF on two different solid backgrounds. Do not label an opaque sample or a JPEG contact sheet as transparent, and never bake an inspection checkerboard into a delivered image. If the current menu succeeds but an older file fails, distinguish the corrected file from an unproven runtime diagnosis.
