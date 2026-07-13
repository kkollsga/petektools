  // ---- control panel (per tab) ---------------------------------------------
  function buildPanel() {
    var body = document.getElementById("panel-body"); body.innerHTML = "";
    if (App.tab === "map") buildMapPanel(body);
    else if (App.tab === "section") buildSectionPanel(body);
    else if (App.tab === "scene3d") buildScene3dPanel(body);
    else if (App.tab === "charts") buildChartsPanel(body);
    else if (App.tab === "wells") buildWellsPanel(body);
    else buildVolumePanel(body);
    if (App.payload.map || App.payload.volume) body.appendChild(gridInfoGroup());
    if (App.payload.summary) body.appendChild(summaryGroup());
  }
  function buildMapPanel(body) {
    if (!App.payload.map) { body.appendChild(el("div", "hint", workspaceLoadingHint("map") || "No map bundle in this payload.")); return; }
    if (S.mapLayers.length) {
      var g = group("Field");
      g.appendChild(selectRow("Layer", S.mapLayers.map(function (l) { return l.display; }), S.mapLayerIdx, function (i) { S.mapLayerIdx = i; renderMap(); }));
      g.appendChild(colormapRow());
      body.appendChild(g);
    }

    // value-coloured trimesh fills: a selector (multiple fills → one active)
    // + the shared colormap row when no ScalarLayer group already carries it.
    var fills = App.payload.map.fills || [];
    if (fills.length) {
      var fg = group("Fill");
      if (fills.length > 1) {
        fg.appendChild(selectRow("Layer", fills.map(fillLabel), S.mapFillIdx, selectMapFill));
      } else {
        fg.appendChild(el("div", "hint", fillLabel(fills[0])));
      }
      if (!S.mapLayers.length) fg.appendChild(colormapRow());
      body.appendChild(fg);
    }

    // value-coloured points with no raster layer and no fill still need the
    // colormap selector (the ramp colours the point cloud + its legend).
    if (!S.mapLayers.length && !fills.length && App.payload.map.point_color) {
      var pg = group("Points");
      pg.appendChild(colormapRow());
      body.appendChild(pg);
    }

    var t = group("Layers");
    t.appendChild(toggleRow("Outline", S.showOutline, token("--text-secondary"), true, function (v) { S.showOutline = v; renderMap(); }));
    if (fills.length) {
      t.appendChild(toggleRow("Fill", S.showFills, null, false, function (v) { S.showFills = v; renderMap(); }));
    }
    if (App.payload.map.contours && App.payload.map.contours.length) {
      t.appendChild(toggleRow("Contours", S.showContours, token("--text-secondary"), true, function (v) { S.showContours = v; renderMap(); }));
    }
    if (App.payload.map.grid_lines && App.payload.map.grid_lines.length) {
      t.appendChild(toggleRow("Grid lines", S.showGridLines, token("--muted"), true, function (v) { S.showGridLines = v; renderMap(); }));
    }
    if (App.payload.map.points && App.payload.map.points.length) {
      t.appendChild(toggleRow("Points", S.showPoints, token("--accent"), false, function (v) { S.showPoints = v; renderMap(); }));
    }
    if (S.mapLayers.length && App.payload.map.outline && App.payload.map.outline.length) {
      t.appendChild(toggleRow("Unclipped raster", !S.clipRaster, null, false, function (v) { S.clipRaster = !v; renderMap(); }));
    }
    (App.payload.map.contacts || []).forEach(function (c, i) {
      t.appendChild(toggleRow("Contact " + disp(c, c.kind), S.contactVis[i], idColor("ct:" + c.kind), false, function (v) { S.contactVis[i] = v; renderMap(); }));
    });
    (App.payload.wells || []).forEach(function (w, i) {
      t.appendChild(toggleRow(disp(w, w.id), S.wellVis[i], idColor("well:" + w.id), false, function (v) { S.wellVis[i] = v; renderMap(); }));
      if (w.ties && w.ties.length) {
        var h = el("div", "hint", "ties: " + w.ties.map(function (tt) { return pretty(tt.horizon) + " " + fmt(tt.residual_m, "m"); }).join(" · "));
        h.style.margin = "-2px 0 5px 22px";
        t.appendChild(h);
      }
    });
    body.appendChild(t);

    if (S.mapLayers.length || (App.payload.wells || []).length) {
      var f = group("Section tools");
      var draw = el("button", "btn"); draw.textContent = S.fence.drawing ? "Finish fence (dbl-click)" : "Draw fence line";
      if (App.mode !== "server") { draw.className = "btn secondary"; draw.disabled = true; draw.title = "Live fence drawing needs model.view() (server mode)."; }
      draw.onclick = function () { if (S.fence.drawing) finishFence(); else { S.fence.drawing = true; S.fence.pts = []; buildPanel(); renderMap(); } };
      f.appendChild(draw);
      f.appendChild(el("div", "hint", App.mode === "server"
        ? "Click points on the map to define a fence, then double-click (or Finish) to cut it. Click a well marker to section along its bore."
        : "This is a self-contained file export: pre-computed sections only. Open with model.view() for live fence-draw + click-a-well."));
      body.appendChild(f);
    }
  }
  function buildSectionPanel(body) {
    if (S.sections.length) {
      var b = S.sections[Math.min(S.sectionIdx, S.sections.length - 1)];
      var zoneData = !!(b && b.zones && b.zones.length &&
        (b.columns || []).some(function (c) { return c.zone_ids && c.zone_ids.length; }));
      var g = group("Section");
      g.appendChild(selectRow("Trace", S.sectionLabels.length ? S.sectionLabels.map(pretty) : S.sections.map(function (_, i) { return "Section " + (i + 1); }), S.sectionIdx, function (i) { S.sectionIdx = i; renderSection(); buildPanel(); }));
      // Color-by: property colormap vs zone categorical. Shown ONLY when the
      // active section carries zone bands — a payload without zone_ids never shows
      // the toggle (graceful; the fill stays on the property colormap).
      if (zoneData) {
        g.appendChild(selectRow("Color by", ["property", "zone"], S.sectionColorBy === "zone" ? 1 : 0, function (i) {
          S.sectionColorBy = i === 1 ? "zone" : "property"; renderSection(); buildPanel();
        }));
      }
      g.appendChild(colormapRow());
      g.appendChild(sliderRow("Vertical exag.", 1, 20, 1, S.vexag, function (v) { S.vexag = v; renderSection(); }));
      body.appendChild(g);
      var t = group("Layers");
      t.appendChild(toggleRow("Horizons", S.showHorizons, token("--text-secondary"), true, function (v) { S.showHorizons = v; renderSection(); }));
      t.appendChild(toggleRow("Contacts", S.showContacts, token("--muted"), true, function (v) { S.showContacts = v; renderSection(); }));
      t.appendChild(toggleRow("Bore path", S.showPathZ, token("--c1"), true, function (v) { S.showPathZ = v; renderSection(); }));
      body.appendChild(t);
    } else {
      body.appendChild(el("div", "hint", "No sections yet. On the Map tab, draw a fence or click a well."));
    }
  }
  function buildVolumePanel(body) {
    var v = App.payload.volume;
    if (isVolumeV3(v)) { buildVolumePanelV3(body, v); return; }
    var g = group("Property");
    g.appendChild(el("div", "hint", v.property + " · " + v.cell_count + " cells"));
    g.appendChild(colormapRow());
    var r = v.value_range, span = (r.max - r.min) || 1;
    g.appendChild(sliderRow("Threshold ≥", r.min, r.max, span / 100, S.threshold, function (val) { S.threshold = val; rebuildVolumeGeometry(); }));
    g.appendChild(sliderRow("z exaggeration", 1, 20, 1, S.volExag, function (val) { S.volExag = val; renderVolume(); }));
    (function () { var s = suggestVolExag(v); g.appendChild(fitExagButton(s, function () { S.volExag = s; buildPanel(); renderVolume(); })); })();
    body.appendChild(g);

    var z = group("Zones");
    (v.zone_names || []).forEach(function (name, i) {
      z.appendChild(toggleRow(name, S.zoneVis[i], idColor("zone:" + name), false, function (val) { S.zoneVis[i] = val; rebuildVolumeGeometry(); }));
    });
    body.appendChild(z);

    var cl = group("Clip");
    ["i", "j", "k"].forEach(function (axis) {
      var maxIdx = S.dims[{ i: "ni", j: "nj", k: "nk" }[axis]] - 1;
      cl.appendChild(sliderRow(axis + " min", 0, maxIdx, 1, S.clip[axis][0], function (val) { S.clip[axis][0] = Math.min(val, S.clip[axis][1]); rebuildVolumeGeometry(); }));
      cl.appendChild(sliderRow(axis + " max", 0, maxIdx, 1, S.clip[axis][1], function (val) { S.clip[axis][1] = Math.max(val, S.clip[axis][0]); rebuildVolumeGeometry(); }));
    });
    body.appendChild(cl);

    var reset = el("button", "btn secondary", "Reset view"); reset.onclick = function () { three.framed = false; renderVolume(); };
    body.appendChild(reset);
  }
  // v3 exterior-shell panel: threshold + zones + z-exag (no i/j/k clip — the
  // shell's tri_cell is a compact index with no linear grid id; true interior
  // exposure is the server re-cut). Threshold/zone rebuild the visible index.
  function buildVolumePanelV3(body, v) {
    var g = group("Property");
    // vol3 identifies the payload as soon as async decode starts, before its
    // rendered triangleCount exists. Keep the panel live during that interval
    // by showing the envelope's declared count until the worker result lands.
    var tris = vol3 && vol3._for === v && vol3.triangleCount != null
      ? vol3.triangleCount : envTriangleCount(v);
    var shell = v.shell_cell_count != null ? v.shell_cell_count : (v.cell_count || 0);
    g.appendChild(el("div", "hint", (v.property || "value") + " · shell " + shell.toLocaleString() + " cells · " + tris.toLocaleString() + " tris"));
    if (vol3 && vol3._for === v && vol3._degraded) {
      var dh = el("div", "hint", "Decimated preview: 1 in " + vol3._degraded.stride + " triangles (budget "
        + vol3._degraded.budget.toLocaleString() + "). Raise the threshold or re-export a coarser LOD for full resolution.");
      dh.style.color = "var(--swing-lo)";
      g.appendChild(dh);
    }
    g.appendChild(colormapRow());
    var r = v.value_range || { min: 0, max: 1 }, span = (r.max - r.min) || 1;
    g.appendChild(sliderRow("Threshold ≥", r.min, r.max, span / 100, S.threshold, function (val) {
      S.threshold = val;
      if (S.trueInterior && App.mode === "server") { requestThresholdedVolume(val); return; }
      applyVolumeV3Filter(); three.render();
    }));
    g.appendChild(sliderRow("z exaggeration", 1, 20, 1, S.volExag, applyVolExagV3));
    if (vol3 && vol3._for === v && vol3.depthRange) {
      var s3 = suggestV3Exag();
      g.appendChild(fitExagButton(s3, function () { applyVolExagV3(s3); buildPanel(); }));
    }
    body.appendChild(g);

    var z = group("Zones");
    (v.zone_names || []).forEach(function (name, i) {
      z.appendChild(toggleRow(name, S.zoneVis[i], idColor("zone:" + name), false, function (val) { S.zoneVis[i] = val; applyVolumeV3Filter(); three.render(); }));
    });
    body.appendChild(z);

    if (App.mode === "server") {
      var s = group("Interior");
      s.appendChild(toggleRow("True interior (server re-cut)", S.trueInterior, null, false, function (val) { S.trueInterior = val; if (val) requestThresholdedVolume(S.threshold); }));
      s.appendChild(el("div", "hint", "Off: client-side shell filter — hides triangles below the cutoff (exterior only). On: the server re-cuts the shell at the cutoff, exposing revealed interior faces (needs a volume_provider — peteksim)."));
      body.appendChild(s);
    } else {
      body.appendChild(el("div", "hint", "Threshold hides shell triangles below the cutoff (client-side, exterior only). True interior exposure needs the live server (model.view())."));
    }
    var reset = el("button", "btn secondary", "Reset view"); reset.onclick = function () { if (vol3) frameVolumeV3(); if (three) three.render(); };
    body.appendChild(reset);
  }
  // Cell geometry is always visible: dims + mean cell size (dx × dy × mean dz).
  function meanCellDz() {
    if (S._meanDz !== undefined) return S._meanDz;
    var v = App.payload.volume;
    if (v && v.positions && v.positions.length && !isVolumeV3(v)) {
      var zlo = Infinity, zhi = -Infinity, n = v.positions.length / 3;
      for (var q = 0; q < n; q++) { var z = v.positions[q * 3 + 2]; if (z < zlo) zlo = z; if (z > zhi) zhi = z; }
      S._meanDz = (zhi - zlo) / Math.max(1, S.dims.nk);
    } else S._meanDz = NaN;
    return S._meanDz;
  }
  function infoRow(g, label, value) {
    var row = el("div", "row between"); row.appendChild(el("label", null, label));
    row.appendChild(el("span", null, value)); g.appendChild(row);
  }
  function gridInfoGroup() {
    var g = group("Grid"); var d = S.dims;
    var f = App.payload.map ? App.payload.map.frame : null;
    infoRow(g, "cells (i×j×k)", d.ni + " × " + d.nj + " × " + d.nk);
    if (f) {
      var dz = meanCellDz();
      infoRow(g, "cell size (m)", fmt(f.spacing_x) + " × " + fmt(f.spacing_y) + " × " + (isFinite(dz) ? fmt(dz) : "—"));
    }
    return g;
  }
  function summaryGroup() {
    var g = group("Summary"); var s = App.payload.summary;
    Object.keys(s).forEach(function (k) {
      if (s[k] == null) return;
      var row = el("div", "row between"); row.appendChild(el("label", null, k));
      row.appendChild(el("span", null, typeof s[k] === "number" ? fmt(s[k]) : String(s[k])));
      g.appendChild(row);
    });
    return g;
  }

  // ---- canvas sizing + hover wiring ----------------------------------------
  function sizeCanvas(cv) {
    // Work in CSS pixels 1:1 (our world<->screen math reads cv.width/height).
    var host = cv.parentElement.getBoundingClientRect();
    var width = Math.max(1, Math.round(host.width));
    var height = Math.max(1, Math.round(host.height));
    if (cv.width !== width) { cv.width = width; perfCount("canvasBackingWrites"); }
    if (cv.height !== height) { cv.height = height; perfCount("canvasBackingWrites"); }
  }

  // wire canvas interactions once
  window.addEventListener("resize", function () {
    // Resize preserves every completed camera. Only an initial fit that is still
    // waiting for deferred content remains eligible to run on a later paint.
    if (mapView.fitRequest) requestMapFit(mapView.fitRequest);
    three && (three.framed = true); renderActive();
  });
  function wireCanvasHovers() {
    mapPanZoomHover(document.getElementById("map-canvas"));
    var sc = document.getElementById("section-canvas");
    sc.addEventListener("mousemove", function (ev) { sectionHover(sc, ev); });
    sc.addEventListener("mouseleave", hideReadout);
    var cc = document.getElementById("charts-canvas");
    cc.addEventListener("mousemove", function (ev) { chartHover(cc, ev); });
    cc.addEventListener("mouseleave", hideReadout);
    var wc = document.getElementById("wells-canvas");
    wc.addEventListener("mousemove", function (ev) { wellsHover(wc, ev); });
    wc.addEventListener("mouseleave", hideReadout);
  }
  document.addEventListener("DOMContentLoaded", function () { wireCanvasHovers(); load(); });
  if (document.readyState !== "loading") { wireCanvasHovers(); load(); }
})();
