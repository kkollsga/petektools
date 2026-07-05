/*
 * Node perf harness — times the REAL v3 decode kernel (assets/decode.js) that
 * the browser worker runs: base64 -> ArrayBuffer -> typed arrays -> expand to a
 * non-indexed shell -> flat colour bake. This is the exact code path that
 * replaced the viewer's V8 string wall (the ledger's ~537 MB death at ~1M
 * cells), so its Node timing is faithful to the browser worker's decode cost
 * (the three.js GPU upload is browser-only and measured by the Playwright spec).
 *
 *   node decode_bench.js <envelope.json> [iters]
 *
 * Prints one JSON line: triangles, decodeMs (best of iters), heap + buffer MB.
 * Run with --expose-gc for a settled heap reading.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const D = require(path.join(__dirname, "..", "..", "petektools", "viewer", "assets", "decode.js"));
const env = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const iters = parseInt(process.argv[3] || "3", 10);

// viridis anchor stops — mirrors the viewer's COLORMAPS.viridis.
const stops = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
const r = env.value_range || { min: 0, max: 1 };

let best = Infinity, res;
for (let i = 0; i < iters; i++) {
  const t0 = process.hrtime.bigint();
  res = D.decodeSync(env, null, r.min, r.max, stops);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (ms < best) best = ms;
}
if (global.gc) global.gc();
const m = process.memoryUsage();
process.stdout.write(JSON.stringify({
  triangles: res.triangleCount,
  vertices: res.vertexCount,
  shellCells: res.shellCellCount,
  decodeMs: +best.toFixed(2),
  heapUsedMB: +(m.heapUsed / 1048576).toFixed(1),
  rssMB: +(m.rss / 1048576).toFixed(1),
  posMB: +(res.pos.byteLength / 1048576).toFixed(1),
  colMB: +(res.col.byteLength / 1048576).toFixed(1),
}) + "\n");
