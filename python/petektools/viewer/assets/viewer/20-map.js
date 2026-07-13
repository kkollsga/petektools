  // ======================================================================= MAP
  var mapView = { scale: 1, ox: 0, oy: 0, fitted: false };
  function mapFrame() { return App.payload.map.frame; }
  function worldExtent() {
    var f = mapFrame();
    return {
      x0: f.origin_x, y0: f.origin_y,
      x1: f.origin_x + (f.ncol - 1) * f.spacing_x,
      y1: f.origin_y + (f.nrow - 1) * f.spacing_y,
    };
  }
  // Fit the full drawn CONTENT — the frame lattice unioned with the outline rings
  // and the well markers — so nothing sits off-canvas and the content is centred
  // (a small outline inside a larger frame no longer leaves dead space to one side).
  function contentExtent() {
    var e = worldExtent();
    var xlo = Math.min(e.x0, e.x1), xhi = Math.max(e.x0, e.x1);
    var ylo = Math.min(e.y0, e.y1), yhi = Math.max(e.y0, e.y1);
    function ext(x, y) { if (x < xlo) xlo = x; if (x > xhi) xhi = x; if (y < ylo) ylo = y; if (y > yhi) yhi = y; }
    function extLineSet(L) { for (var k = 0; k < lsN(L); k++) { var n = lineLen(L, k); for (var i = 0; i < n; i++) ext(lineX(L, k, i), lineY(L, k, i)); } }
    (App.payload.map.outline || []).forEach(function (ring) { ring.forEach(function (pt) { ext(pt[0], pt[1]); }); });
    extLineSet(App.payload.map.grid_lines);
    if (App.payload.map.points && App.payload.map.points.length) {
      var bb = pointBBox(App.payload.map.points); // cached — never rescan the cloud
      ext(bb.x0, bb.y0); ext(bb.x1, bb.y1);
    }
    (App.payload.map.fills || []).forEach(function (f) { var N = f.nodes; for (var q = 0; q < (N ? N.length : 0); q++) ext(ndX(N, q), ndY(N, q)); });
    (App.payload.map.contours || []).forEach(function (c) { extLineSet(c.lines); });
    (App.payload.wells || []).forEach(function (w) { ext(w.x, w.y); });
    return { x0: xlo, y0: ylo, x1: xhi, y1: yhi };
  }
  function fitMap(cv) {
    var e = contentExtent(), w = Math.abs(e.x1 - e.x0) || 1, h = Math.abs(e.y1 - e.y0) || 1;
    var pad = 48;
    var s = Math.min((cv.width - 2 * pad) / w, (cv.height - 2 * pad) / h);
    mapView.scale = s;
    mapView.ox = (cv.width - w * s) / 2 - Math.min(e.x0, e.x1) * s;
    mapView.oy = (cv.height - h * s) / 2 - Math.min(e.y0, e.y1) * s;
    mapView.fitted = true;
    // Seed the LOD ring for the fitted zoom (a very fine mesh fitted whole may
    // already want the coarse ring); later zooms flip it on settle.
    if (typeof S !== "undefined") S.lodActive = computeLodActive();
  }
  function w2s(x, y) { return [x * mapView.scale + mapView.ox, y * mapView.scale + mapView.oy]; }
  function s2w(px, py) { return [(px - mapView.ox) / mapView.scale, (py - mapView.oy) / mapView.scale]; }

  // ---- 2-D map binary blocks (typed arrays) + plain-array fallback -----------
  // A blocks-encoded payload (SCHEMA.md) ships the bulk arrays as content-
  // addressed typed blocks in `map.blocks` (a digest table), with the fields
  // holding `{__block__}` / `{__csr__}` markers. decodeMap2d() resolves them —
  // OFF the main thread when a Worker is available (the same kernel the volume
  // uses), else synchronously — into typed-array-backed objects the accessors
  // below read; a JSON payload keeps plain nested arrays and reads the same way.
  // The digest cache (window.__PETEK_BLOCK_CACHE) dedups decodes across views.
  function isBlockMarker(x) { return x != null && typeof x === "object" && typeof x.__block__ === "string"; }
  function isCsrMarker(x) { return x != null && typeof x === "object" && x.__csr__ != null; }
  function prepBlock(marker, table) { var d = marker.__block__; return { length: table[d].shape[0], __d: d, a: null }; }
  function prepCsr(marker, table) { var cs = marker.__csr__; return { length: table[cs.offsets].shape[0] - 1, __dc: cs.coords, __do: cs.offsets, coords: null, offsets: null }; }
  // Replace every marker with a normalized object carrying the correct `.length`
  // (from the table metadata) up front, so the panel/legend length checks are
  // right before the typed data even arrives.
  // Normalize a fill's (or a fill LOD ring's) nodes/triangles/values markers.
  function prepFillArrays(f, t) {
    if (isBlockMarker(f.nodes)) f.nodes = prepBlock(f.nodes, t);
    if (isBlockMarker(f.triangles)) f.triangles = prepBlock(f.triangles, t);
    if (isBlockMarker(f.values)) f.values = prepBlock(f.values, t);
  }
  function prepMap2d(m) {
    var t = m.blocks;
    if (isBlockMarker(m.points)) m.points = prepBlock(m.points, t);
    (m.fills || []).forEach(function (f) {
      prepFillArrays(f, t);
      if (f.lod) prepFillArrays(f.lod, t); // additive coarse LOD ring
    });
    if (isCsrMarker(m.grid_lines)) m.grid_lines = prepCsr(m.grid_lines, t);
    if (isCsrMarker(m.grid_lines_lod)) m.grid_lines_lod = prepCsr(m.grid_lines_lod, t);
    (m.contours || []).forEach(function (c) {
      if (isCsrMarker(c.lines)) c.lines = prepCsr(c.lines, t);
      if (isCsrMarker(c.lines_lod)) c.lines_lod = prepCsr(c.lines_lod, t);
    });
    (m.contacts || []).forEach(function (c) {
      if (isBlockMarker(c.crossing)) c.crossing = prepBlock(c.crossing, t);
    });
  }
  function fillOne(o, cache) {
    if (o && o.__d != null) o.a = cache[o.__d];
    else if (o && o.__dc != null) { o.coords = cache[o.__dc]; o.offsets = cache[o.__do]; }
  }
  function fillMap2dBase(m, cache) {
    fillOne(m.points, cache);
    (m.fills || []).forEach(function (f) {
      fillOne(f.nodes, cache); fillOne(f.triangles, cache);
      if (f.lod) { fillOne(f.lod.nodes, cache); fillOne(f.lod.triangles, cache); }
    });
    fillOne(m.grid_lines, cache);
    fillOne(m.grid_lines_lod, cache);
    (m.contours || []).forEach(function (c) { fillOne(c.lines, cache); fillOne(c.lines_lod, cache); });
    (m.contacts || []).forEach(function (c) { fillOne(c.crossing, cache); });
  }
  function fillMap2dValues(fill, cache) {
    if (!fill) return;
    fillOne(fill.values, cache);
    if (fill.lod) fillOne(fill.lod.values, cache);
  }
  function typedFromBuffer(buf, dtype) {
    return new (dtype === "f32" ? Float32Array : dtype === "u32" ? Uint32Array :
      dtype === "u8" ? Uint8Array : Uint16Array)(buf);
  }
  function blockCache() { return window.__PETEK_BLOCK_CACHE || (window.__PETEK_BLOCK_CACHE = {}); }
  var _map2dPending = {}; // request id -> completion while worker decodes
  var _map2dRequestId = 0;
  var _mapFillWanted = 0;
  function addDigest(out, o) {
    if (!o) return;
    if (o.__d != null) out[o.__d] = true;
    if (o.__dc != null) { out[o.__dc] = true; out[o.__do] = true; }
  }
  function baseDigests(m) {
    var out = {};
    addDigest(out, m.points);
    (m.fills || []).forEach(function (f) {
      addDigest(out, f.nodes); addDigest(out, f.triangles);
      if (f.lod) { addDigest(out, f.lod.nodes); addDigest(out, f.lod.triangles); }
    });
    addDigest(out, m.grid_lines); addDigest(out, m.grid_lines_lod);
    (m.contours || []).forEach(function (c) { addDigest(out, c.lines); addDigest(out, c.lines_lod); });
    (m.contacts || []).forEach(function (c) { addDigest(out, c.crossing); });
    return out;
  }
  function valueDigests(fill) {
    var out = {}; if (!fill) return out;
    addDigest(out, fill.values); if (fill.lod) addDigest(out, fill.lod.values);
    return out;
  }
  function mergeDigests(dst, src) { for (var d in src) if (Object.prototype.hasOwnProperty.call(src, d)) dst[d] = true; }
  function updateBlockStatus(m) {
    var decoded = 0, cache = blockCache(), total = Object.keys(m.blocks || {}).length;
    for (var d in m.blocks) if (cache[d] != null) decoded++;
    window.__PETEK_MAP_BLOCK_STATUS = {
      total: total, decoded: decoded, pending: Object.keys(_map2dPending).length,
      activeFill: (typeof S !== "undefined" ? S.mapFillIdx : 0)
    };
  }
  function decodeMapDigests(m, requested, done) {
    var cache = blockCache(), table = m.blocks, needed = {}, n = 0;
    for (var d in requested) {
      if (!Object.prototype.hasOwnProperty.call(requested, d) || cache[d] != null) continue;
      needed[d] = table[d]; n++;
    }
    if (!n) { done(); updateBlockStatus(m); return; }
    perfCount("blockDecodeRequests");
    _viewerPerf.blockDecodeDigests += n;
    var w = typeof ensureWorker === "function" ? ensureWorker() : null;
    if (w) {
      var id = ++_map2dRequestId;
      _map2dPending[id] = { m: m, done: done };
      updateBlockStatus(m);
      w.postMessage({ cmd: "decode2d", requestId: id, table: needed });
    } else {
      if (window.PETEK_DECODE) window.PETEK_DECODE.decodeBlockTable(needed, cache);
      done(); updateBlockStatus(m);
    }
  }
  // Boot hook (called from boot() before initState): resolve the map's blocks.
  function decodeMap2d(payload) {
    var m = payload && payload.map;
    if (!m || !m.blocks || m.__blocksReady) return;
    prepMap2d(m);
    var requested = baseDigests(m), initialFill = (m.fills || [])[0];
    mergeDigests(requested, valueDigests(initialFill));
    m.__blocksPending = true;
    decodeMapDigests(m, requested, function () {
      var cache = blockCache(); fillMap2dBase(m, cache); fillMap2dValues(initialFill, cache);
      m.__blocksReady = true; m.__blocksPending = false; updateBlockStatus(m);
    });
  }
  // Worker `decoded2d` reply → cache the transferred buffers by digest, fill the
  // normalized objects, and repaint. Routed from the shared worker's onmessage.
  function onMap2dDecoded(data) {
    var cache = blockCache();
    for (var dg in data.blocks) {
      if (!Object.prototype.hasOwnProperty.call(data.blocks, dg)) continue;
      cache[dg] = typedFromBuffer(data.blocks[dg], data.dtypes[dg]);
    }
    var pending = _map2dPending[data.requestId];
    if (pending) {
      delete _map2dPending[data.requestId];
      pending.done(); updateBlockStatus(pending.m);
      if (App.tab === "map") { renderMap(); }
      if (typeof buildPanel === "function") buildPanel();
    }
  }
  function selectMapFill(index) {
    var m = App.payload.map, fill = (m.fills || [])[index];
    if (!fill) return;
    // Re-selecting the still-visible lane cancels a pending different choice.
    // Its worker reply may populate the digest cache but must not activate it.
    if (index === S.mapFillIdx) { _mapFillWanted = index; return; }
    if (index === _mapFillWanted) return;
    _mapFillWanted = index;
    var needs = valueDigests(fill), cache = blockCache(), lazy = false;
    for (var d in needs) if (cache[d] == null) { lazy = true; break; }
    if (lazy) perfCount("lazyFillDecodes");
    decodeMapDigests(m, needs, function () {
      fillMap2dValues(fill, cache);
      if (_mapFillWanted !== index) { updateBlockStatus(m); return; }
      S.mapFillIdx = index;
      updateBlockStatus(m); renderMap(); if (typeof buildPanel === "function") buildPanel();
    });
  }

  // Bulk-array accessors: `.a` (typed) present → index the typed array; else the
  // plain nested array. points: f32[n,3]; fill nodes: f32[n,2]; triangles:
  // u32[n,3]; values: f32[n]; line sets (grid_lines / contour lines): CSR coords
  // f32[total,2] + offsets u32[n+1], or a plain [[ [x,y] ... ]] array.
  function ptN(P) { return P ? P.length : 0; }
  function ptX(P, i) { return P.a ? P.a[i * 3] : P[i][0]; }
  function ptY(P, i) { return P.a ? P.a[i * 3 + 1] : P[i][1]; }
  function ptZ(P, i) { if (P.a) return P.a[i * 3 + 2]; var p = P[i]; return p.length > 2 ? p[2] : NaN; }
  function ndX(N, i) { return N.a ? N.a[i * 2] : N[i][0]; }
  function ndY(N, i) { return N.a ? N.a[i * 2 + 1] : N[i][1]; }
  function trN(T) { return T ? T.length : 0; }
  function trAt(T, t, c) { return T.a ? T.a[t * 3 + c] : T[t][c]; }
  function vlAt(V, i) { return V ? (V.a ? V.a[i] : V[i]) : null; }
  function maskAt(V, i) { return V ? (V.a ? V.a[i] : V[i]) : 0; }
  function lsN(L) { return L ? L.length : 0; }
  function lineLen(L, k) { return L.offsets ? (L.offsets[k + 1] - L.offsets[k]) : L[k].length; }
  function lineX(L, k, i) { return L.offsets ? L.coords[(L.offsets[k] + i) * 2] : L[k][i][0]; }
  function lineY(L, k, i) { return L.offsets ? L.coords[(L.offsets[k] + i) * 2 + 1] : L[k][i][1]; }
  // Stroke one line set (typed or plain) into the current path.
  function strokeLineSet(ctx, L, sc, ox, oy) {
    if (sc == null) { sc = mapView.scale; ox = mapView.ox; oy = mapView.oy; }
    for (var k = 0; k < lsN(L); k++) {
      var n = lineLen(L, k);
      for (var i = 0; i < n; i++) {
        var x = lineX(L, k, i) * sc + ox, y = lineY(L, k, i) * sc + oy;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }
  }

  // The outline is immutable payload geometry. Compile it once in WORLD
  // coordinates; transforms then serve both raster clipping and settled paint.
  var _outlinePath = { ref: null, path: null };
  function outlineWorldPath() {
    var rings = App.payload.map.outline;
    if (!rings || !rings.length) return null;
    if (_outlinePath.ref === rings) return _outlinePath.path;
    var path = new Path2D();
    rings.forEach(function (ring) {
      ring.forEach(function (pt, i) { if (i === 0) path.moveTo(pt[0], pt[1]); else path.lineTo(pt[0], pt[1]); });
    });
    _outlinePath = { ref: rings, path: path }; perfCount("outlinePathBuilds");
    return path;
  }

  // The map raster is WINDOWED + resolution-capped: only the grid cells inside the
  // current viewport are sampled, and never more than MAX_RASTER_DIM samples per
  // axis (stride-subsampled beyond that). So the offscreen ImageData and the
  // per-repaint loop stay bounded no matter how large ncol×nrow grows — a huge
  // field costs the same per frame as a screenful, and a full repaint never
  // allocates an ncol×nrow image. Hover reads the full-res value array directly,
  // so precision is unaffected.
  var MAX_RASTER_DIM = 2048;
  var _raster = { canvas: null, ctx: null, img: null }; // reused offscreen raster
  // A 256-entry colour LUT per colormap — the raster hot loop indexes it instead
  // of calling rampColor() (interpolation + allocation) per sample, so a
  // screenful of raster is a tight typed-array copy. Cached by name (the maps are
  // theme-independent). The legend/section keep the exact ramp.
  var _lutCache = {};
  function colormapLUT(name) {
    if (_lutCache[name]) return _lutCache[name];
    var n = 256, lut = new Uint8Array(n * 3);
    for (var i = 0; i < n; i++) {
      var c = rampColor(name, i / (n - 1)) || [128, 128, 128];
      lut[i * 3] = c[0]; lut[i * 3 + 1] = c[1]; lut[i * 3 + 2] = c[2];
    }
    _lutCache[name] = lut;
    return lut;
  }
  function drawWindowedRaster(ctx, cv, f, layer) {
    var sx = f.spacing_x, sy = f.spacing_y;
    // visible world rect (canvas corners -> world), padded a cell each side.
    var a = s2w(0, 0), b = s2w(cv.width, cv.height);
    var i0 = Math.floor((Math.min(a[0], b[0]) - f.origin_x) / sx) - 1;
    var i1 = Math.ceil((Math.max(a[0], b[0]) - f.origin_x) / sx) + 1;
    var j0 = Math.floor((Math.min(a[1], b[1]) - f.origin_y) / sy) - 1;
    var j1 = Math.ceil((Math.max(a[1], b[1]) - f.origin_y) / sy) + 1;
    if (i0 < 0) i0 = 0;
    if (j0 < 0) j0 = 0;
    if (i1 > f.ncol - 1) i1 = f.ncol - 1;
    if (j1 > f.nrow - 1) j1 = f.nrow - 1;
    var wcols = i1 - i0 + 1, wrows = j1 - j0 + 1;
    if (wcols <= 0 || wrows <= 0) return; // no part of the grid is on-screen
    // Resolution cap: never raster finer than the pixels the window occupies on
    // screen (one sample/screen-pixel is the most that can be resolved), bounded
    // by an absolute MAX_RASTER_DIM ceiling. So a fully-zoomed-out huge grid costs
    // ~one screenful of samples, and a zoomed-in view costs even less.
    var capX = Math.max(1, Math.min(MAX_RASTER_DIM, Math.ceil(Math.abs(wcols * mapView.scale * sx))));
    var capY = Math.max(1, Math.min(MAX_RASTER_DIM, Math.ceil(Math.abs(wrows * mapView.scale * sy))));
    var stI = Math.max(1, Math.ceil(wcols / capX));
    var stJ = Math.max(1, Math.ceil(wrows / capY));
    var rc = Math.ceil(wcols / stI), rr = Math.ceil(wrows / stJ);
    // Reuse one offscreen canvas + ImageData across repaints (allocating a fresh
    // MP-sized canvas every pan frame is the real cost at high ncol×nrow).
    var R = _raster;
    if (!R.canvas) { R.canvas = document.createElement("canvas"); R.ctx = R.canvas.getContext("2d"); }
    if (R.canvas.width !== rc || R.canvas.height !== rr) {
      R.canvas.width = rc; R.canvas.height = rr; R.img = R.ctx.createImageData(rc, rr);
    }
    var off = R.canvas, octx = R.ctx, img = R.img;
    var vals = layer.values, ncol = f.ncol;
    var r = layer.range || { min: 0, max: 1 }, span = (r.max - r.min) || 1;
    var lut = colormapLUT(S.colormap), data = img.data;
    for (var rj = 0; rj < rr; rj++) {
      var jj = j0 + rj * stJ;
      for (var ri = 0; ri < rc; ri++) {
        var ii = i0 + ri * stI;
        var o = (rj * rc + ri) * 4;
        var val = vals[jj * ncol + ii];
        if (val == null || !isFinite(val)) { data[o + 3] = 0; continue; }
        var ti = (val - r.min) / span; if (ti < 0) ti = 0; else if (ti > 1) ti = 1;
        var l3 = ((ti * 255) | 0) * 3;
        data[o] = lut[l3]; data[o + 1] = lut[l3 + 1]; data[o + 2] = lut[l3 + 2]; data[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    // Each raster pixel covers an stI×stJ cell block starting at node (i0,j0); its
    // block's top-left world corner is that node minus half a cell.
    var p = w2s(f.origin_x + i0 * sx - sx / 2, f.origin_y + j0 * sy - sy / 2);
    ctx.imageSmoothingEnabled = false;
    ctx.save();
    // Clip to the outline polygon so the field paints only inside the mapped
    // footprint (the "Unclipped raster" QC toggle disables this).
    var clipPath = outlineWorldPath();
    if (S.clipRaster && clipPath) {
      ctx.setTransform(mapView.scale, 0, 0, mapView.scale, mapView.ox, mapView.oy);
      ctx.clip(clipPath);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.translate(p[0], p[1]);
    ctx.scale(mapView.scale * sx * stI, mapView.scale * sy * stJ);
    ctx.drawImage(off, 0, 0, rc, rr);
    ctx.restore();
  }

  // ---- stride-ladder LOD ring selection (view2d lod=) ------------------------
  // A payload may carry a coarse ring beside each full-res field (fills[i].lod,
  // map.grid_lines_lod, contours[i].lines_lod — decoded like the full ring).
  // S.lodActive picks which ring draws; it flips only on ZOOM SETTLE (debounced,
  // 150 ms after the last wheel event), never per frame, so a mid-gesture zoom
  // never flickers between rings. Geometry truth is never decimated — the coarse
  // ring is display-only additive data; a JSON/blockless or LOD-less payload has
  // no coarse ring and always draws full resolution (S.lodActive stays false).
  var LOD_CELL_PX = 4; // full-res data cell below this on-screen size → coarse
  function mapHasLod() {
    var m = App.payload.map; if (!m) return false;
    if ((m.fills || []).some(function (f) { return f.lod; })) return true;
    if (m.grid_lines_lod) return true;
    if ((m.contours || []).some(function (c) { return c.lines_lod; })) return true;
    return false;
  }
  // On-screen size (px) of one full-resolution data cell — the LOD switch signal.
  // Prefer the active fill's node density (√(bbox area / node count)); else the
  // frame lattice spacing. The fill's cell size is cached per fill identity
  // (settle is rare, so the one bbox scan is cheap).
  function fillCellWorld(fill) {
    var N = fill.nodes, n = N.length || 0;
    if (!n) return 0;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var q = 0; q < n; q++) {
      var x = ndX(N, q), y = ndY(N, q);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return Math.sqrt(Math.abs((x1 - x0) * (y1 - y0)) / n) || 0;
  }
  function fullCellPx() {
    var m = App.payload.map;
    var fill = (m.fills || [])[S.mapFillIdx];
    if (fill && fill.lod && fill.nodes && fill.nodes.length) {
      if (fill.__cellWorld == null) fill.__cellWorld = fillCellWorld(fill);
      return fill.__cellWorld * mapView.scale;
    }
    var f = m.frame;
    return Math.min(Math.abs(f.spacing_x), Math.abs(f.spacing_y)) * mapView.scale;
  }
  function computeLodActive() { return mapHasLod() && fullCellPx() < LOD_CELL_PX; }
  // The ring to draw for a fill / a full-vs-lod field pair (the coarse ring
  // inherits the fill's per-object colormap pin so colours stay stable).
  function fillRingFor(fill) {
    if (S.lodActive && fill && fill.lod) {
      if (fill.colormap && !fill.lod.colormap) fill.lod.colormap = fill.colormap;
      return fill.lod;
    }
    return fill;
  }
  function lineSetRing(full, lodField) { return (S.lodActive && lodField) ? lodField : full; }
  // ONE shared zoom/gesture-settle debounce: 150 ms after the last wheel/drag
  // event that couldn't blit, do the deferred settle work — (1) recompute which
  // LOD ring the settled zoom wants, then (2) one non-hot render, which re-BAKES
  // the point cloud and the active fill for the (possibly new) ring. Skipped for
  // a hidden document / background tab (the P3 visibility rule: no work while
  // unseen). Both the LOD switch and the fill/point re-bake ride this one timer.
  var _settleTimer = 0;
  var _settleRafPending = false;
  var _settleRaf = 0;
  function paintSettledMap() {
    _settleRaf = 0;
    if (App.tab !== "map" || (typeof document !== "undefined" && document.hidden)) {
      _settleRafPending = false;
      return;
    }
    if (_mapRafPending) {
      _settleRaf = requestAnimationFrame(paintSettledMap);
      return;
    }
    _settleRafPending = false;
    perfCount("settlePaints");
    renderMap();
  }
  function scheduleSettle() {
    if (_settleTimer) clearTimeout(_settleTimer);
    _settleTimer = setTimeout(function () {
      _settleTimer = 0;
      if (App.tab !== "map") return;
      if (typeof document !== "undefined" && document.hidden) return;
      var want = computeLodActive();
      var lodChanged = want !== S.lodActive;
      S.lodActive = want;
      if (!_settleRafPending) {
        _settleRafPending = true;
        _settleRaf = requestAnimationFrame(paintSettledMap);
      }
      if (lodChanged && typeof buildPanel === "function") buildPanel();
    }, 150);
  }

  // ---- immutable overlay baking -------------------------------------------
  // Grid/contour/outline sit below points; contacts sit above them. Keep two
  // caches so this ordering remains byte-for-byte the same at settle. A hot
  // wheel/drag only transforms these bitmaps; all line/cell path construction
  // occurs in the initial or settled non-hot paint.
  var _displayIds = typeof WeakMap !== "undefined" ? new WeakMap() : null;
  var _displayIdNext = 1;
  function displayId(o) {
    if (!o) return 0;
    if (_displayIds) { var id = _displayIds.get(o); if (!id) { id = _displayIdNext++; _displayIds.set(o, id); } return id; }
    if (!o.__petekDisplayId) o.__petekDisplayId = _displayIdNext++;
    return o.__petekDisplayId;
  }
  var _overlayUnder = { canvas: null, key: "", scale: 0, cox: 0, coy: 0 };
  var _overlayOver = { canvas: null, key: "", scale: 0, cox: 0, coy: 0 };
  function overlayKey(kind) {
    var m = App.payload.map;
    if (kind === "under") return [displayId(lineSetRing(m.grid_lines, m.grid_lines_lod)),
      displayId(m.contours), displayId(m.outline), S.showGridLines, S.showContours,
      S.showOutline, S.lodActive, token("--muted"), token("--text-secondary")].join("|");
    return [displayId(m.contacts), (S.contactVis || []).join(","), S.lodActive,
      document.documentElement.getAttribute("data-theme") || "",
      mapFrame().spacing_x, mapFrame().spacing_y].join("|");
  }
  function paintUnderlays(ctx, sc, ox, oy) {
    var m = App.payload.map;
    var gridLines = lineSetRing(m.grid_lines, m.grid_lines_lod);
    if (S.showGridLines && gridLines) {
      perfCount("gridPathBuilds"); ctx.strokeStyle = token("--muted"); ctx.globalAlpha = 0.32;
      ctx.lineWidth = 1; ctx.beginPath(); strokeLineSet(ctx, gridLines, sc, ox, oy); ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (S.showContours && m.contours && m.contours.length) {
      var strokeContours = function (sets, alpha, width) {
        if (!sets.length) return; perfCount("contourPathBuilds");
        ctx.strokeStyle = token("--text-secondary"); ctx.globalAlpha = alpha; ctx.lineWidth = width; ctx.beginPath();
        sets.forEach(function (c) { strokeLineSet(ctx, lineSetRing(c.lines, c.lines_lod), sc, ox, oy); });
        ctx.stroke(); ctx.globalAlpha = 1;
      };
      strokeContours(m.contours.filter(function (c) { return !c.major; }), 0.6, 1);
      strokeContours(m.contours.filter(function (c) { return c.major; }), 0.85, 2.25);
    }
    var outline = outlineWorldPath();
    if (S.showOutline && outline) {
      ctx.save(); ctx.setTransform(sc, 0, 0, sc, ox, oy); ctx.strokeStyle = token("--text-secondary");
      ctx.lineWidth = 2 / sc; ctx.lineJoin = "round"; ctx.stroke(outline); ctx.restore();
    }
  }
  function paintContacts(ctx, sc, ox, oy) {
    var f = mapFrame();
    (App.payload.map.contacts || []).forEach(function (c, ci) {
      if (!S.contactVis[ci]) return;
      perfCount("contactMaskBuilds");
      var col = idColor("ct:" + c.kind), ss = Math.max(2, sc * Math.min(f.spacing_x, f.spacing_y));
      var region = new Path2D(), minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, any = false;
      for (var j = 0; j < f.nrow; j++) for (var i = 0; i < f.ncol; i++) {
        if (!maskAt(c.crossing, j * f.ncol + i)) continue;
        any = true; var sx = (f.origin_x + i * f.spacing_x) * sc + ox;
        var sy = (f.origin_y + j * f.spacing_y) * sc + oy;
        var x0 = sx - ss / 2, y0 = sy - ss / 2; region.rect(x0, y0, ss, ss);
        if (x0 < minx) minx = x0; if (y0 < miny) miny = y0;
        if (x0 + ss > maxx) maxx = x0 + ss; if (y0 + ss > maxy) maxy = y0 + ss;
      }
      if (!any) return;
      ctx.save(); ctx.globalAlpha = 0.22; ctx.fillStyle = col; ctx.fill(region);
      ctx.save(); ctx.clip(region); ctx.globalAlpha = 0.55; ctx.strokeStyle = col; ctx.lineWidth = 1;
      var back = ci % 2 === 1;
      for (var d = minx - (maxy - miny); d <= maxx; d += 6) {
        ctx.beginPath();
        if (back) { ctx.moveTo(d, maxy); ctx.lineTo(d + (maxy - miny), miny); }
        else { ctx.moveTo(d, miny); ctx.lineTo(d + (maxy - miny), maxy); }
        ctx.stroke();
      }
      ctx.restore(); ctx.globalAlpha = 0.9; ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke(region); ctx.restore();
    });
  }
  function drawOverlayCache(ctx, cv, kind) {
    var C = kind === "under" ? _overlayUnder : _overlayOver, key = overlayKey(kind);
    var exact = C.canvas && C.key === key && C.scale === mapView.scale && C.cox === mapView.ox + cv.width * PT_MARGIN && C.coy === mapView.oy + cv.height * PT_MARGIN;
    if (!exact && !_mapHotFrame) {
      var mx = cv.width * PT_MARGIN, my = cv.height * PT_MARGIN;
      if (!C.canvas) C.canvas = document.createElement("canvas");
      C.canvas.width = Math.ceil(cv.width + 2 * mx); C.canvas.height = Math.ceil(cv.height + 2 * my);
      C.scale = mapView.scale; C.cox = mapView.ox + mx; C.coy = mapView.oy + my; C.key = key;
      var cc = C.canvas.getContext("2d");
      if (kind === "under") paintUnderlays(cc, C.scale, C.cox, C.coy); else paintContacts(cc, C.scale, C.cox, C.coy);
      perfCount("overlayBitmapBuilds"); exact = true;
    }
    if (C.canvas && C.key === key) {
      var k = mapView.scale / C.scale;
      ctx.drawImage(C.canvas, mapView.ox - C.cox * k, mapView.oy - C.coy * k,
        C.canvas.width * k, C.canvas.height * k);
      if (_mapHotFrame) perfCount("overlayHotBlits");
    } else if (_mapHotFrame) scheduleSettle();
  }

  function renderMap() {
    var cv = document.getElementById("map-canvas");
    if (!App.payload.map) { showEmpty("No map bundle in this payload."); return; }
    if (App.payload.map.__blocksPending) { showEmpty("Decoding map…"); return; }
    hideEmpty();
    sizeCanvas(cv);
    if (!mapView.fitted) fitMap(cv);
    var ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = token("--surface-1"); ctx.fillRect(0, 0, cv.width, cv.height);

    var f = mapFrame();
    var layer = S.mapLayers[S.mapLayerIdx];
    if (layer) drawWindowedRaster(ctx, cv, f, layer);

    // value-coloured trimesh fill (2-D QA payloads) — UNDER grid lines /
    // outline / points. One active fill at a time (the panel select).
    var activeFill = (App.payload.map.fills || [])[S.mapFillIdx] || null;
    if (S.showFills && activeFill) drawMapFill(ctx, cv, fillRingFor(activeFill));

    // Cached structural overlays retain their historical position below points.
    drawOverlayCache(ctx, cv, "under");

    // point cloud overlay — batched colour-bin paths + an offscreen bake
    // (see drawMapPoints; a 200k-point cloud must pan/zoom at frame rate)
    if (S.showPoints && App.payload.map.points && App.payload.map.points.length) {
      drawMapPoints(ctx, cv);
    }

    // Cached contact overlays retain their historical position above points.
    drawOverlayCache(ctx, cv, "over");

    // wells (markers + click-to-section). Co-located bores that share a wellhead
    // (sidetracks) collapse to ONE shared marker with a bore-count badge; their
    // labels fan out radially with leader lines so none collide or hide.
    var visWells = [];
    (App.payload.wells || []).forEach(function (well, wi) { if (S.wellVis[wi]) visWells.push({ w: well, s: w2s(well.x, well.y) }); });
    var clusters = [];
    visWells.forEach(function (v) {
      var c = null;
      for (var q = 0; q < clusters.length; q++) { if (Math.hypot(clusters[q].s[0] - v.s[0], clusters[q].s[1] - v.s[1]) <= 10) { c = clusters[q]; break; } }
      if (c) c.items.push(v); else clusters.push({ s: v.s.slice(), items: [v] });
    });
    ctx.font = "11px system-ui";
    clusters.forEach(function (cl) {
      var s = cl.s, shared = cl.items.length > 1;
      if (shared) {
        // radial leader lines + coloured label dots for each bore
        var R = 26;
        cl.items.forEach(function (v, k) {
          var ang = -Math.PI / 2 + (k / cl.items.length) * 2 * Math.PI;
          var lx = s[0] + Math.cos(ang) * R, ly = s[1] + Math.sin(ang) * R;
          var col = idColor("well:" + v.w.id);
          ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(s[0], s[1]); ctx.lineTo(lx, ly); ctx.stroke();
          ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, 6.2832); ctx.fillStyle = col; ctx.fill();
          ctx.strokeStyle = token("--surface-1"); ctx.lineWidth = 1; ctx.stroke();
          var right = Math.cos(ang) >= 0;
          ctx.fillStyle = token("--text-secondary"); ctx.textAlign = right ? "left" : "right";
          ctx.fillText(disp(v.w, v.w.id), lx + (right ? 6 : -6), ly + 3);
          ctx.textAlign = "left"; drawTieGlyph(ctx, lx, ly, v.w);
        });
        ctx.textAlign = "left";
        // shared wellhead marker
        ctx.beginPath(); ctx.arc(s[0], s[1], 6, 0, 6.2832);
        ctx.fillStyle = token("--text-secondary"); ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = token("--surface-1"); ctx.stroke();
        // bore-count badge
        ctx.beginPath(); ctx.arc(s[0] + 7, s[1] - 7, 6.5, 0, 6.2832);
        ctx.fillStyle = token("--accent"); ctx.fill();
        ctx.strokeStyle = token("--surface-1"); ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = "#fff"; ctx.font = "700 9px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(String(cl.items.length), s[0] + 7, s[1] - 7);
        ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.font = "11px system-ui";
      } else {
        var well = cl.items[0].w, col = idColor("well:" + well.id);
        ctx.beginPath(); ctx.arc(s[0], s[1], 5, 0, 2 * Math.PI);
        ctx.fillStyle = col; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = token("--surface-1"); ctx.stroke();
        ctx.fillStyle = token("--text-secondary"); ctx.fillText(disp(well, well.id), s[0] + 8, s[1] + 3);
        drawTieGlyph(ctx, s[0], s[1], well);
      }
    });

    // in-progress fence
    if (S.fence.pts.length) {
      ctx.strokeStyle = token("--accent"); ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      ctx.beginPath();
      S.fence.pts.forEach(function (pt, i) { var s = w2s(pt[0], pt[1]); if (i === 0) ctx.moveTo(s[0], s[1]); else ctx.lineTo(s[0], s[1]); });
      ctx.stroke(); ctx.setLineDash([]);
      S.fence.pts.forEach(function (pt) { var s = w2s(pt[0], pt[1]); ctx.beginPath(); ctx.arc(s[0], s[1], 3, 0, 6.28); ctx.fillStyle = token("--accent"); ctx.fill(); });
    }

    // Per-layer legend entries (type icon + display name; a ramp + clamped
    // range where the layer is value-coloured) are assembled in
    // drawFieldLegend from map.layers / point_color / the active fill.
    if (!_mapHotFrame) drawFieldLegend(layer, S.showFills ? activeFill : null);

    // A small "LOD" chip while the coarse ring is showing (only when the payload
    // actually carries LOD rings) — a quiet cue that display detail is reduced.
    if (S.lodActive && mapHasLod()) {
      ctx.save();
      ctx.font = "600 10px system-ui";
      var lw = ctx.measureText("LOD").width + 12;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = token("--surface-2") || token("--surface-1");
      ctx.fillRect(10, 10, lw, 18);
      ctx.strokeStyle = token("--muted"); ctx.lineWidth = 1; ctx.strokeRect(10, 10, lw, 18);
      ctx.globalAlpha = 1; ctx.fillStyle = token("--text-secondary");
      ctx.textBaseline = "middle"; ctx.fillText("LOD", 16, 20);
      ctx.restore();
    }

    // world→screen transform + LOD state, exposed for the browser test harness
    window.__PETEK_MAP_VIEW = { scale: mapView.scale, ox: mapView.ox, oy: mapView.oy };
    window.__PETEK_LOD_ACTIVE = !!S.lodActive;
  }

  // ---- point cloud: batched colour bins + offscreen bake + rAF coalescing ----
  // The old path did beginPath/arc/fill (and a fresh fillStyle string) PER POINT —
  // ~145 ms/frame at 200k coloured points, re-run synchronously per wheel/drag
  // DOM event. Three fixes, layered:
  //   1. BATCH: points bin into ≤256 colormap bins (+1 accent bin for non-finite
  //      z), one Path2D + one fill() per bin — the drawTriFill idiom. Small radii
  //      draw as squares (rect), which Path2D batches far faster than arcs.
  //   2. BAKE: the cloud is rendered once into a VIEWPORT-WINDOWED offscreen
  //      canvas (viewport + margin, clamped to the cloud bbox and hard pixel
  //      caps — the _raster windowing idiom) and re-blitted (one drawImage)
  //      while the view stays inside the baked window and zoom band. A HOT
  //      frame (wheel/drag) always affine-blits the last valid bitmap, even
  //      outside that band/window; only the shared trailing settle may rebuild
  //      the data-sized paths and backing bitmap. Non-hot renders (tab switch,
  //      toggles, the deferred timer) re-bake synchronously. Past the caps on
  //      a non-hot render, the bounded immediate path remains the fallback.
  //   3. rAF: wheel/drag route through scheduleRenderMap() — state updates per
  //      event, at most ONE repaint per animation frame.
  function pointRadius() { return Math.max(1.5, Math.min(3.5, mapView.scale < 0.05 ? 1.5 : 2.5)); }
  var PT_ACCENT_BIN = 256; // bin index for uncoloured / non-finite-z points
  // Per-layer point-colour plan (the per-object color ruling): points layer
  // entries may carry {start, n, range, colormap, colored} — the JS reads the
  // per-layer fields FIRST, falling back to the global point_color/colormap
  // (older payloads render exactly as before through the one legacy segment).
  function pointLayerPlan() {
    var m = App.payload.map, pc = m.point_color;
    var segs = [];
    (m.layers || []).forEach(function (ly) {
      if (ly.kind === "points" && ly.start != null && ly.n != null) segs.push(ly);
    });
    if (!segs.length) segs.push({ start: 0, n: ptN(m.points) }); // legacy: one segment
    return segs.map(function (ly) {
      var colored = ly.colored !== false;
      var range = colored ? (ly.range || (pc && pc.range) || null) : null;
      return { start: ly.start || 0, n: ly.n, range: range, cmap: ly.colormap || S.colormap };
    });
  }
  // Build the binned Path2D set under an affine transform sx = x*sc + oxx.
  // cull=true skips points outside the [0..cw, 0..ch] rect (immediate mode).
  // q0/q1 bound the point-index slice (a per-layer segment; default: all).
  function buildPointPaths(pts, sc, oxx, oyy, r, pc, cull, cw, ch, q0, q1) {
    perfCount("pointPathBuilds");
    var square = r <= 2.5; // tiny marks: rects batch far faster than arcs
    var paths = new Array(257);
    var colored = !!(pc && pc.range), plo = 0, pf = 0;
    if (colored) { plo = pc.range[0]; pf = 255 / ((pc.range[1] - pc.range[0]) || 1); }
    var d = 2 * r;
    var qa = q0 || 0, qb = q1 == null ? ptN(pts) : q1;
    for (var q = qa; q < qb; q++) {
      var sx = ptX(pts, q) * sc + oxx, sy = ptY(pts, q) * sc + oyy;
      if (cull && (sx < -r || sy < -r || sx > cw + r || sy > ch + r)) continue;
      var bin = PT_ACCENT_BIN;
      if (colored) {
        var z = ptZ(pts, q);
        if (z != null && isFinite(z)) {
          bin = ((z - plo) * pf + 0.5) | 0;
          if (bin < 0) bin = 0; else if (bin > 255) bin = 255;
        }
      }
      var p = paths[bin] || (paths[bin] = new Path2D());
      if (square) p.rect(sx - r, sy - r, d, d);
      else { p.moveTo(sx + r, sy); p.arc(sx, sy, r, 0, 6.2832); }
    }
    return paths;
  }
  // One fillStyle assignment + one fill() per non-empty bin (≤257 calls total).
  function fillPointPaths(ctx, paths, alpha, cmap) {
    var lut = colormapLUT(cmap || S.colormap);
    ctx.globalAlpha = alpha;
    for (var b = 0; b < 256; b++) {
      if (!paths[b]) continue;
      var l3 = b * 3;
      ctx.fillStyle = "rgb(" + lut[l3] + "," + lut[l3 + 1] + "," + lut[l3 + 2] + ")";
      ctx.fill(paths[b]);
    }
    if (paths[PT_ACCENT_BIN]) { ctx.fillStyle = token("--accent"); ctx.fill(paths[PT_ACCENT_BIN]); }
    ctx.globalAlpha = 1;
  }
  // world bbox of the cloud, cached per points-array identity
  var _ptBBox = { ref: null, x0: 0, y0: 0, x1: 0, y1: 0 };
  function pointBBox(pts) {
    if (_ptBBox.ref === pts) return _ptBBox;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var q = 0; q < ptN(pts); q++) {
      var x = ptX(pts, q), y = ptY(pts, q);
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    _ptBBox = { ref: pts, x0: x0, y0: y0, x1: x1, y1: y1 };
    return _ptBBox;
  }
  // Offscreen bake caps: per-axis + total-pixel (bounds the canvas alloc and the
  // blit's GPU upload; a 4096² RGBA canvas is ~64 MB — the area cap keeps the
  // worst case at ~48 MB). The window (≤ (1+2·margin)× the viewport, clamped to
  // the cloud bbox) stays far below the caps at normal viewport sizes.
  var PT_CACHE_MAX_DIM = 4096;
  var PT_CACHE_MAX_PX = 12 * 1024 * 1024;
  var PT_MARGIN = 0.5; // bake-window margin per side, in viewport fractions
  // Zoom band around the baked scale: inside it the bake is blitted scaled (mark
  // size drifts ≤ ~25% momentarily); outside it re-renders/re-bakes.
  var PT_BAND_LO = 0.8, PT_BAND_HI = 1.25;
  var _ptCache = { canvas: null, ref: null, key: "", styleKey: "", scale: 0, cox: 0, coy: 0,
                   wx0: 0, wy0: 0, wx1: 0, wy1: 0 }; // w* = baked window, world coords
  // Trailing re-bake: a hot frame that couldn't blit schedules the shared settle
  // (scheduleSettle), which after the gesture pauses does one non-hot render that
  // bakes the point cloud (and the active fill) synchronously.
  function drawMapPoints(ctx, cv) {
    var pts = App.payload.map.points;
    var r = pointRadius();
    var alpha = pts.length > 20000 ? 0.45 : 0.7;
    var plan = pointLayerPlan(); // per-layer colour segments (global fallback)
    // everything the baked pixels depend on, except geometry/scale/window
    var styleKey = token("--accent") + "|" + alpha + "|" +
      plan.map(function (sg) {
        return sg.cmap + ":" + (sg.range ? sg.range[0] + "," + sg.range[1] : "-");
      }).join(";");
    var key = styleKey + "|" + r;
    var bb = pointBBox(pts), pad = r + 2, padW = pad / mapView.scale;
    // the viewport in world coords, clamped to the (padded) cloud bbox — the
    // part the baked window must cover for a blit to be valid
    var nx0 = Math.max(-mapView.ox / mapView.scale, bb.x0 - padW);
    var ny0 = Math.max(-mapView.oy / mapView.scale, bb.y0 - padW);
    var nx1 = Math.min((cv.width - mapView.ox) / mapView.scale, bb.x1 + padW);
    var ny1 = Math.min((cv.height - mapView.oy) / mapView.scale, bb.y1 + padW);
    var C = _ptCache;
    var k = C.canvas && C.scale > 0 ? mapView.scale / C.scale : 0;
    var sameBitmap = !!C.canvas && C.ref === pts && C.key === key;
    // Radius is derived from scale. Crossing its threshold during a wheel
    // gesture must not make the point cloud disappear: hot frames may reuse a
    // bitmap whose geometry and real paint style still match, then settle at
    // the new radius. Theme/ramp/range/layer changes remain incompatible.
    var hotBitmap = !!C.canvas && C.ref === pts && C.styleKey === styleKey;
    var usable = sameBitmap &&
      k >= PT_BAND_LO && k <= PT_BAND_HI &&
      (nx0 >= nx1 || ny0 >= ny1 || // cloud fully off-screen: any valid bake will do
        (nx0 >= C.wx0 && ny0 >= C.wy0 && nx1 <= C.wx1 && ny1 <= C.wy1));
    if (!usable && !_mapHotFrame) {
      // (re)bake: viewport + margin, clamped to the cloud bbox and the caps
      var mx = cv.width * PT_MARGIN, my = cv.height * PT_MARGIN;
      var wx0 = Math.max((-mx - mapView.ox) / mapView.scale, bb.x0 - padW);
      var wy0 = Math.max((-my - mapView.oy) / mapView.scale, bb.y0 - padW);
      var wx1 = Math.min((cv.width + mx - mapView.ox) / mapView.scale, bb.x1 + padW);
      var wy1 = Math.min((cv.height + my - mapView.oy) / mapView.scale, bb.y1 + padW);
      var w = Math.ceil((wx1 - wx0) * mapView.scale), h = Math.ceil((wy1 - wy0) * mapView.scale);
      if (w > 0 && h > 0 && w <= PT_CACHE_MAX_DIM && h <= PT_CACHE_MAX_DIM && w * h <= PT_CACHE_MAX_PX) {
        if (!C.canvas) C.canvas = document.createElement("canvas");
        C.canvas.width = w; C.canvas.height = h; // also clears prior content
        var cox = -wx0 * mapView.scale, coy = -wy0 * mapView.scale;
        var cctx = C.canvas.getContext("2d");
        plan.forEach(function (sg) {
          fillPointPaths(cctx, buildPointPaths(pts, mapView.scale, cox, coy, r,
            sg.range ? { range: sg.range } : null, true, w, h, sg.start, sg.start + sg.n), alpha, sg.cmap);
        });
        C.ref = pts; C.key = key; C.styleKey = styleKey;
        C.scale = mapView.scale; C.cox = cox; C.coy = coy;
        C.wx0 = wx0; C.wy0 = wy0; C.wx1 = wx1; C.wy1 = wy1;
        usable = true; k = 1;
      }
    }
    // During navigation the last matching bitmap is always transformed, even
    // outside its normal zoom band/window. It may be transiently soft or expose
    // a blank edge after a very long pan, but it preserves continuity and keeps
    // all data-sized path construction on the one settle paint.
    if (usable || (_mapHotFrame && hotBitmap)) {
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(C.canvas, mapView.ox - C.cox * k, mapView.oy - C.coy * k,
        C.canvas.width * k, C.canvas.height * k);
      ctx.restore();
    } else if (_mapHotFrame) {
      // A gesture normally starts from the initial non-hot bake. If it does not,
      // defer rather than reconstructing a data-sized path in a hot frame.
      scheduleSettle();
    } else {
      // Over the bake caps on a non-hot render: bounded immediate fallback.
      plan.forEach(function (sg) {
        fillPointPaths(ctx, buildPointPaths(pts, mapView.scale, mapView.ox, mapView.oy, r,
          sg.range ? { range: sg.range } : null, true, cv.width, cv.height, sg.start, sg.start + sg.n), alpha, sg.cmap);
      });
    }
  }

  // rAF-coalesced map repaints: hot-path callers (wheel / drag) update mapView
  // state per DOM event and schedule; the map draws AT MOST once per animation
  // frame. The per-frame cost + frame count are exposed for the perf harness.
  var _mapRafPending = false;
  var _mapHotFrame = false; // true while a wheel/drag-scheduled frame renders
  function scheduleRenderMap() {
    if (_mapRafPending) return;
    _mapRafPending = true;
    perfCount("rafRequests");
    requestAnimationFrame(function () {
      _mapRafPending = false;
      var t0 = performance.now();
      _mapHotFrame = true;
      try { renderMap(); } finally { _mapHotFrame = false; }
      perfCount("hotPaints");
      window.__PETEK_MAP_FRAME_MS = performance.now() - t0;
      window.__PETEK_MAP_FRAME_COUNT = (window.__PETEK_MAP_FRAME_COUNT || 0) + 1;
    });
  }

  // Grid-bucketed hover hit-test: a coarse uniform world-space grid (built once
  // per points array, ~4 points/bucket) — the cursor queries only the buckets its
  // 8-px pick radius touches, never the whole cloud. Same hit rule as the old
  // O(n) scan: nearest point within 8 screen px.
  var _ptGrid = { ref: null };
  function pointGrid(pts) {
    if (_ptGrid.ref === pts) return _ptGrid;
    var bb = pointBBox(pts);
    var nb = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(ptN(pts) / 4))));
    var fx = nb / ((bb.x1 - bb.x0) || 1), fy = nb / ((bb.y1 - bb.y0) || 1);
    var buckets = new Array(nb * nb);
    for (var q = 0; q < ptN(pts); q++) {
      var ci = ((ptX(pts, q) - bb.x0) * fx) | 0; if (ci < 0) ci = 0; else if (ci >= nb) ci = nb - 1;
      var cj = ((ptY(pts, q) - bb.y0) * fy) | 0; if (cj < 0) cj = 0; else if (cj >= nb) cj = nb - 1;
      var b = cj * nb + ci;
      (buckets[b] || (buckets[b] = [])).push(q);
    }
    _ptGrid = { ref: pts, x0: bb.x0, y0: bb.y0, fx: fx, fy: fy, nb: nb, buckets: buckets };
    return _ptGrid;
  }
  function hitTestPoint(pts, px, py) {
    var g = pointGrid(pts);
    var w = s2w(px, py), rw = 8 / mapView.scale; // 8-px pick radius in world units
    var i0 = ((w[0] - rw - g.x0) * g.fx) | 0, i1 = ((w[0] + rw - g.x0) * g.fx) | 0;
    var j0 = ((w[1] - rw - g.y0) * g.fy) | 0, j1 = ((w[1] + rw - g.y0) * g.fy) | 0;
    if (i1 < 0 || j1 < 0 || i0 >= g.nb || j0 >= g.nb) return null; // off the cloud
    if (i0 < 0) i0 = 0; if (j0 < 0) j0 = 0;
    if (i1 >= g.nb) i1 = g.nb - 1; if (j1 >= g.nb) j1 = g.nb - 1;
    var best = null, bestD = Infinity;
    for (var cj = j0; cj <= j1; cj++) {
      for (var ci = i0; ci <= i1; ci++) {
        var bucket = g.buckets[cj * g.nb + ci];
        if (!bucket) continue;
        for (var q = 0; q < bucket.length; q++) {
          var pi = bucket[q];
          var d = Math.hypot(ptX(pts, pi) * mapView.scale + mapView.ox - px, ptY(pts, pi) * mapView.scale + mapView.oy - py);
          if (d <= 8 && d < bestD) { bestD = d; best = { index: pi, x: ptX(pts, pi), y: ptY(pts, pi), z: ptZ(pts, pi) }; }
        }
      }
    }
    return best;
  }

  // Value-coloured trimesh fill: each triangle flat-fills with the colormap
  // colour of the MEAN of its three node values; a triangle with any missing
  // (null) / non-finite node value is skipped (a hole). Triangles are BATCHED
  // into FILL_BINS quantized colour bins — one Path2D + one fill() per bin —
  // so a ~78k-triangle mesh costs ~64 fill calls, never 78k. Bins reuse the
  // raster's colormap LUT (the same ramp the ScalarLayer rasters use).
  var FILL_BINS = 64;
  // Draw the value-coloured trimesh under an affine (sx = x·sc + oxx). The
  // transform defaults to the live map view; the fill BAKE (drawMapFill) passes
  // an offscreen-window transform so the bitmap can be blitted on pan/zoom.
  function drawTriFill(ctx, fill, sc, oxx, oyy) {
    perfCount("triFillBuilds");
    if (sc == null) { sc = mapView.scale; oxx = mapView.ox; oyy = mapView.oy; }
    var nodes = fill.nodes, tris = fill.triangles, vals = fill.values;
    var nN = nodes ? nodes.length : 0, nT = trN(tris);
    if (!nN || !nT) return;
    var r = fill.range, lo, span;
    if (r && r.length === 2 && isFinite(r[0]) && isFinite(r[1])) { lo = r[0]; span = (r[1] - r[0]) || 1; }
    else { // defensive: derive the domain from the finite values
      lo = Infinity; var hi = -Infinity;
      for (var q = 0; q < (vals ? vals.length : 0); q++) { var v = vlAt(vals, q); if (v == null || !isFinite(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (!isFinite(lo)) return; // nothing finite to colour
      span = (hi - lo) || 1;
    }
    // project every node once (not 3× per triangle) under the given affine
    var sx = new Float64Array(nN), sy = new Float64Array(nN);
    for (var k = 0; k < nN; k++) { sx[k] = ndX(nodes, k) * sc + oxx; sy[k] = ndY(nodes, k) * sc + oyy; }
    var paths = new Array(FILL_BINS);
    for (var t = 0; t < nT; t++) {
      var a = trAt(tris, t, 0), b = trAt(tris, t, 1), c = trAt(tris, t, 2);
      var va = vlAt(vals, a), vb = vlAt(vals, b), vc = vlAt(vals, c);
      if (va == null || vb == null || vc == null || !isFinite(va) || !isFinite(vb) || !isFinite(vc)) continue;
      var ti = ((va + vb + vc) / 3 - lo) / span;
      if (ti < 0) ti = 0; else if (ti > 1) ti = 1;
      var bin = (ti * FILL_BINS) | 0; if (bin >= FILL_BINS) bin = FILL_BINS - 1;
      var p = paths[bin] || (paths[bin] = new Path2D());
      p.moveTo(sx[a], sy[a]); p.lineTo(sx[b], sy[b]); p.lineTo(sx[c], sy[c]); p.closePath();
    }
    // per-fill colormap pin (dict item form) wins over the panel selection
    var lut = colormapLUT(fill.colormap || S.colormap);
    for (var i = 0; i < FILL_BINS; i++) {
      if (!paths[i]) continue;
      var l3 = Math.round(((i + 0.5) / FILL_BINS) * 255) * 3;
      var css = "rgb(" + lut[l3] + "," + lut[l3 + 1] + "," + lut[l3 + 2] + ")";
      ctx.fillStyle = css; ctx.fill(paths[i]);
      // hairline same-colour stroke closes the antialiasing seams between
      // adjacent flat-filled triangles (per bin, not per triangle).
      ctx.strokeStyle = css; ctx.lineWidth = 1; ctx.stroke(paths[i]);
    }
  }

  // ---- fill baking: offscreen bitmap blitted on pan, re-baked on settle -------
  // The active value-fill rasterizes ONCE into an offscreen canvas (viewport +
  // margin, clamped to the fill bbox and the shared bake caps); pan blits the
  // bitmap (one drawImage), an in-band zoom blits it scaled (stale but instant),
  // and every hot out-of-band view keeps affine-blitting the last bitmap until
  // the shared settle re-bakes. A non-hot over-the-caps view may still use the
  // bounded immediate draw. This is the exact
  // baked-blit pattern the point cloud uses (same PT_* caps, band and margin, and
  // the same _mapHotFrame gate), so a 78k-triangle fill never re-triangulates per
  // pan frame. The bake key is (colormap, range) + ring OBJECT identity. Keep an
  // explicit four-entry LRU: enough for A/B at full+LOD while bounding worst-
  // case bitmap memory to four shared-cap canvases. Returning A→B→A reuses A.
  var FILL_CACHE_LIMIT = 4;
  var _fillCaches = [];
  var _fillCacheClock = 0;
  function fillCacheFor(fill, key) {
    for (var i = 0; i < _fillCaches.length; i++) {
      var hit = _fillCaches[i];
      if (hit.ref === fill && hit.key === key) {
        hit.used = ++_fillCacheClock;
        perfCount("fillCacheHits");
        return hit;
      }
    }
    perfCount("fillCacheMisses");
    var entry = { canvas: null, ref: fill, key: key, scale: 0, cox: 0, coy: 0,
                  wx0: 0, wy0: 0, wx1: 0, wy1: 0, used: ++_fillCacheClock };
    _fillCaches.push(entry);
    if (_fillCaches.length > FILL_CACHE_LIMIT) {
      var oldest = 0;
      for (var q = 1; q < _fillCaches.length; q++) {
        if (_fillCaches[q].used < _fillCaches[oldest].used) oldest = q;
      }
      _fillCaches.splice(oldest, 1);
      perfCount("fillCacheEvictions");
    }
    return entry;
  }
  function fillNodesBBox(ring) {
    if (ring.__bbox) return ring.__bbox;
    var N = ring.nodes, n = N ? N.length : 0;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var q = 0; q < n; q++) {
      var x = ndX(N, q), y = ndY(N, q);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return (ring.__bbox = { x0: x0, y0: y0, x1: x1, y1: y1 });
  }
  function drawMapFill(ctx, cv, fill) {
    if (!fill || !fill.nodes || !fill.nodes.length) return;
    var key = (fill.colormap || S.colormap) + "|" + (fill.range ? fill.range[0] + "," + fill.range[1] : "-");
    var bb = fillNodesBBox(fill);
    // the viewport in world coords, clamped to the fill bbox — the region a blit
    // must cover to be valid
    var nx0 = Math.max(-mapView.ox / mapView.scale, bb.x0);
    var ny0 = Math.max(-mapView.oy / mapView.scale, bb.y0);
    var nx1 = Math.min((cv.width - mapView.ox) / mapView.scale, bb.x1);
    var ny1 = Math.min((cv.height - mapView.oy) / mapView.scale, bb.y1);
    var C = fillCacheFor(fill, key);
    var k = C.canvas && C.scale > 0 ? mapView.scale / C.scale : 0;
    var sameBitmap = !!C.canvas;
    var usable = sameBitmap &&
      k >= PT_BAND_LO && k <= PT_BAND_HI &&
      (nx0 >= nx1 || ny0 >= ny1 || // fill fully off-screen: any valid bake will do
        (nx0 >= C.wx0 && ny0 >= C.wy0 && nx1 <= C.wx1 && ny1 <= C.wy1));
    if (!usable && !_mapHotFrame) {
      // (re)bake: viewport + margin, clamped to the fill bbox and the caps
      var mx = cv.width * PT_MARGIN, my = cv.height * PT_MARGIN;
      var wx0 = Math.max((-mx - mapView.ox) / mapView.scale, bb.x0);
      var wy0 = Math.max((-my - mapView.oy) / mapView.scale, bb.y0);
      var wx1 = Math.min((cv.width + mx - mapView.ox) / mapView.scale, bb.x1);
      var wy1 = Math.min((cv.height + my - mapView.oy) / mapView.scale, bb.y1);
      var w = Math.ceil((wx1 - wx0) * mapView.scale), h = Math.ceil((wy1 - wy0) * mapView.scale);
      if (w > 0 && h > 0 && w <= PT_CACHE_MAX_DIM && h <= PT_CACHE_MAX_DIM && w * h <= PT_CACHE_MAX_PX) {
        if (!C.canvas) C.canvas = document.createElement("canvas");
        C.canvas.width = w; C.canvas.height = h; // also clears prior content
        var cox = -wx0 * mapView.scale, coy = -wy0 * mapView.scale;
        drawTriFill(C.canvas.getContext("2d"), fill, mapView.scale, cox, coy);
        C.ref = fill; C.key = key; C.scale = mapView.scale; C.cox = cox; C.coy = coy;
        C.wx0 = wx0; C.wy0 = wy0; C.wx1 = wx1; C.wy1 = wy1;
        usable = true; k = 1;
      }
    }
    // Navigation transforms the last matching bitmap regardless of its normal
    // band/window validity. The settled paint below restores full sharpness.
    if (usable || (_mapHotFrame && sameBitmap)) {
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(C.canvas, mapView.ox - C.cox * k, mapView.oy - C.coy * k,
        C.canvas.width * k, C.canvas.height * k);
      ctx.restore();
    } else if (_mapHotFrame) {
      scheduleSettle();
    } else {
      // Over the bake caps on a non-hot render: bounded immediate fallback.
      drawTriFill(ctx, fill);
    }
    window.__PETEK_FILL_CACHE_STATUS = {
      limit: FILL_CACHE_LIMIT, size: _fillCaches.length, key: key,
      colormap: fill.colormap || S.colormap,
      range: fill.range ? [fill.range[0], fill.range[1]] : null,
      lod: !!S.lodActive,
    };
  }

  // Mean |tie residual| (m) over a well's per-horizon ties (falls back to a
  // supplied scalar tie_residual_m). null when the well carries no ties.
  function meanTieResidual(well) {
    if (well.ties && well.ties.length) {
      var s = 0, n = 0;
      well.ties.forEach(function (t) { if (isFinite(t.residual_m)) { s += Math.abs(t.residual_m); n++; } });
      return n ? s / n : null;
    }
    return (well.tie_residual_m != null && isFinite(well.tie_residual_m)) ? Math.abs(well.tie_residual_m) : null;
  }
  // Bin |mean residual| → a tie-quality tier (3 = good ≤2 m, 2 = fair ≤5 m,
  // 1 = poor). Higher tier = better tie.
  function tieQuality(mean) { return mean == null ? 0 : mean <= 2 ? 3 : mean <= 5 ? 2 : 1; }
  // A small 3-pip tie-quality glyph beside a well marker: filled pips = quality
  // tier. It wears TEXT tokens (never a series identity hue) — it reads the tie,
  // it is not a categorical entity. Nothing drawn when the well carries no ties.
  function drawTieGlyph(ctx, x, y, well) {
    var mean = meanTieResidual(well); if (mean == null) return;
    var q = tieQuality(mean), pw = 3, ph = 8, gap = 2, gx = x - 8, gy = y + 9;
    for (var k = 0; k < 3; k++) {
      var filled = k < q;
      ctx.fillStyle = filled ? token("--text-secondary") : "transparent";
      ctx.strokeStyle = token("--muted"); ctx.lineWidth = 1;
      var bx = gx + k * (pw + gap);
      ctx.beginPath(); ctx.rect(bx, gy, pw, ph);
      if (filled) ctx.fill(); ctx.stroke();
    }
  }

  // Visibility-driven rendering: this viewer renders ON DEMAND — only the active
  // tab's render fn runs (renderActive), scene3d/volume repaint on control-change,
  // and the map coalesces interaction repaints through rAF; there is NO persistent
  // animation loop to burn a hidden tab. The one thing that CAN fire while hidden
  // is the settle setTimeout, so a hidden document cancels it (browsers already
  // suspend rAF for a hidden document). Wired once (single map canvas per page —
  // there is no multi-view/embedded-canvas machinery, so no IntersectionObserver
  // is needed here).
  function wireVisibilityPause() {
    if (typeof document === "undefined" || window.__PETEK_VIS_WIRED) return;
    window.__PETEK_VIS_WIRED = true;
    document.addEventListener("visibilitychange", function () {
      if (document.hidden && _settleTimer) { clearTimeout(_settleTimer); _settleTimer = 0; }
      if (document.hidden && _settleRaf) {
        cancelAnimationFrame(_settleRaf); _settleRaf = 0; _settleRafPending = false;
      }
    });
  }
  function mapPanZoomHover(cv) {
    wireVisibilityPause();
    var dragging = false, last = null;
    cv.onwheel = function (ev) {
      ev.preventDefault();
      var rect = cv.getBoundingClientRect();
      var mx = (ev.clientX - rect.left) * (cv.width / rect.width);
      var my = (ev.clientY - rect.top) * (cv.height / rect.height);
      var w = s2w(mx, my);
      var k = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
      mapView.scale *= k;
      mapView.ox = mx - w[0] * mapView.scale;
      mapView.oy = my - w[1] * mapView.scale;
      scheduleRenderMap();
      scheduleSettle(); // flip the LOD ring + re-bake once the zoom settles
    };
    cv.onmousedown = function (ev) {
      if (S.fence.drawing) { addFencePoint(cv, ev); return; }
      dragging = true; last = [ev.clientX, ev.clientY];
      _mapDownPx = [ev.clientX, ev.clientY];
    };
    window.addEventListener("mouseup", function () { dragging = false; });
    cv.onmousemove = function (ev) {
      // Hover shows NOTHING (click-to-inspect ruling) — mousemove only pans.
      if (!dragging) return;
      mapView.ox += (ev.clientX - last[0]) * (cv.width / cv.getBoundingClientRect().width);
      mapView.oy += (ev.clientY - last[1]) * (cv.height / cv.getBoundingClientRect().height);
      last = [ev.clientX, ev.clientY]; scheduleRenderMap(); scheduleSettle();
    };
    cv.ondblclick = function () { if (S.fence.drawing) finishFence(); };
    cv.onclick = function (ev) {
      if (S.fence.drawing) return;
      // click-vs-drag: only a press that stayed within the slop is an inspect
      if (_mapDownPx && Math.hypot(ev.clientX - _mapDownPx[0], ev.clientY - _mapDownPx[1]) > CLICK_SLOP_PX) return;
      mapClickInspect(cv, ev);
    };
  }
  function canvasPx(cv, ev) {
    var rect = cv.getBoundingClientRect();
    return [(ev.clientX - rect.left) * (cv.width / rect.width), (ev.clientY - rect.top) * (cv.height / rect.height)];
  }
  // Click-to-inspect (owner ruling): hover shows NOTHING on the map; a CLICK on
  // or near an object reveals the readout anchored at the clicked location and
  // it stays until dismissed. Precedence: a well marker keeps its existing click
  // semantics (section along the bore); then a point (the grid-bucket hit-test);
  // then a raster-layer cell. Clicking empty space — or the same target again —
  // dismisses the readout. Pan/zoom are untouched (a press that moved more than
  // CLICK_SLOP_PX between down and up is a pan, never an inspect).
  var CLICK_SLOP_PX = 4;
  var _mapDownPx = null;   // mousedown client coords (click-vs-drag gate)
  var _inspectKey = null;  // the shown readout's target (same-target dismiss)
  function pointsLayerNameAt(index) {
    // the emitting layer's duck-typed dataset name for a point index (layers
    // may carry per-layer start/n slices; fall back to the first points layer)
    var layers = App.payload.map.layers || [];
    var first = null;
    for (var q = 0; q < layers.length; q++) {
      var ly = layers[q];
      if (ly.kind !== "points") continue;
      if (first == null) first = ly;
      if (ly.start != null && ly.n != null && index >= ly.start && index < ly.start + ly.n) return ly.name;
    }
    return first ? first.name : null;
  }
  function mapClickInspect(cv, ev) {
    var px = canvasPx(cv, ev);
    // a well marker keeps its click semantics: section along the bore
    var hitW = null;
    (App.payload.wells || []).forEach(function (well, wi) {
      if (!S.wellVis[wi]) return;
      var s = w2s(well.x, well.y);
      if (Math.hypot(s[0] - px[0], s[1] - px[1]) <= 12) hitW = well;
    });
    if (hitW) { hideReadout(); _inspectKey = null; sectionForWell(hitW); return; }
    var rows = null, key = null;
    if (S.showPoints && App.payload.map.points && App.payload.map.points.length) {
      var hitP = hitTestPoint(App.payload.map.points, px[0], px[1]);
      if (hitP) {
        key = "pt:" + hitP.index;
        var nm = pointsLayerNameAt(hitP.index);
        rows = [["", (nm ? pretty(nm) : "point") + " · " + hitP.index],
                ["x", fmt(hitP.x, "m")], ["y", fmt(hitP.y, "m")]];
        if (hitP.z != null && isFinite(hitP.z)) rows.push(["z", fmt(hitP.z, "m")]);
      }
    }
    if (!rows) {
      var f = mapFrame(), layer = S.mapLayers[S.mapLayerIdx];
      var w = s2w(px[0], px[1]);
      var i = Math.round((w[0] - f.origin_x) / f.spacing_x);
      var j = Math.round((w[1] - f.origin_y) / f.spacing_y);
      if (layer && i >= 0 && j >= 0 && i < f.ncol && j < f.nrow) {
        key = "cell:" + i + "," + j;
        rows = [
          ["", layer.display],
          ["value", fmt(layer.values[j * f.ncol + i], layer.units)],
          ["cell", "i " + i + " · j " + j],
        ];
      }
    }
    if (!rows) { hideReadout(); _inspectKey = null; return; } // empty space dismisses
    var readout = document.getElementById("readout");
    if (!readout.hidden && key === _inspectKey) { hideReadout(); _inspectKey = null; return; } // same spot again
    _inspectKey = key;
    showReadout(ev, rows);
  }

  // fence drawing
  function addFencePoint(cv, ev) { var px = canvasPx(cv, ev); S.fence.pts.push(s2w(px[0], px[1])); renderMap(); }
  function finishFence() {
    var pts = S.fence.pts.slice();
    S.fence.drawing = false; S.fence.pts = [];
    if (pts.length < 2) { renderMap(); buildPanel(); return; }
    requestSection({ line: pts }, "Fence");
    buildPanel();
  }
