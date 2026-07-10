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
```

Prints one JSON line: `{decodeRenderMs, mapRenderMs, sectionRenderMs,
chartsRenderMs, usedJSHeapMB, volBadge, degradedBanner, consoleErrors}` (plus
`dragFrames/dragFrameMsMedian/hoverAvgMs/hoverReadout` with `--drag-events`).

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
path must repaint at most once per frame; exit 8 when it doesn't) and a non-drag
hover sweep, and `--drag-frame-cap-ms` budget-asserts the median coalesced
repaint (exit 9). Driven by `test_render_200k_points_pan_hover_budget`.

Measured (this machine, headless Chromium), 200k coloured points + ~160 overlay
lines, before → after the batched/baked/rAF point path:

| metric | before | after |
|---|---:|---:|
| map render (`__PETEK_RENDER_MS`) | 145.3 ms | 0.5 ms |
| drag repaint | 138.9 ms/event (sync per event) | 30 frames / 90 events, median 0.1 ms |
| wheel zoom | 138.8 ms/event | ≤ ~10 ms worst frame (immediate), sub-ms blit |
| hover mousemove | 2.6 ms (O(n) scan) | 0.1 ms (grid bucket) |

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
