/*
 * Node perf harness — times the REAL 2-D map block decode (assets/decode.js)
 * the browser worker runs for a blocks-encoded view2d payload: base64 ->
 * ArrayBuffer -> typed arrays for the digest-keyed block table, then resolving
 * the fields' `{__block__}` / `{__csr__}` markers against the decoded cache.
 * This is the exact kernel that replaces the map's ~5-6 MB main-thread JSON
 * float parse (see viewer_perf/README.md).
 *
 *   node map_decode_bench.js <map.json> [iters]
 *
 * <map.json> is a blocks-encoded `payload.map` (carries `blocks` + markers).
 * Prints one JSON line: decodeMs (best of iters), the table entry count (blocks
 * shipped — dedup already applied), and the total decoded element count.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const D = require(path.join(__dirname, "..", "..", "petektools", "viewer", "assets", "decode.js"));
const map = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const iters = parseInt(process.argv[3] || "3", 10);

// Resolve every field marker against the decoded {digest: typedArray} cache —
// exactly what the viewer's fillMap2d does. Returns the total element count so a
// regression that silently drops a block is caught.
function resolveMarkers(m, cache) {
  let elems = 0;
  const blk = (mk) => { elems += cache[mk.__block__].length; };
  const csr = (mk) => { elems += cache[mk.__csr__.coords].length + cache[mk.__csr__.offsets].length; };
  if (m.points && m.points.__block__) blk(m.points);
  (m.fills || []).forEach((f) => {
    if (f.nodes && f.nodes.__block__) blk(f.nodes);
    if (f.triangles && f.triangles.__block__) blk(f.triangles);
    if (f.values && f.values.__block__) blk(f.values);
  });
  if (m.grid_lines && m.grid_lines.__csr__) csr(m.grid_lines);
  (m.contours || []).forEach((c) => { if (c.lines && c.lines.__csr__) csr(c.lines); });
  return elems;
}

let best = Infinity, elems = 0, digests = 0;
for (let i = 0; i < iters; i++) {
  const t0 = process.hrtime.bigint();
  const cache = D.decodeBlockTable(map.blocks, {});
  elems = resolveMarkers(map, cache);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (ms < best) best = ms;
  digests = Object.keys(cache).length;
}
process.stdout.write(JSON.stringify({
  decodeMs: +best.toFixed(3),
  tableEntries: Object.keys(map.blocks).length,
  decodedBlocks: digests,
  elements: elems,
}) + "\n");
