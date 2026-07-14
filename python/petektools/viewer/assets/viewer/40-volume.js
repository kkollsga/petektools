  // ================================================================== VOLUME
  var three = null; // { renderer, scene, camera, controls, mesh, geo }
  var vol3 = null;  // decoded v3 shell: { pos, col, triCell, cellValues, zoneIds, ... }
  var _volumeDecodeRequestId = 0, _volumeRecolorRequestId = 0;
  // Render budget: a shell past this many triangles AUTO-DEGRADES to a decimated
  // preview (1-in-stride triangles) — never a refusal, never an OOM. Overridable
  // via window.PETEK_TRI_BUDGET (the Playwright harness lowers it to exercise the
  // degradation path on a small fixture).
  var TRI_BUDGET_DEFAULT = 5000000;
  // Hard memory cap: the most inline mesh bytes we will read into typed arrays.
  // Past this there is nothing to degrade to (the bytes can't even be held), so we
  // refuse-and-say-so. Sidecar mode (raw model.bin) is the escape hatch.
  var INLINE_BYTES_LIMIT = 700 * 1024 * 1024;
  function triBudget() {
    var o = (typeof window !== "undefined" && window.PETEK_TRI_BUDGET) | 0;
    return o > 0 ? o : TRI_BUDGET_DEFAULT;
  }
  // Decode watchdog: if the worker neither reports back nor errors within this
  // long, the volume tab surfaces a visible failure instead of an endless
  // "Decoding mesh…" spinner (an upstream/worker fault must never hang the UI).
  // Overridable via window.PETEK_DECODE_WATCHDOG_MS (the test harness lowers it).
  var DECODE_WATCHDOG_MS_DEFAULT = 30000;
  function decodeWatchdogMs() {
    var o = (typeof window !== "undefined" && window.PETEK_DECODE_WATCHDOG_MS) | 0;
    return o > 0 ? o : DECODE_WATCHDOG_MS_DEFAULT;
  }
  // The declared cell count of a volume envelope (for the diagnostics message).
  function declaredCellCount(v) {
    if (v && v.cell_count != null) return v.cell_count;
    if (v && v.summary && v.summary.cells != null) return v.summary.cells;
    return (v && v.shell_cell_count) || 0;
  }
  // Expose the volume decode outcome for the test harness (like
  // __PETEK_SECTION_FRAME): { state: "ok"|"empty"|"stalled"|"error", ... }.
  function setVolumeStatus(state, info) {
    if (typeof window !== "undefined") {
      window.__PETEK_VOLUME_STATUS = Object.assign({ state: state }, info || {});
    }
  }

  // A VolumeBundle is v3 (exterior shell + binary blocks) when it carries a
  // `blocks` manifest / an `encoding` / schema_version >= 3; else it is the
  // legacy v2 corner-point soup (JSON arrays) and renders through the fallback.
  function isVolumeV3(v) {
    return !!(v && (v.blocks || v.encoding === "base64" || v.encoding === "sidecar" || v.schema_version >= 3));
  }

  function renderVolume() {
    var host = document.getElementById("volume-host");
    var v = App.payload.volume;
    if (!v || !window.THREE) { showEmpty("No volume bundle / WebGL unavailable."); return; }
    hideEmpty();
    if (!three) initThree(host);
    resizeThree(host);
    if (isVolumeV3(v)) { renderVolumeV3(host, v); return; }
    rebuildVolumeGeometry();
    drawVolumeLegend();
    if (three.badge) three.badge.textContent = "z ×" + S.volExag;
    three.render();
  }
  function initThree(host) {
    var THREE = window.THREE;
    var renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    host.appendChild(renderer.domElement);
    // z-exaggeration badge (bottom-left corner of the volume view)
    var badge = document.createElement("div");
    badge.style.cssText = "position:absolute;right:12px;bottom:12px;padding:2px 7px;border-radius:4px;font:600 11px system-ui;pointer-events:none;background:var(--surface-2);color:var(--text-secondary);border:1px solid var(--border)";
    host.appendChild(badge);
    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1e9);
    var controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.addEventListener("change", function () { renderer.render(scene, camera); });
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    var dir = new THREE.DirectionalLight(0xffffff, 0.7); dir.position.set(1, 1, 2); scene.add(dir);
    var geo = new THREE.BufferGeometry();
    var mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    var mesh = new THREE.Mesh(geo, mat); scene.add(mesh);
    three = { THREE: THREE, renderer: renderer, scene: scene, camera: camera, controls: controls, mesh: mesh, geo: geo, mat: mat, badge: badge, framed: false };
    three.render = function () { renderer.render(scene, camera); };
    // hover pick
    renderer.domElement.addEventListener("mousemove", volumeHover);
    renderer.domElement.addEventListener("mouseleave", hideReadout);
  }
  function resizeThree(host) {
    var w = host.clientWidth || 1, h = host.clientHeight || 1;
    three.renderer.setSize(w, h, false);
    three.camera.aspect = w / h; three.camera.updateProjectionMatrix();
  }
  function cellIjk(c) { var ni = S.dims.ni, nj = S.dims.nj; var i = c % ni; var r = (c - i) / ni; var j = r % nj; var k = (r - j) / nj; return [i, j, k]; }
  function cellVisible(c, v) {
    if (!v.active[c]) return false;
    if (v.cell_values[c] < S.threshold) return false;
    if (!S.zoneVis[v.zone_ids[c]]) return false;
    var ijk = cellIjk(c);
    if (ijk[0] < S.clip.i[0] || ijk[0] > S.clip.i[1]) return false;
    if (ijk[1] < S.clip.j[0] || ijk[1] > S.clip.j[1]) return false;
    if (ijk[2] < S.clip.k[0] || ijk[2] > S.clip.k[1]) return false;
    return true;
  }
  function rebuildVolumeGeometry() {
    var THREE = three.THREE, v = App.payload.volume;
    // Recentre + z-down: three is y-up; use (x, -z, y) so depth goes down-screen,
    // and colour per vertex by the property via the colormap.
    var nVerts = v.cell_count * 8;
    // Rebuild vertex positions when the mesh first loads OR the z-exaggeration
    // changes. Exaggeration is a RENDER-SPACE scale on the depth (y) axis only —
    // the source depths (and every reported readout) stay true.
    if (!three.positions || three._exag !== S.volExag) {
      three.positions = three.positions || new Float32Array(nVerts * 3);
      var e = meanCenter(v);
      var zlo = Infinity, zhi = -Infinity;
      for (var q = 0; q < nVerts; q++) {
        var depth = v.positions[q * 3 + 2];
        if (depth < zlo) zlo = depth; if (depth > zhi) zhi = depth;
        three.positions[q * 3] = v.positions[q * 3] - e.cx;
        three.positions[q * 3 + 1] = -(depth - e.cz) * S.volExag;
        three.positions[q * 3 + 2] = v.positions[q * 3 + 1] - e.cy;
      }
      three._extent = e;
      three._depthRange = { min: zlo, max: zhi };
      three._exag = S.volExag;
      three.framed = false; // the vertical extent changed → reframe the camera
    }
    // per-vertex colours (re-read each render → theme/colormap responsive)
    var colors = new Float32Array(nVerts * 3);
    var r = v.value_range, span = (r.max - r.min) || 1;
    for (var q2 = 0; q2 < nVerts; q2++) {
      var cc = rampColor(S.colormap, (v.vertex_values[q2] - r.min) / span, S.colormapReversed) || [128, 128, 128];
      colors[q2 * 3] = cc[0] / 255; colors[q2 * 3 + 1] = cc[1] / 255; colors[q2 * 3 + 2] = cc[2] / 255;
    }
    // index buffer: only visible cells (threshold / zone / clip)
    var idx = [];
    for (var c = 0; c < v.cell_count; c++) {
      if (!cellVisible(c, v)) continue;
      var base = c * 8 * 3; // into v.indices? no — indices are into vertex list
      // v.indices are 36 per cell into positions; positions are cell-major 8/cell
      var o = c * 36;
      for (var t = 0; t < 36; t++) idx.push(v.indices[o + t]);
    }
    three.geo.setAttribute("position", new THREE.BufferAttribute(three.positions, 3));
    three.geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    three.geo.setIndex(idx);
    three.geo.computeVertexNormals();
    three.geo.computeBoundingSphere();
    if (!three.framed) { frameVolume(); three.framed = true; }
    three.render();
  }
  function meanCenter(v) {
    var cx = 0, cy = 0, cz = 0, n = v.positions.length / 3;
    for (var q = 0; q < n; q++) { cx += v.positions[q * 3]; cy += v.positions[q * 3 + 1]; cz += v.positions[q * 3 + 2]; }
    return { cx: cx / n, cy: cy / n, cz: cz / n };
  }
  function frameVolume() {
    three.geo.computeBoundingSphere();
    var s = three.geo.boundingSphere; if (!s) return;
    var rad = s.radius || 1;
    three.controls.target.copy(s.center);
    three.camera.position.set(s.center.x + rad * 1.6, s.center.y + rad * 1.2, s.center.z + rad * 1.8);
    three.camera.near = rad / 100; three.camera.far = rad * 100; three.camera.updateProjectionMatrix();
    three.controls.update();
  }
  function volumeHover(ev) {
    // lightweight: report the property range hint (full per-cell pick is costly);
    // hover readout stays available per design without a heavy raycast.
    var v = App.payload.volume;
    var rows = [["", v.property], ["range", fmt(v.value_range.min) + " – " + fmt(v.value_range.max)], ["threshold", fmt(S.threshold)]];
    // TRUE (un-exaggerated) depth extent of the mesh — the exaggeration is display-only.
    if (three && three._depthRange) rows.push(["depth", fmt(three._depthRange.min) + " – " + fmt(three._depthRange.max) + " m (z ×" + S.volExag + ")"]);
    showReadout(ev, rows);
  }

  // ---- v3 exterior-shell volume (binary blocks, worker-decoded) --------------
  // Decode happens OFF the UI thread (inline Web Worker built from PETEK_DECODE);
  // the shell renders as a NON-indexed BufferGeometry (deduped verts re-expanded
  // per-triangle) so each face flat-shades in its own tri_cell colour. Threshold
  // / zone filtering rebuilds a visible-triangle index (cheap, O(T)); colormap
  // switches re-bake colour in the worker; z-exaggeration is a mesh.scale.y.
  var _worker = null, _workerTried = false;
  function ensureWorker() {
    if (_workerTried) return _worker;
    _workerTried = true;
    try {
      if (typeof Worker === "undefined" || typeof URL === "undefined" || !URL.createObjectURL || !window.PETEK_DECODE) return (_worker = null);
      var url = URL.createObjectURL(new Blob([window.PETEK_DECODE.workerSource()], { type: "text/javascript" }));
      _worker = new Worker(url);
      _worker.onmessage = function (e) {
        if (e.data.cmd === "decoded") onV3Decoded(e.data);
        else if (e.data.cmd === "recolored") applyRecolor(e.data.col, e.data.requestId, e.data.paintKey);
        else if (e.data.cmd === "decoded2d") onMap2dDecoded(e.data); // 2-D map blocks
        else if (e.data.cmd === "regularSurfaceBuilt") onRegularSurfaceBuilt(e.data);
      };
      _worker.onerror = function () {
        _worker = null; // future decodes fall back to the sync path
        // Surface an in-flight decode's failure instead of leaving a live spinner.
        if (vol3 && vol3._decoding) {
          clearDecodeWatchdog();
          var v = vol3._for; vol3 = null; hideEmpty();
          setVolumeStatus("error", { reason: "worker" });
          showBanner("Mesh decode failed",
            "The decode worker crashed before returning a result (" + declaredCellCount(v).toLocaleString() + " cells).",
            "Likely a malformed volume payload or a producer bug. Re-export the volume.");
        }
      };
      return _worker;
    } catch (e) { return (_worker = null); }
  }

  function envTriangleCount(v) {
    if (v.triangle_count != null) return v.triangle_count;
    var b = v.blocks && v.blocks.indices;
    return b && b.shape ? b.shape[0] : 0;
  }
  // Bytes a self-contained payload's blocks occupy (base64 ≈ ×3/4; sidecar = length).
  function estimateBlockBytes(v) {
    var B = v.blocks || {}, total = 0;
    Object.keys(B).forEach(function (k) {
      var b = B[k];
      if (b.data != null) total += Math.floor(b.data.length * 0.75);
      else if (b.length != null) total += b.length;
    });
    return total;
  }
  function hideVolumeMesh() {
    if (three && three.geo) { three.geo.setIndex(new three.THREE.BufferAttribute(new Uint32Array(0), 1)); three.render(); }
  }

  // A LOUD, dismissible degradation notice (not a failure — a "say-so"). Kept
  // visible for as long as the preview is decimated.
  function showDegradeBanner(d) {
    showBanner("Decimated preview",
      d.full.toLocaleString() + " triangles exceeds the " + d.budget.toLocaleString()
      + "-triangle render budget — showing 1 in " + d.stride + " (" + d.kept.toLocaleString() + " tris).",
      "Raise the threshold or narrow zones to shed cells, or re-export a coarser LOD / k-slab for the full-resolution shell.");
  }
  function updateVolBadge() {
    if (!three || !three.badge) return;
    var tris = vol3 ? vol3.triangleCount : 0;
    three.badge.textContent = "z ×" + S.volExag + "  ·  " + tris.toLocaleString() + " tris"
      + (vol3 && vol3._degraded ? "  ·  1:" + vol3._degraded.stride : "");
  }

  function renderVolumeV3(host, v) {
    // Render budget, read from the envelope BEFORE any decode. AUTO-DEGRADE: a
    // shell past the budget decimates to a 1-in-stride preview (bounded render
    // buffer + heap) instead of refusing — the viewer never crashes or blanks.
    var T = envTriangleCount(v), budget = triBudget();
    var stride = T > budget ? Math.ceil(T / budget) : 1;

    // Already decoded for THIS payload — just re-render (recolour on a colormap
    // flip). If the budget dropped since decode (harness lowers it live) and the
    // mesh now needs a coarser stride, fall through to a re-decode.
    if (vol3 && vol3._for === v && !vol3._decoding && (vol3._stride || 1) >= stride) {
      var cmapKey = S.colormap + "|" + !!S.colormapReversed;
      if (vol3._colormapKey !== cmapKey && vol3._pendingPaintKey !== cmapKey) recolorVolumeV3();
      drawVolumeLegend();
      updateVolBadge();
      if (vol3._degraded) showDegradeBanner(vol3._degraded); else hideBanner();
      three.render();
      return;
    }
    if (vol3 && vol3._for === v && vol3._decoding) return; // in flight
    // Hard memory cap — even decimation must first READ the input blocks; beyond
    // this there is nothing to degrade to, so refuse-and-say-so (never OOM).
    var est = estimateBlockBytes(v);
    if (est > INLINE_BYTES_LIMIT) {
      hideVolumeMesh();
      showBanner("Payload too large to decode",
        (est / 1048576).toFixed(0) + " MB of inline mesh blocks exceeds the " + (INLINE_BYTES_LIMIT / 1048576).toFixed(0) + " MB memory cap.",
        "Serve it in sidecar mode (raw model.bin, no base64 tax) instead of one self-contained file, or re-export a smaller model / k-slab.");
      return;
    }
    hideBanner();
    showEmpty(stride > 1 ? "Decoding mesh (decimated preview)…" : "Decoding mesh…");
    decodeVolumeV3(v, stride);
  }

  // Watchdog: a decode that neither completes nor errors within the budget
  // surfaces a visible failure (never an endless spinner). Armed at decode
  // kick-off; cleared on completion / error.
  var _decodeWatchdog = null;
  function clearDecodeWatchdog() {
    if (_decodeWatchdog != null) { clearTimeout(_decodeWatchdog); _decodeWatchdog = null; }
  }
  function startDecodeWatchdog(v) {
    clearDecodeWatchdog();
    var ms = decodeWatchdogMs();
    var t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    _decodeWatchdog = setTimeout(function () {
      _decodeWatchdog = null;
      if (!(vol3 && vol3._for === v && vol3._decoding)) return;   // finished / superseded
      var elapsed = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0);
      var cells = declaredCellCount(v), declaredTris = envTriangleCount(v);
      vol3 = null; hideVolumeMesh();
      setVolumeStatus("stalled", { cells: cells, declaredTriangles: declaredTris, elapsedMs: elapsed, watchdogMs: ms });
      showEmpty("Mesh decode timed out after " + elapsed + " ms — the decoder never finished.");
      showBanner("Mesh decode stalled",
        "No decode result after " + elapsed + " ms (" + cells.toLocaleString() + " cells, "
          + declaredTris.toLocaleString() + " triangles declared).",
        "The decode worker did not report back — likely a malformed volume payload or a producer bug. Re-export the volume; if it persists, file it against the mesh engine.");
    }, ms);
  }

  function decodeVolumeV3(v, stride) {
    stride = stride && stride > 1 ? stride : 1;
    var requestId = ++_volumeDecodeRequestId;
    var paintKey = S.colormap + "|" + !!S.colormapReversed;
    vol3 = { _for: v, _decoding: true, _stride: stride, _requestId: requestId, _paintKey: paintKey };
    startDecodeWatchdog(v);
    // Test seam: force a stalled decode (never post / never sync) so ONLY the
    // watchdog can rescue the UI — proves the no-hang guarantee deterministically.
    if (typeof window !== "undefined" && window.PETEK_FORCE_DECODE_STALL) return;
    var stops = colormapStops(S.colormap, S.colormapReversed);
    var r = v.value_range || { min: 0, max: 1 };
    var msg = { cmd: "decode", requestId: requestId, paintKey: paintKey,
      env: v, vmin: r.min, vmax: r.max, stops: stops, stride: stride };
    var kick = function (bin) {
      if (bin) msg.bin = bin;
      var w = ensureWorker();
      if (w) w.postMessage(msg, bin ? [bin] : []);
      else decodeVolumeV3Sync(v, r, stops, bin, stride, requestId, paintKey);
    };
    if (v.encoding === "sidecar") {
      fetch("./model.bin")
        .then(function (rr) { if (!rr.ok) throw new Error("HTTP " + rr.status); return rr.arrayBuffer(); })
        .then(kick)
        .catch(function (e) { clearDecodeWatchdog(); vol3 = null; hideEmpty(); setVolumeStatus("error", { reason: "model.bin" }); showBanner("Could not load model.bin", String((e && e.message) || e), "Sidecar mode needs the companion binary served next to model.json."); });
    } else {
      kick(null);
    }
  }
  function decodeVolumeV3Sync(v, r, stops, bin, stride, requestId, paintKey) {
    try {
      var res = window.PETEK_DECODE.decodeSync(v, bin ? new Uint8Array(bin) : null, r.min, r.max, stops, stride);
      res._for = v; res.requestId = requestId; res.paintKey = paintKey; onV3Decoded(res);
    } catch (e) {
      clearDecodeWatchdog();
      vol3 = null; hideEmpty();
      setVolumeStatus("error", { reason: "decode" });
      showBanner("Mesh decode failed", String((e && e.message) || e), "The binary blocks did not match the v3 wire contract.");
    }
  }
  // Normalise a worker `decoded` message OR a decodeSync result into vol3.
  function onV3Decoded(res) {
    var pending = vol3;
    if (!pending || !pending._decoding) return;
    var completion = paintCompletionState(res.requestId, pending._requestId, res.paintKey,
      S.colormap + "|" + !!S.colormapReversed);
    if (completion === "stale-request") return;
    res._for = pending._for;
    if (completion === "stale-paint") {
      var staleFor = pending._for, staleStride = pending._stride;
      clearDecodeWatchdog(); vol3 = null; decodeVolumeV3(staleFor, staleStride); return;
    }
    clearDecodeWatchdog();
    // EMPTY MESH: the decode succeeded but produced zero triangles (an upstream
    // producer bug — cells declared, no geometry emitted). Refuse LOUDLY in-tab
    // instead of hiding the spinner onto a silent blank canvas.
    if ((res.triangleCount || 0) === 0) {
      var v = res._for || (App.payload && App.payload.volume);
      var cells = declaredCellCount(v);
      vol3 = null; hideVolumeMesh();
      setVolumeStatus("empty", { cells: cells, triangles: 0 });
      showEmpty("Mesh is empty — " + cells.toLocaleString()
        + " cells declared, 0 triangles; this is a producer bug.");
      showBanner("Empty mesh",
        cells.toLocaleString() + " cells declared but the decoded shell has 0 triangles — nothing to render.",
        "This is an upstream producer bug (the mesh engine emitted a geometry-free volume). Re-cut the volume; the viewer cannot show an empty shell.");
      updateVolBadge();
      return;
    }
    var toF32 = function (x) { return x instanceof Float32Array ? x : new Float32Array(x); };
    var toU32 = function (x) { return x instanceof Uint32Array ? x : new Uint32Array(x); };
    var toU16 = function (x) { return x instanceof Uint16Array ? x : new Uint16Array(x); };
    var stride = res.stride && res.stride > 1 ? res.stride : 1;
    var full = res.fullTriangleCount != null ? res.fullTriangleCount : res.triangleCount;
    vol3 = {
      _for: res._for || App.payload.volume, _decoding: false,
      _colormapKey: res.paintKey,
      _stride: stride,
      _degraded: stride > 1 ? { stride: stride, full: full, kept: res.triangleCount, budget: triBudget() } : null,
      pos: toF32(res.pos), col: toF32(res.col), triCell: toU32(res.triCell),
      cellValues: toF32(res.cellValues), zoneIds: toU16(res.zoneIds),
      center: res.center, depthRange: res.depthRange,
      vertexCount: res.vertexCount, triangleCount: res.triangleCount,
      shellCellCount: res.shellCellCount, decodeMs: res.decodeMs,
    };
    buildVolumeV3Geometry();
  }

  function buildVolumeV3Geometry() {
    hideEmpty();
    var THREE = three.THREE, g = three.geo;
    g.setAttribute("position", new THREE.BufferAttribute(vol3.pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(vol3.col, 3));
    g.setIndex(null);
    g.computeVertexNormals();                 // flat per-tri normals (verts unshared)
    three.mat.flatShading = true; three.mat.needsUpdate = true;
    applyVolumeV3Filter();                     // visible-triangle index (threshold / zones)
    three.mesh.scale.set(1, S.volExag, 1);
    three._depthRange = vol3.depthRange;
    frameVolumeV3();
    drawVolumeLegend();
    updateVolBadge();
    setVolumeStatus("ok", { triangles: vol3.triangleCount, cells: vol3.shellCellCount });
    if (vol3._degraded) showDegradeBanner(vol3._degraded); else hideBanner();
    three.render();
  }

  // Rebuild the visible-triangle index from the threshold + zone toggles. Verts
  // are expanded per-triangle, so triangle t owns verts [3t, 3t+1, 3t+2]; all
  // visible -> drop the index (render straight through).
  function applyVolumeV3Filter() {
    if (!vol3) return;
    var THREE = three.THREE, T = vol3.triangleCount;
    var tc = vol3.triCell, cv = vol3.cellValues, zi = vol3.zoneIds;
    var thr = S.threshold, zv = S.zoneVis || [];
    var idx = new Uint32Array(T * 3), n = 0;
    for (var t = 0; t < T; t++) {
      var cell = tc[t], val = cv[cell];
      if (val < thr) continue;               // NaN < thr is false -> undefined cells stay
      if (zv.length && !zv[zi[cell]]) continue;
      var b = t * 3; idx[n++] = b; idx[n++] = b + 1; idx[n++] = b + 2;
    }
    if (n === T * 3) three.geo.setIndex(null);
    else three.geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, n), 1));
    three.geo.computeBoundingSphere();
  }

  function recolorVolumeV3() {
    if (!vol3 || vol3._decoding) return;
    var requestId = ++_volumeRecolorRequestId;
    var paintKey = S.colormap + "|" + !!S.colormapReversed;
    vol3._pendingPaintKey = paintKey; vol3._recolorRequestId = requestId;
    var stops = colormapStops(S.colormap, S.colormapReversed);
    var v = App.payload.volume, r = v.value_range || { min: 0, max: 1 };
    if (_worker) _worker.postMessage({ cmd: "recolor", requestId: requestId, paintKey: paintKey,
      vmin: r.min, vmax: r.max, stops: stops });
    else {
      var colors = window.PETEK_DECODE.bakeColors(vol3.triCell, vol3.cellValues, r.min, r.max, stops);
      applyRecolor(colors.buffer, requestId, paintKey);
    }
  }
  function applyRecolor(buf, requestId, paintKey) {
    if (!vol3 || paintCompletionState(requestId, vol3._recolorRequestId, paintKey,
      S.colormap + "|" + !!S.colormapReversed) !== "accept") return;
    vol3.col = new Float32Array(buf);
    vol3._colormapKey = paintKey; vol3._pendingPaintKey = null;
    three.geo.setAttribute("color", new three.THREE.BufferAttribute(vol3.col, 3));
    three.geo.attributes.color.needsUpdate = true;
    three.render();
  }

  // The aspect-derived "fit" suggestion (NOT the default — the default is 5×).
  // A thin, wide reservoir (~km × ~m) reads with relief instead of a pancake.
  function suggestV3Exag() {
    if (!vol3) return 5;
    var dz = (vol3.depthRange.max - vol3.depthRange.min) || 1, xy;
    var f = App.payload.map ? App.payload.map.frame : null;
    if (f) { xy = Math.max((f.ncol - 1) * f.spacing_x, (f.nrow - 1) * f.spacing_y); }
    else {
      var p = vol3.pos, n = p.length / 3, xmn = Infinity, xmx = -Infinity, zmn = Infinity, zmx = -Infinity;
      for (var q = 0; q < n; q++) { var x = p[q * 3], z = p[q * 3 + 2]; if (x < xmn) xmn = x; if (x > xmx) xmx = x; if (z < zmn) zmn = z; if (z > zmx) zmx = z; }
      xy = Math.max(xmx - xmn, zmx - zmn);
    }
    var rr = xy / dz / 2.5;
    return isFinite(rr) ? Math.min(20, Math.max(4, Math.round(rr))) : 5;
  }
  function applyVolExagV3(val) {
    S.volExag = val;
    if (!three) return;
    three.mesh.scale.set(1, val, 1); frameVolumeV3();
    updateVolBadge();
    three.render();
  }
  // A small "fit z ×N" button beside the slider — applies the aspect suggestion.
  function fitExagButton(suggested, apply) {
    var b = el("button", "btn secondary", "fit z ×" + suggested);
    b.style.cssText = "width:auto;padding:4px 10px;margin-top:2px";
    b.title = "Apply the aspect-derived exaggeration (a thin, wide reservoir reads with relief, not a pancake)";
    b.onclick = apply;
    return b;
  }

  function frameVolumeV3() {
    var THREE = three.THREE;
    var box = new THREE.Box3().setFromObject(three.mesh);
    if (box.isEmpty()) return;
    var c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
    var rad = Math.max(sz.x, sz.y, sz.z) * 0.6 || 1;
    three.controls.target.copy(c);
    three.camera.position.set(c.x + rad * 1.6, c.y + rad * 1.2, c.z + rad * 1.8);
    three.camera.near = rad / 100; three.camera.far = rad * 100; three.camera.updateProjectionMatrix();
    three.controls.update();
  }

  // Server re-cut (decision (b)): re-request a shell cut at the cutoff so revealed
  // interior faces appear. The endpoint is a pluggable provider (peteksim wires it
  // later — the section_provider pattern); absent -> fall back to the client filter.
  function requestThresholdedVolume(cutoff) {
    if (App.mode !== "server") return;
    var v = App.payload.volume;
    var params = new URLSearchParams();
    params.set("property", v.property || App.payload.property || "");
    params.set("cutoff", String(cutoff));
    params.set("keep_above", "true");
    showEmpty("Re-cutting shell at cutoff…");
    fetch("./volume?" + params.toString())
      .then(function (r) { if (!r.ok) return r.text().then(function (t) { throw new Error(t || ("HTTP " + r.status)); }); return r.json(); })
      .then(function (env) { App.payload.volume = env; vol3 = null; renderVolume(); })
      .catch(function (e) { hideEmpty(); showBanner("Server re-cut unavailable", String((e && e.message) || e), "Falling back to the client-side shell filter (exterior triangles only)."); });
  }
