/*
 * petek viewer — v3 binary-block decode kernel (SCHEMA_VERSION 3).
 *
 * Pure, DOM-free, three.js-free. Decodes the petekStatic `VolumeBundle` wire
 * contract (API.md "Binary-block payload spec") into typed arrays and prepares a
 * render-ready exterior-shell mesh: deduped verts + per-triangle `tri_cell`
 * identity, flat-shaded per cell through the caller's colormap. Big arrays are
 * raw LITTLE-ENDIAN, tightly packed; a NaN f32 is canonical 0x7FC00000. Every
 * target platform (x86 / ARM) is little-endian, so a native typed-array view is
 * the correct read.
 *
 * DUAL MODE. This one file is:
 *   - a classic browser global  (`window.PETEK_DECODE`, inlined by save_view),
 *   - a CommonJS module          (`require(...)` — the Node perf harness),
 *   - the body of the inline Web Worker (built from these fns via `.toString()`
 *     so the worker needs NO external file — the zero-CDN / single-file rule).
 *
 * The heavy one-time cost (base64 -> ArrayBuffer, expand to non-indexed, first
 * flat-colour bake) runs in the worker so the UI thread never blocks; recolour
 * (colormap / theme / property switch) is a cheap worker round-trip that reuses
 * the retained decode.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PETEK_DECODE = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // base64 (LE bytes) -> Uint8Array. atob in browser/worker; Buffer under Node.
  function b64ToBytes(b64) {
    if (typeof atob === "function") {
      var bin = atob(b64), n = bin.length, out = new Uint8Array(n);
      for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, "base64")); // Node
  }

  // A block's raw LE bytes -> a typed array of its dtype. Always copies into a
  // fresh, element-aligned buffer so an unaligned sidecar slice is safe and the
  // result is detached from the source ArrayBuffer (transferable-friendly).
  function blockToTyped(bytes, dtype) {
    var ctor = dtype === "f32" ? Float32Array : dtype === "u32" ? Uint32Array :
      dtype === "u8" ? Uint8Array : Uint16Array;
    var buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    return new ctor(buf);
  }

  // A block descriptor -> its LE bytes: base64 `data`, or a slice of the sidecar
  // `model.bin` at (offset, length).
  function getBlockBytes(block, binU8) {
    if (block.data != null) return b64ToBytes(block.data);
    return binU8.subarray(block.offset, block.offset + block.length);
  }

  // ---- 2-D map blocks (content-addressed) ------------------------------------
  // The 2-D map bundle ships its bulk arrays as the SAME typed blocks the v3
  // volume uses, in a digest-keyed table (`map.blocks`), with fields referencing
  // them by digest (`{__block__}` / `{__csr__}`). Decode is the identical base64
  // -> ArrayBuffer -> typed-array read, done off the main thread and cached by
  // digest so an identical array (deduped in the table) decodes once per session.

  // Decode one `{dtype, shape, data}` descriptor to its typed array.
  function decodeBlockDesc(desc) {
    return blockToTyped(b64ToBytes(desc.data), desc.dtype);
  }

  // Decode every entry of a digest-keyed block table to typed arrays, skipping
  // digests already present in `cache` (the session-wide content-addressed
  // cache). Returns the cache (mutated), so identical blocks decode once.
  function decodeBlockTable(table, cache) {
    cache = cache || {};
    for (var d in table) {
      if (!Object.prototype.hasOwnProperty.call(table, d)) continue;
      if (cache[d] == null) cache[d] = decodeBlockDesc(table[d]);
    }
    return cache;
  }

  // Compact affine regular surface -> ready Three.js position/index/colour
  // buffers. Geometry construction is deliberately DOM/Three-free: legacy
  // scene resources run the complete pass in the shared worker, while an
  // already-decoded workspace surface advances the same state in bounded
  // main-thread chunks without copying or transferring its source arrays.
  function regularSurfaceArray(value) {
    if (!value) return null;
    if (value.a && typeof value.a.length === "number") return value.a;
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) return value;
    if (Array.isArray(value)) return value;
    return decodeBlockDesc(value);
  }
  function regularCategoryColor(categories, value) {
    var record = categories && categories[String(value)], css = record && record.color;
    var hex = typeof css === "string" && /^#([0-9a-f]{6})$/i.exec(css);
    if (hex) return [parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16)];
    var rgb = typeof css === "string" && /rgba?\(\s*([0-9]+)[, ]+\s*([0-9]+)[, ]+\s*([0-9]+)/i.exec(css);
    return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : [127.5, 127.5, 127.5];
  }
  function startRegularSurfaceColors(surface, range, stops, categories) {
    var values = surface.values ? regularSurfaceArray(surface.values) : null;
    if (!values) return { done: true, result: null };
    var col = new Float32Array(values.length * 3), lo = range ? range[0] : 0;
    var span = range ? ((range[1] - range[0]) || 1) : 1;
    return { values: values, col: col, lo: lo, span: span, stops: stops,
      categories: categories, q: 0, done: false, result: null };
  }
  function stepRegularSurfaceColors(state, limit) {
    if (state.done) return true;
    var end = Math.min(state.values.length, state.q + Math.max(1, limit | 0));
    for (; state.q < end; state.q++) {
      var v = state.values[state.q], c = !isFinite(v) ? [127.5, 127.5, 127.5]
        : state.categories ? regularCategoryColor(state.categories, v)
          : ramp(state.stops, (v - state.lo) / state.span);
      state.col[state.q * 3] = c[0] / 255;
      state.col[state.q * 3 + 1] = c[1] / 255;
      state.col[state.q * 3 + 2] = c[2] / 255;
    }
    if (state.q >= state.values.length) { state.done = true; state.result = state.col; }
    return state.done;
  }
  function buildRegularSurfaceColors(surface, range, stops, categories) {
    var state = startRegularSurfaceColors(surface, range, stops, categories);
    while (!stepRegularSurfaceColors(state, 0x3fffffff)) {}
    return state.result;
  }
  function startRegularSurface(surface, center, range, stops, categories) {
    var dims = surface.dimensions, nc = dims[0] | 0, nr = dims[1] | 0;
    var elev = regularSurfaceArray(surface.elevations);
    var mask = regularSurfaceArray(surface.mask);
    var n = nc * nr, pos = new Float32Array(n * 3);
    var colors = surface.values ? startRegularSurfaceColors(surface, range, stops, categories) : null;
    var ox = surface.origin[0], oy = surface.origin[1];
    var ix = surface.step_i[0], iy = surface.step_i[1];
    var jx = surface.step_j[0], jy = surface.step_j[1];
    var cx = center[0], cy = center[1], cz = center[2];
    var maxTris = Math.max(0, nc - 1) * Math.max(0, nr - 1) * 2;
    return { surface: surface, nc: nc, nr: nr, elev: elev, mask: mask, pos: pos,
      colors: colors, ox: ox, oy: oy, ix: ix, iy: iy, jx: jx, jy: jy,
      cx: cx, cy: cy, cz: cz, index: new Uint32Array(maxTris * 3), d: 0,
      q: 0, cell: 0, phase: "positions", done: false, result: null };
  }
  function stepRegularSurface(state, limit) {
    if (state.done) return true;
    var budget = Math.max(1, limit | 0), used = 0;
    if (state.phase === "positions") {
      var n = state.nc * state.nr, end = Math.min(n, state.q + budget);
      for (; state.q < end; state.q++, used++) {
        var i = state.q % state.nc, j = (state.q / state.nc) | 0;
        var rawZ = state.elev[state.q], z = state.surface.positive === "down" ? -rawZ : rawZ;
        state.pos[state.q * 3] = state.ox + i * state.ix + j * state.jx - state.cx;
        state.pos[state.q * 3 + 1] = z - state.cz;
        state.pos[state.q * 3 + 2] = state.oy + i * state.iy + j * state.jy - state.cy;
      }
      if (state.colors) stepRegularSurfaceColors(state.colors, used || budget);
      if (state.q >= n) state.phase = "topology";
    }
    var cells = Math.max(0, state.nc - 1) * Math.max(0, state.nr - 1);
    while (state.phase === "topology" && state.cell < cells && used < budget) {
      var ii = state.cell % Math.max(1, state.nc - 1), jj = (state.cell / Math.max(1, state.nc - 1)) | 0;
      state.cell++; used++;
      var a = jj * state.nc + ii, b = a + 1, c2 = a + state.nc, d2 = c2 + 1;
      if ((state.mask && (!state.mask[a] || !state.mask[b] || !state.mask[c2] || !state.mask[d2])) ||
          !isFinite(state.elev[a]) || !isFinite(state.elev[b]) || !isFinite(state.elev[c2]) || !isFinite(state.elev[d2])) continue;
      state.index[state.d++] = a; state.index[state.d++] = b; state.index[state.d++] = c2;
      state.index[state.d++] = b; state.index[state.d++] = d2; state.index[state.d++] = c2;
    }
    if (state.phase === "topology" && state.cell >= cells && (!state.colors || state.colors.done)) {
      if (state.d !== state.index.length) state.index = state.index.slice(0, state.d);
      state.done = true; state.result = { pos: state.pos, index: state.index,
        col: state.colors ? state.colors.result : null, triangleCount: state.d / 3 };
    }
    return state.done;
  }
  function buildRegularSurface(surface, center, range, stops, categories) {
    var state = startRegularSurface(surface, center, range, stops, categories);
    while (!stepRegularSurface(state, 0x3fffffff)) {}
    return state.result;
  }

  // Envelope + optional sidecar bytes -> the five decoded typed arrays + counts.
  function decodeBlocks(env, binU8) {
    var B = env.blocks;
    var positions = blockToTyped(getBlockBytes(B.positions, binU8), "f32");
    var indices = blockToTyped(getBlockBytes(B.indices, binU8), "u32");
    var triCell = blockToTyped(getBlockBytes(B.tri_cell, binU8), "u32");
    var cellValues = blockToTyped(getBlockBytes(B.cell_values, binU8), "f32");
    var zoneIds = blockToTyped(getBlockBytes(B.zone_ids, binU8), "u16");
    return {
      positions: positions, indices: indices, triCell: triCell,
      cellValues: cellValues, zoneIds: zoneIds,
      vertexCount: positions.length / 3,
      triangleCount: indices.length / 3,
      shellCellCount: cellValues.length,
    };
  }

  // Mean vertex (grid-LOCAL) — the recentre origin.
  function computeCenter(positions) {
    var n = positions.length / 3, cx = 0, cy = 0, cz = 0;
    for (var q = 0; q < n; q++) { cx += positions[q * 3]; cy += positions[q * 3 + 1]; cz += positions[q * 3 + 2]; }
    return n ? [cx / n, cy / n, cz / n] : [0, 0, 0];
  }

  // True (un-exaggerated) source-depth extent — for the readout.
  function depthRange(positions) {
    var n = positions.length / 3, lo = Infinity, hi = -Infinity;
    for (var q = 0; q < n; q++) { var z = positions[q * 3 + 2]; if (z < lo) lo = z; if (z > hi) hi = z; }
    return { min: lo, max: hi };
  }

  // Expand the indexed, deduped shell into a NON-indexed render buffer AND apply
  // the recentre + axis-swap so depth is +down in three's y-up frame
  // (X = x-cx, Y = -(z-cz), Z = y-cy). Non-indexed is required for true flat
  // per-cell colour (a deduped vertex is shared across cells, so a per-vertex
  // colour would bleed); z-exaggeration is then a cheap mesh.scale.y, never a
  // per-vertex rebuild.
  //
  // `stride` (>=1) is the AUTOMATIC-DEGRADATION knob: when the shell exceeds the
  // render/memory budget the caller passes stride>1 so only every stride-th
  // triangle is emitted — the render buffer (and its heap) shrink by ~stride, so
  // the viewer degrades to a decimated preview instead of ever OOM-ing. Returns
  // Float32Array[ceil(T/stride)*9].
  function expandRenderPositions(positions, indices, center, stride) {
    stride = stride && stride > 1 ? stride | 0 : 1;
    var T = indices.length / 3, Tk = Math.ceil(T / stride);
    var out = new Float32Array(Tk * 9);
    var cx = center[0], cy = center[1], cz = center[2], d = 0;
    for (var t = 0; t < T; t += stride) {
      var o = t * 3;
      for (var c = 0; c < 3; c++) {
        var s = indices[o + c] * 3;
        out[d] = positions[s] - cx;
        out[d + 1] = -(positions[s + 2] - cz);
        out[d + 2] = positions[s + 1] - cy;
        d += 3;
      }
    }
    return out;
  }

  // Decimate a per-triangle `tri_cell` array to keep only every stride-th
  // triangle (paired with expandRenderPositions/bakeColors so the decimated
  // preview's triangle t maps back to its true shell cell). stride<=1 is a no-op.
  function decimateTriCell(triCell, stride) {
    stride = stride && stride > 1 ? stride | 0 : 1;
    if (stride === 1) return triCell;
    var T = triCell.length, Tk = Math.ceil(T / stride), out = new Uint32Array(Tk);
    for (var tk = 0, t = 0; t < T; t += stride, tk++) out[tk] = triCell[t];
    return out;
  }

  // Linear ramp over rgb anchor stops (0..255) — matches the viewer's colormap.
  function ramp(stops, t) {
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var seg = (stops.length - 1) * t;
    var i = Math.min(stops.length - 2, Math.floor(seg));
    var f = seg - i, a = stops[i], b = stops[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }

  // Flat per-triangle colour: tri_cell -> cell_values -> ramp, written to all 3
  // corners of each (non-indexed) triangle. NaN cell (0x7FC00000) -> mid-grey.
  // Returns Float32Array[T*3*3] (rgb 0..1).
  function bakeColors(triCell, cellValues, vmin, vmax, stops) {
    var T = triCell.length, out = new Float32Array(T * 9), span = (vmax - vmin) || 1;
    for (var t = 0; t < T; t++) {
      var v = cellValues[triCell[t]], r, g, b;
      if (isFinite(v)) { var c = ramp(stops, (v - vmin) / span); r = c[0] / 255; g = c[1] / 255; b = c[2] / 255; }
      else { r = 0.5; g = 0.5; b = 0.5; }
      var o = t * 9;
      out[o] = r; out[o + 1] = g; out[o + 2] = b;
      out[o + 3] = r; out[o + 4] = g; out[o + 5] = b;
      out[o + 6] = r; out[o + 7] = g; out[o + 8] = b;
    }
    return out;
  }

  // The worker message handler, referenced ONLY via `.toString()` (below). In
  // the worker its helper calls resolve to the top-level vars reconstructed by
  // workerSource(); it is never invoked in the main/Node context.
  function workerOnMessage(e) {
    var m = e.data;
    if (m.cmd === "decode") {
      var t0 = Date.now();
      var stride = m.stride && m.stride > 1 ? m.stride | 0 : 1;
      var d = decodeBlocks(m.env, m.bin ? new Uint8Array(m.bin) : null);
      var center = computeCenter(d.positions);
      var pos = expandRenderPositions(d.positions, d.indices, center, stride);
      var triCell = decimateTriCell(d.triCell, stride);   // kept-triangle -> shell cell
      var col = bakeColors(triCell, d.cellValues, m.vmin, m.vmax, m.stops);
      _keep = { triCell: triCell, cellValues: d.cellValues }; // retained for recolour
      var tc = triCell.slice(), cv = d.cellValues.slice(), zi = d.zoneIds.slice();
      postMessage({
        cmd: "decoded", requestId: m.requestId, paintKey: m.paintKey,
        pos: pos.buffer, col: col.buffer,
        triCell: tc.buffer, cellValues: cv.buffer, zoneIds: zi.buffer,
        center: center, depthRange: depthRange(d.positions),
        vertexCount: d.vertexCount, triangleCount: triCell.length,
        fullTriangleCount: d.triangleCount, stride: stride,
        shellCellCount: d.shellCellCount, decodeMs: Date.now() - t0,
      }, [pos.buffer, col.buffer, tc.buffer, cv.buffer, zi.buffer]);
    } else if (m.cmd === "recolor") {
      var c2 = bakeColors(_keep.triCell, _keep.cellValues, m.vmin, m.vmax, m.stops);
      postMessage({ cmd: "recolored", requestId: m.requestId, paintKey: m.paintKey, col: c2.buffer }, [c2.buffer]);
    } else if (m.cmd === "decode2d") {
      // Decode a 2-D map's block table off the main thread; post the decoded
      // buffers back as transferables (zero-copy) keyed by digest, plus the
      // per-digest dtype so the main thread can re-view each ArrayBuffer.
      var t2 = Date.now();
      var dec = decodeBlockTable(m.table, {});
      var bufs = {}, dtypes = {}, transfer = [];
      for (var dg in dec) {
        if (!Object.prototype.hasOwnProperty.call(dec, dg)) continue;
        bufs[dg] = dec[dg].buffer; dtypes[dg] = m.table[dg].dtype; transfer.push(dec[dg].buffer);
      }
      postMessage({ cmd: "decoded2d", requestId: m.requestId, blocks: bufs, dtypes: dtypes, decodeMs: Date.now() - t2 }, transfer);
    } else if (m.cmd === "buildRegularSurface") {
      var t3 = Date.now();
      var built = buildRegularSurface(m.surface, m.center, m.range, m.stops, m.categories);
      var transfer3 = [built.pos.buffer, built.index.buffer];
      if (built.col) transfer3.push(built.col.buffer);
      postMessage({
        cmd: "regularSurfaceBuilt", requestId: m.requestId,
        pos: built.pos.buffer, index: built.index.buffer,
        col: built.col ? built.col.buffer : null,
        triangleCount: built.triangleCount, buildMs: Date.now() - t3,
      }, transfer3);
    }
  }

  // Build the inline-worker source: reconstruct the pure fns as top-level vars
  // (so workerOnMessage's bare-name calls resolve) + the message hook. No fetch,
  // no external file — inlined as a Blob URL under the zero-CDN rule.
  function workerSource() {
    return [
      "var _keep=null;",
      "var b64ToBytes=" + b64ToBytes.toString() + ";",
      "var blockToTyped=" + blockToTyped.toString() + ";",
      "var getBlockBytes=" + getBlockBytes.toString() + ";",
      "var decodeBlockDesc=" + decodeBlockDesc.toString() + ";",
      "var decodeBlockTable=" + decodeBlockTable.toString() + ";",
      "var regularSurfaceArray=" + regularSurfaceArray.toString() + ";",
      "var regularCategoryColor=" + regularCategoryColor.toString() + ";",
      "var startRegularSurfaceColors=" + startRegularSurfaceColors.toString() + ";",
      "var stepRegularSurfaceColors=" + stepRegularSurfaceColors.toString() + ";",
      "var buildRegularSurfaceColors=" + buildRegularSurfaceColors.toString() + ";",
      "var startRegularSurface=" + startRegularSurface.toString() + ";",
      "var stepRegularSurface=" + stepRegularSurface.toString() + ";",
      "var buildRegularSurface=" + buildRegularSurface.toString() + ";",
      "var decodeBlocks=" + decodeBlocks.toString() + ";",
      "var computeCenter=" + computeCenter.toString() + ";",
      "var depthRange=" + depthRange.toString() + ";",
      "var expandRenderPositions=" + expandRenderPositions.toString() + ";",
      "var decimateTriCell=" + decimateTriCell.toString() + ";",
      "var ramp=" + ramp.toString() + ";",
      "var bakeColors=" + bakeColors.toString() + ";",
      "onmessage=" + workerOnMessage.toString() + ";",
    ].join("\n");
  }

  // Synchronous fallback (no Worker / blob URL blocked): same result shape as the
  // worker `decoded` message, computed on the calling thread.
  function decodeSync(env, binU8, vmin, vmax, stops, stride) {
    var t0 = Date.now();
    stride = stride && stride > 1 ? stride | 0 : 1;
    var d = decodeBlocks(env, binU8);
    var center = computeCenter(d.positions);
    var triCell = decimateTriCell(d.triCell, stride);
    return {
      pos: expandRenderPositions(d.positions, d.indices, center, stride),
      col: bakeColors(triCell, d.cellValues, vmin, vmax, stops),
      triCell: triCell, cellValues: d.cellValues, zoneIds: d.zoneIds,
      center: center, depthRange: depthRange(d.positions),
      vertexCount: d.vertexCount, triangleCount: triCell.length,
      fullTriangleCount: d.triangleCount, stride: stride,
      shellCellCount: d.shellCellCount, decodeMs: Date.now() - t0,
    };
  }

  return {
    b64ToBytes: b64ToBytes, blockToTyped: blockToTyped, getBlockBytes: getBlockBytes,
    decodeBlockDesc: decodeBlockDesc, decodeBlockTable: decodeBlockTable,
    regularSurfaceArray: regularSurfaceArray, regularCategoryColor: regularCategoryColor,
    startRegularSurfaceColors: startRegularSurfaceColors,
    stepRegularSurfaceColors: stepRegularSurfaceColors,
    buildRegularSurfaceColors: buildRegularSurfaceColors,
    startRegularSurface: startRegularSurface, stepRegularSurface: stepRegularSurface,
    buildRegularSurface: buildRegularSurface,
    decodeBlocks: decodeBlocks, computeCenter: computeCenter, depthRange: depthRange,
    expandRenderPositions: expandRenderPositions, decimateTriCell: decimateTriCell,
    ramp: ramp, bakeColors: bakeColors,
    workerSource: workerSource, decodeSync: decodeSync,
  };
});
