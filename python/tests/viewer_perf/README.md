# viewer v3 decode/render perf harness

Two legs that together cover the path that killed the old viewer (the bottleneck
ledger's ~537 MB V8 string wall at ~1M cells):

## 1. Decode kernel (Node) — `decode_bench.js`

Times the REAL decode kernel (`assets/decode.js`) the browser worker runs:
base64 → ArrayBuffer → typed arrays → expand to a non-indexed shell → flat colour
bake. Faithful to the worker's decode cost (three.js GPU upload is browser-only).

```bash
node --expose-gc decode_bench.js <envelope.json> [iters]
```

Driven + budget-asserted by `python/tests/test_viewer_perf.py`
(`pytest python/tests/test_viewer_perf.py -q -s`). Generate an envelope with
`petektools.viewer._v3.build_v3_volume(ni, nj, nk)` → `json.dumps(env)`.

Measured (this machine, Node 22, best of N):

| scale | grid | shell tris | wire | decode | heapUsed | pos+col |
|------:|------|-----------:|-----:|-------:|---------:|--------:|
| 100k  | 100×100×10 | 48k   | 1.9 MB (19.4 B/cell) | 2.5 ms | 5 MB | 3.2 MB |
| 1M    | 200×200×25 | 200k  | 8.1 MB (8.1 B/cell)  | 14.5 ms | 11 MB | 13.8 MB |
| 5M    | 500×500×20 | 1.08M | 44.3 MB (8.9 B/cell) | 64.3 ms | 45 MB | 74 MB |

vs the ledger death point: **1M cells → ~537 MB string / crash.** Now 1M decodes
in ~15 ms at ~11 MB, and even 5M cells decode in ~64 ms (< the 100 ms UI budget)
at ~45 MB heap.

## 2. Browser render + memory-cap harness (Playwright) — `render_bench.mjs`

The browser leg: decode + first three.js render, per-tab liveness, the windowed
map-raster render cost, JS heap, and a **zero console-error** watch on a real
`save_view` HTML export in headless Chromium. It **asserts** budgets (exit code
per failure) and can force + screenshot the graceful-degradation state.

```bash
pip install playwright && python -m playwright install chromium
npm i playwright                    # or a global install; the harness require()s
                                    # it, so NODE_PATH can point anywhere
node render_bench.mjs <view.html> [flags]
#   --heap-cap-mb=N   --frame-cap-ms=N   --tri-budget=N   --expect-degraded
#   --screenshot=PATH --tab=map|section|volume|charts
#   --drag-events=N   --drag-frame-cap-ms=N   (synthetic map drag + hover sweep)
#   --surface-gesture --wheel-events=N --pan-events=N
#   --gesture-p95-cap-ms=N --gesture-max-cap-ms=N
```

Prints one JSON line: `{decodeRenderMs, mapRenderMs, sectionRenderMs,
chartsRenderMs, usedJSHeapMB, volBadge, degradedBanner, consoleErrors}` (plus
`dragFrames/dragFrameMsMedian/hoverAvgMs/hoverReadout/clickReadout` with
`--drag-events` — hover must show NOTHING under the click-to-inspect ruling;
the still-click probe must reveal the readout).
With `--surface-gesture`, the JSON also includes `surfaceGesture`: wheel/pan
frame p50/p95/max, hot-path work counters, settle counts, and A→B→A cache reuse.

Driven + budget-asserted by `test_viewer_perf.py` at the ledger scales — it builds
a `save_view` HTML with a v3 volume **and** an areal map, then asserts a JS-heap
cap and a map-render budget with **no console errors**, including a **5M-cell**
payload (`PETEK_PERF_5M=1`) to prove the never-OOM guarantee, plus a forced
degradation test (lowered `--tri-budget` → decimated-preview banner). The tests
**skip cleanly** when node can't resolve playwright / chromium (default CI).

Measured (this machine, headless Chromium, self-contained base64 export):

| scale | grid | decode+render | map render (windowed) | JS heap | tris |
|------:|------|--------------:|----------------------:|--------:|-----:|
| 100k  | 100×100×10  | 0.17 s | 0.4 ms | 15 MB  | 48k  |
| 1M    | 200×200×25  | 0.27 s | 0.5 ms | 45 MB  | 200k |
| 5M    | 500×500×20  | 0.88 s | 1.3 ms | 242 MB | 1.08M |
| map   | 2000×2000 areal | — | 2.2 ms | 150 MB | — |

vs the ledger death point (both flavors dead at ~0.9–1.0M cells, V8 string wall,
silent). Now 5M cells render at 242 MB heap with no console errors, and an
over-budget shell degrades to a decimated preview + a loud banner instead of ever
crashing.

## 3. 200k-point map overlay (`--drag-events`)

The worst case that made `view2d` unusable: 200k points with `point_color` set
plus an inferred-geometry grid-line overlay. `--drag-events=N` dispatches a
synthetic map drag (~3 mousemove events per animation frame — the rAF-coalesced
path must repaint at most once per frame; exit 8 when it doesn't), a non-drag
hover sweep (which must show NOTHING — click-to-inspect ruling) and a
still-click probe (which must reveal the readout), and `--drag-frame-cap-ms`
budget-asserts the median coalesced repaint (exit 9). Driven by
`test_render_200k_points_pan_hover_budget`.

Measured (this machine, headless Chromium), 200k coloured points + ~160 overlay
lines, before → after the batched/baked/rAF point path:

| metric | before | after |
|---|---:|---:|
| map render (`__PETEK_RENDER_MS`) | 145.3 ms | 0.5 ms |
| drag repaint | 138.9 ms/event (sync per event) | 30 frames / 90 events, median 0.1 ms |
| wheel zoom | 138.8 ms/event | affine bitmap composition only; p95 <8 ms, max <16.7 ms acceptance |
| hover mousemove | 2.6 ms (O(n) scan) | 0.1 ms (grid bucket) |

## 3b. Click-to-inspect semantics (Playwright) — `inspect_bench.mjs`

Drives the owner-ruled interaction semantics on the Map tab end to end: HOVER
shows nothing; a still CLICK on/near a point reveals the readout anchored at
the clicked location (dataset name + x/y/z) and it persists through plain
mouse movement; clicking empty space — or the same target again — dismisses
it; a moved press pans and never inspects. Zero-console-error watch.

```bash
node inspect_bench.mjs <view.html> --blob=WX,WY --empty=WX,WY
```

Driven by `test_map_click_inspect_hover_shows_nothing`. The 3-D twin
(raycaster pick + readout + orbit re-target with the camera position
unchanged, empty-click dismiss keeping the pivot, and the flat-wireframe
lattice level) is asserted through `scene3d_bench.mjs`
(`window.__PETEK_SCENE3D_PICK` / `__PETEK_SCENE3D_STATUS.latticeZ`).

## 4. 2-D map binary blocks (Node) — `map_decode_bench.js`

The 2-D map's bulk arrays (`points`, fill `nodes`/`triangles`/`values`,
`grid_lines`, `contours[i].lines`) ship as the **v3 typed binary blocks** in a
content-addressed digest table (`map.blocks`) instead of JSON floats — a single
78k-triangle fill is otherwise ~5–6 MB of JSON parsed on the main thread. This
bench times the REAL decode kernel (`assets/decode.js` → `decodeBlockTable` +
marker resolution) the browser worker runs.

```bash
node map_decode_bench.js <map.json> [iters]   # <map.json> = a blocks-encoded payload.map
```

Prints one JSON line: `{decodeMs, tableEntries, decodedBlocks, elements}`.
Driven + budget-asserted by `test_viewer_perf.py`
(`test_map_blocks_*`) — a synthetic **200k-point + 78k-triangle-fill** 2-D
payload, all three legs browserless (they run on the Node kernel):

| leg | assert | measured (this machine) |
|---|---|---|
| wire size | blocks **≥ 3× smaller** than the JSON floats of the same data | JSON **15.5 MB → blocks 5.1 MB = 3.05×** (8 table entries) |
| Node decode | `decodeMs < 300` for the ~950k-element block table | **~4.8 ms** (best of 3) |
| content-addressed dedup | two fills over one mesh → the `nodes`/`triangles` blocks appear **once** | 2 fills / shared mesh → **4 blocks** (nodes + tris shared, 2 distinct value blocks) |

vs the JSON floats it replaces: the map no longer parses megabytes of float text
on the main thread — the base64 blocks decode off-thread into typed arrays,
transferred zero-copy, and identical arrays decode once per session.

## 5. Stride-ladder LOD + cached composition (P2b/P3/P4/P5)

**LOD rings (`view2d(lod=…)`).** A payload may carry ONE coarse display ring
beside each full-resolution field — `fills[i].lod`, `map.grid_lines_lod`,
`contours[i].lines_lod` — decimated by the producer (`value_layer(stride=)`,
`wireframe_edges(stride=)`, `iso_lines(simplify=)`). Geometry truth is never
decimated; the ring is display-only and keeps the full-resolution colour range.
Browserless measure (`test_map_lod_coarse_ring_shrinks_wire`), a 198×198-node
(~78k-triangle) fill, stride 4:

| metric | full ring | coarse (stride 4) ring |
|---|---:|---:|
| triangles | 77,618 | 4,802 (**16.2× fewer**) |
| block bytes (base64) | 1.87 MB | 117 KB (**16× smaller**) |

**Expected switch behaviour** (asserted browser-side under Playwright in P4;
`window.__PETEK_LOD_ACTIVE` is exposed for the harness):

- The renderer picks the ring on **zoom-settle** — a ~150 ms debounce after the
  last wheel event, never per frame — so a mid-gesture zoom never flickers
  between rings.
- It switches to the coarse ring when a full-resolution data cell falls below
  **~4 px** on screen (`fullCellPx() < LOD_CELL_PX`), computed from the active
  fill's node density (√(bbox area / node count)) or the frame lattice spacing.
- Fills, mesh grid lines and contours switch together; the point cloud keeps its
  own baked path. A small "LOD" chip shows while the coarse ring is active.
- `lod=False` (and any LOD-unsupported payload) is byte-identical to the pre-LOD
  shape — the full rings render exactly as before.

**Fill baking (P3/P4).** The active value-fill rasterizes once into an offscreen
bitmap (viewport + margin, clamped to the fill bbox and the shared bake caps);
every active wheel/drag frame affine-blits the last valid bitmap (one
`drawImage`), including outside its bake window/zoom band, and an LOD ring
switch / invalid view re-bakes only on the shared settle — the
same baked-blit pattern (and the same `PT_*` caps, band and margin) the 200k
point cloud uses, so a 78k-triangle fill never re-triangulates per pan frame. The
bake key is `(colormap, range)` + ring object identity. Four entries are kept
with explicit LRU eviction, enough for A/B at full+LOD; returning A→B→A hits A.

`test_surface_navigation_hot_frames_are_compositing_only` builds a realistic
200k-point + 78k-triangle eight-field surface, with a stride-4 ring for each field,
full 198² wireframe, contours, and a block-encoded 1M-cell contact mask,
then drives 16 outward wheel events (crossing both the bitmap band and the
scale-derived point-radius threshold) and a >1000 px out-and-back pan. The browser harness
asserts at most one paint per rAF; p95 <8 ms and max <16.7 ms; zero point-path,
tri-fill, canvas-backing, legend-DOM, or theme-style work while hot; exactly one
settle rebuild; bounded cache size; and zero heavy builders on the final A of
A→B→A. It also asserts lazy initial values, one decode for B, no re-decode for
A, latest-request-wins rapid selection, and zero grid/contour/outline/contact
builders while hot. Current cached-Chromium run: 40 frames, p50 0.1 ms, p95
0.3 ms, max 0.4 ms; settle performs two overlay bakes and one contact scan.
The test skips cleanly when Playwright/Chromium is unavailable.

`test_surface_navigation_500_grid_hot_frames_are_compositing_only` repeats the
same eight-attribute/full-wireframe/contour gesture at 500×500 (the 198 case
alone carries the separate 1M contact mask). Current cached-Chromium result:
40 frames, p95 0.5 ms, max 0.6 ms, zero hot builders and 80 overlay blits.

`surface_attribute_build_bench.py` reproduces payload construction for 198² and
500² meshes at 1/2/4/8 lanes. Run `PYTHONPATH=python python
python/tests/viewer_perf/surface_attribute_build_bench.py --grid 198`. Against
the pre-P5 local 198² baseline, eight lanes without LOD improve from 2845 ms /
167.1 MB to 1711 ms / 49.3 MB. With default LOD the comparison is 3175 ms /
175.8 MB to 1785 ms / 51.1 MB. Both retain one full nodes digest and one full
triangles digest (and one shared pair for the LOD ring).

**Visibility-driven rendering (P3).** This viewer renders ON DEMAND — only the
active tab's render fn runs (`renderActive`), scene3d/volume repaint on
control-change, and the map coalesces interaction repaints through rAF; there is
**no persistent animation loop** to burn a background tab (verified). A hidden
document cancels the settle timer (`visibilitychange`); browsers already suspend
rAF for a hidden document. There is a **single** map canvas per exported page and
no multi-view/embedded-canvas machinery, so no `IntersectionObserver` is used —
it would gate work that does not exist.
