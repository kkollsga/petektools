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
    (App.payload.map.outline || []).forEach(function (ring) { ring.forEach(function (pt) { ext(pt[0], pt[1]); }); });
    (App.payload.map.grid_lines || []).forEach(function (line) { line.forEach(function (pt) { ext(pt[0], pt[1]); }); });
    (App.payload.map.points || []).forEach(function (pt) { ext(pt[0], pt[1]); });
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
  }
  function w2s(x, y) { return [x * mapView.scale + mapView.ox, y * mapView.scale + mapView.oy]; }
  function s2w(px, py) { return [(px - mapView.ox) / mapView.scale, (py - mapView.oy) / mapView.scale]; }

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
    var clipRings = App.payload.map.outline;
    if (S.clipRaster && clipRings && clipRings.length) {
      ctx.beginPath();
      clipRings.forEach(function (ring) {
        ring.forEach(function (pt, i) { var s = w2s(pt[0], pt[1]); if (i === 0) ctx.moveTo(s[0], s[1]); else ctx.lineTo(s[0], s[1]); });
        ctx.closePath();
      });
      ctx.clip();
    }
    ctx.translate(p[0], p[1]);
    ctx.scale(mapView.scale * sx * stI, mapView.scale * sy * stJ);
    ctx.drawImage(off, 0, 0, rc, rr);
    ctx.restore();
  }

  function renderMap() {
    var cv = document.getElementById("map-canvas");
    if (!App.payload.map) { showEmpty("No map bundle in this payload."); return; }
    hideEmpty();
    sizeCanvas(cv);
    if (!mapView.fitted) fitMap(cv);
    var ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = token("--surface-1"); ctx.fillRect(0, 0, cv.width, cv.height);

    var f = mapFrame();
    var layer = S.mapLayers[S.mapLayerIdx];
    if (layer) drawWindowedRaster(ctx, cv, f, layer);

    // regular-geometry gridlines (2-D QA payloads)
    if (S.showGridLines && App.payload.map.grid_lines) {
      ctx.strokeStyle = token("--muted");
      ctx.globalAlpha = 0.32;
      ctx.lineWidth = 1;
      App.payload.map.grid_lines.forEach(function (line) {
        if (!line.length) return;
        ctx.beginPath();
        line.forEach(function (pt, i) { var s = w2s(pt[0], pt[1]); if (i === 0) ctx.moveTo(s[0], s[1]); else ctx.lineTo(s[0], s[1]); });
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
    }

    // outline rings
    if (S.showOutline && App.payload.map.outline) {
      ctx.strokeStyle = token("--text-secondary"); ctx.lineWidth = 2; ctx.lineJoin = "round";
      App.payload.map.outline.forEach(function (ring) {
        ctx.beginPath();
        ring.forEach(function (pt, i) { var s = w2s(pt[0], pt[1]); if (i === 0) ctx.moveTo(s[0], s[1]); else ctx.lineTo(s[0], s[1]); });
        ctx.stroke();
      });
    }

    // point cloud overlay
    if (S.showPoints && App.payload.map.points) {
      var pts = App.payload.map.points;
      var r = Math.max(1.5, Math.min(3.5, mapView.scale < 0.05 ? 1.5 : 2.5));
      ctx.fillStyle = token("--accent");
      ctx.globalAlpha = pts.length > 20000 ? 0.45 : 0.7;
      pts.forEach(function (pt) {
        var s = w2s(pt[0], pt[1]);
        if (s[0] < -r || s[1] < -r || s[0] > cv.width + r || s[1] > cv.height + r) return;
        ctx.beginPath();
        ctx.arc(s[0], s[1], r, 0, 6.2832);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
    }

    // contact subcrop masks (crossed columns): a translucent identity fill,
    // reinforced with a diagonal hatch (45° / 135° alternating per contact per the
    // design texture rule) clipped to the crossing region and a 2px identity
    // outline around each crossing cell — legible over the field yet see-through.
    (App.payload.map.contacts || []).forEach(function (c, ci) {
      if (!S.contactVis[ci]) return;
      var col = idColor("ct:" + c.kind);
      var ss = Math.max(2, mapView.scale * Math.min(f.spacing_x, f.spacing_y));
      // Build one Path2D of all crossing cells (fill + clip + outline share it).
      var region = new Path2D();
      var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, any = false;
      for (var j = 0; j < f.nrow; j++) for (var i = 0; i < f.ncol; i++) {
        if (!c.crossing[j * f.ncol + i]) continue;
        any = true;
        var s = w2s(f.origin_x + i * f.spacing_x, f.origin_y + j * f.spacing_y);
        var x0 = s[0] - ss / 2, y0 = s[1] - ss / 2;
        region.rect(x0, y0, ss, ss);
        if (x0 < minx) minx = x0; if (y0 < miny) miny = y0;
        if (x0 + ss > maxx) maxx = x0 + ss; if (y0 + ss > maxy) maxy = y0 + ss;
      }
      if (!any) return;
      ctx.save();
      ctx.globalAlpha = 0.22; ctx.fillStyle = col; ctx.fill(region);
      // hatch inside the region
      ctx.save(); ctx.clip(region);
      ctx.globalAlpha = 0.55; ctx.strokeStyle = col; ctx.lineWidth = 1;
      var back = (ci % 2 === 1); // alternate 45°/135° per contact identity
      for (var d = minx - (maxy - miny); d <= maxx; d += 6) {
        ctx.beginPath();
        if (back) { ctx.moveTo(d, maxy); ctx.lineTo(d + (maxy - miny), miny); }
        else { ctx.moveTo(d, miny); ctx.lineTo(d + (maxy - miny), maxy); }
        ctx.stroke();
      }
      ctx.restore();
      // 2px identity outline around the crossing cells
      ctx.globalAlpha = 0.9; ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke(region);
      ctx.restore();
    });

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

    drawFieldLegend(layer);
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

  function mapPanZoomHover(cv) {
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
      renderMap();
    };
    cv.onmousedown = function (ev) {
      if (S.fence.drawing) { addFencePoint(cv, ev); return; }
      dragging = true; last = [ev.clientX, ev.clientY];
    };
    window.addEventListener("mouseup", function () { dragging = false; });
    cv.onmousemove = function (ev) {
      if (dragging) {
        mapView.ox += (ev.clientX - last[0]) * (cv.width / cv.getBoundingClientRect().width);
        mapView.oy += (ev.clientY - last[1]) * (cv.height / cv.getBoundingClientRect().height);
        last = [ev.clientX, ev.clientY]; renderMap(); return;
      }
      mapHover(cv, ev);
    };
    cv.onmouseleave = hideReadout;
    cv.ondblclick = function () { if (S.fence.drawing) finishFence(); };
    cv.onclick = function (ev) { if (!S.fence.drawing) maybeClickWell(cv, ev); };
  }
  function canvasPx(cv, ev) {
    var rect = cv.getBoundingClientRect();
    return [(ev.clientX - rect.left) * (cv.width / rect.width), (ev.clientY - rect.top) * (cv.height / rect.height)];
  }
  function mapHover(cv, ev) {
    var f = mapFrame(), layer = S.mapLayers[S.mapLayerIdx];
    var px = canvasPx(cv, ev), w = s2w(px[0], px[1]);
    // A well marker under the pointer takes precedence: show its id + per-horizon
    // surface-tie residuals (where the payload carries them).
    var hitW = null;
    (App.payload.wells || []).forEach(function (well, wi) {
      if (!S.wellVis[wi]) return;
      var s = w2s(well.x, well.y);
      if (Math.hypot(s[0] - px[0], s[1] - px[1]) <= 12) hitW = well;
    });
    if (hitW) {
      var wrows = [["", disp(hitW, hitW.id)]];
      var mean = meanTieResidual(hitW);
      if (mean != null) {
        var tier = ["", "poor", "fair", "good"][tieQuality(mean)];
        wrows.push(["mean |tie|", fmt(mean, "m") + " · " + tier]);
      }
      if (hitW.ties && hitW.ties.length) hitW.ties.forEach(function (t) { wrows.push([pretty(t.horizon) + " tie", fmt(t.residual_m, "m")]); });
      else if (mean == null) wrows.push(["", "(no tie residuals)"]);
      showReadout(ev, wrows);
      return;
    }
    var hitP = null, hitD = Infinity;
    if (S.showPoints && App.payload.map.points) {
      (App.payload.map.points || []).forEach(function (pt, pi) {
        var s = w2s(pt[0], pt[1]);
        var d = Math.hypot(s[0] - px[0], s[1] - px[1]);
        if (d <= 8 && d < hitD) { hitD = d; hitP = { point: pt, index: pi }; }
      });
      if (hitP) {
        var hp = hitP.point;
        var rows = [["", "point " + hitP.index], ["x", fmt(hp[0], "m")], ["y", fmt(hp[1], "m")]];
        if (hp.length > 2 && isFinite(hp[2])) rows.push(["z", fmt(hp[2], "m")]);
        showReadout(ev, rows);
        return;
      }
    }
    var i = Math.round((w[0] - f.origin_x) / f.spacing_x);
    var j = Math.round((w[1] - f.origin_y) / f.spacing_y);
    if (i < 0 || j < 0 || i >= f.ncol || j >= f.nrow || !layer) { hideReadout(); return; }
    var val = layer.values[j * f.ncol + i];
    showReadout(ev, [
      ["", layer.display],
      ["value", fmt(val, layer.units)],
      ["cell", "i " + i + " · j " + j],
    ]);
  }
  function maybeClickWell(cv, ev) {
    var px = canvasPx(cv, ev);
    var hit = null;
    (App.payload.wells || []).forEach(function (well, wi) {
      if (!S.wellVis[wi]) return;
      var s = w2s(well.x, well.y);
      if (Math.hypot(s[0] - px[0], s[1] - px[1]) <= 12) hit = well;
    });
    if (hit) sectionForWell(hit);
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
