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
```

Prints one JSON line: `{decodeRenderMs, mapRenderMs, sectionRenderMs,
chartsRenderMs, usedJSHeapMB, volBadge, degradedBanner, consoleErrors}`.

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
