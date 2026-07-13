/*
 * petek viewer — bundle-driven, domain-agnostic. It renders whatever typed
 * layers / columns / mesh / marks the payload JSON declares; it carries no
 * domain knowledge and NEVER computes reservoir results (new sections come from
 * the server's /section endpoint, or are pre-computed in the payload).
 *
 * Colour follows the dataviz method:
 *   - CONTINUOUS FIELDS (property / depth rasters, section fills, volume) use a
 *     perceptually-uniform scientific colormap (viridis default) — never rainbow.
 *   - CATEGORICAL IDENTITY (wells, horizons, contacts, zones) uses the fixed
 *     token slots (--c1..--c8), assigned by ENTITY and never recoloured when a
 *     toggle changes the visible count or the theme flips (the hue steps, the
 *     slot — the identity — stays).
 */
(function () {
  "use strict";

  var root = document.getElementById("app");
  var App = { payload: null, mode: "file", tab: "map" };

  // Cumulative map-operation counters for the browser performance contract.
  // They are observational only: the runner snapshots deltas around a gesture.
  var _viewerPerf = window.__PETEK_MAP_PERF || (window.__PETEK_MAP_PERF = {});
  ["pointPathBuilds", "triFillBuilds", "canvasBackingWrites",
   "legendMutations", "styleReads", "rafRequests", "hotPaints",
   "settlePaints", "fillCacheHits", "fillCacheMisses",
   "fillCacheEvictions", "blockDecodeRequests", "blockDecodeDigests",
   "lazyFillDecodes", "gridPathBuilds", "contourPathBuilds",
   "outlinePathBuilds", "contactMaskBuilds", "overlayBitmapBuilds",
   "overlayHotBlits"].forEach(function (name) {
    if (_viewerPerf[name] == null) _viewerPerf[name] = 0;
  });
  function perfCount(name) { _viewerPerf[name] = (_viewerPerf[name] || 0) + 1; }

  // ---- boot ----------------------------------------------------------------
  function boot(payload) {
    App.payload = payload;
    initWorkspace(payload);
    // Resolve the 2-D map's binary blocks (SCHEMA.md) into typed arrays — off the
    // main thread when a Worker is available, else synchronously. A JSON-shaped
    // (blockless) map is a no-op; the renderer reads either shape.
    decodeMap2d(payload);
    registerIdentities();
    initState();
    wireChrome();
    // A pure-analytics payload (charts only, no geometry) opens on the Charts tab;
    // a logs-only payload (petekio's well.view() standalone path) opens on Wells;
    // a view3d payload (scene3d, no map) opens straight on the 3D tab.
    if (!payload.map && !payload.volume && !(payload.sections && payload.sections.length)) {
      if (payload.scene3d) App.tab = "scene3d";
      else if (payload.wells_logs && payload.wells_logs.wells && payload.wells_logs.wells.length) App.tab = "wells";
      else if (payload.charts && payload.charts.length) App.tab = "charts";
    }
    selectTab(App.tab);
  }

  function load() {
    // Loud, never silent: a bad payload (throw in boot) or a failed
    // fetch/JSON.parse surfaces a banner with the reason — the ledger's
    // silent-blank-page death mode is the enemy.
    if (window.PETEK_VIEWER_PAYLOAD) {
      App.mode = "file";
      try {
        boot(window.PETEK_VIEWER_PAYLOAD);
      } catch (e) {
        showBanner("Viewer failed to start", String((e && e.message) || e)
          + " — the inlined payload is malformed or incompatible with this build.");
      }
    } else {
      App.mode = "server";
      fetch("./model.json")
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.text();
        })
        .then(function (txt) {
          var payload;
          try { payload = JSON.parse(txt); }
          catch (e) { throw new Error("model.json is not valid JSON (" + (e && e.message) + ")"); }
          boot(payload);
        })
        .catch(function (e) {
          showBanner("Could not load model.json", String((e && e.message) || e));
        });
    }
  }

  // ---- categorical identity palette (stable per entity) --------------------
  var SLOTS = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6", "--c7", "--c8"];
  var idSlot = {}; // entity key -> slot index (fixed for the life of the bundle)
  var idCount = 0;
  function registerId(key) {
    if (!(key in idSlot)) { idSlot[key] = idCount % SLOTS.length; idCount++; }
  }
  function registerIdentities() {
    var p = App.payload;
    // Register workspace identities before deferred resources arrive so colour
    // slots never depend on fetch order.
    workspaceIdentityKeys().forEach(registerId);
    // Order = payload order → stable across sessions of the same bundle.
    (p.wells || []).forEach(function (w) { registerId("well:" + w.id); });
    // 3-D scene wells (view3d payloads) take the same well: identity slots.
    ((p.scene3d && p.scene3d.wells) || []).forEach(function (w) { registerId("well:" + w.id); });
    (p.map && p.map.horizons || []).forEach(function (h) { registerId("hz:" + h.name); });
    (p.map && p.map.contacts || []).forEach(function (c) { registerId("ct:" + c.kind); });
    (p.volume && p.volume.zone_names || []).forEach(function (z) { registerId("zone:" + z); });
    ((p.sections && p.sections[0] && p.sections[0].contacts) || []).forEach(function (c) {
      registerId("ct:" + c.kind);
    });
    // interior-horizon traces on a section (v4) take the same hz: identity slot.
    ((p.sections && p.sections[0] && p.sections[0].horizon_traces) || []).forEach(function (h) {
      registerId("hz:" + h.name);
    });
    // section zone bands: a SectionBundle may carry `zones: [{name, color?}]` +
    // per-column `zone_ids`. Zone identity is keyed by NAME — the SAME slot the
    // volume/wells zone legends use, so a zone keeps its colour across every tab
    // (identity follows the entity — the dataviz rule). Registered AFTER the
    // volume zones so the volume's slot ordering stays authoritative; a
    // user-declared `color` overrides the slot at paint time, not here.
    (p.sections || []).forEach(function (sec) {
      (sec.zones || []).forEach(function (z) { registerId("zone:" + z.name); });
    });
    // well-log correlation identities: curves keyed by TRACK (mnemonic) so PHIE is
    // one colour across every well (identity by track, not by well); zones by name;
    // tops reuse the hz: horizon slots.
    ((p.wells_logs && p.wells_logs.wells) || []).forEach(function (w) {
      (w.curves || []).forEach(function (c) { registerId("curve:" + c.mnemonic); });
      (w.zones || []).forEach(function (z) { registerId("zone:" + z.name); });
      (w.tops || []).forEach(function (t) { registerId("hz:" + t.horizon); });
    });
    // chart identities: scatter categorical groups + distribution series names
    // (each a fixed slot, stable for the life of the bundle). Tornado swings use
    // the diverging pair, not the identity slots.
    (p.charts || []).forEach(function (ch) {
      if (ch.mark === "scatter" && ch.color_by && ch.color_by.kind === "categorical") {
        (ch.groups || []).forEach(function (g) { registerId("grp:" + g); });
      } else if (ch.mark === "distribution") {
        (ch.series || []).forEach(function (s) { registerId("dist:" + s.name); });
      }
    });
  }
  // Theme tokens are resolved once per theme, never inside navigation frames.
  // Theme flips invalidate the tiny cache before their explicit non-hot render.
  var _themeTokenCache = {};
  function invalidateThemeTokens() { _themeTokenCache = {}; }
  function cssvar(name) {
    if (Object.prototype.hasOwnProperty.call(_themeTokenCache, name)) {
      return _themeTokenCache[name];
    }
    perfCount("styleReads");
    return (_themeTokenCache[name] = getComputedStyle(root).getPropertyValue(name).trim());
  }
  function idColor(key) {
    if (!(key in idSlot)) registerId(key);
    return cssvar(SLOTS[idSlot[key]]);
  }
  function token(name) { return cssvar(name); }

  // ---- perceptually-uniform colormaps (continuous fields) ------------------
  // Anchor stops (sRGB 0..1) — each map sampled at 0,.25,.5,.75,1; linear
  // interpolation between is smooth enough for a raster/mesh ramp. The name
  // set is the registry the Python color=/fill= spec grammar matches against
  // (petektools.viewer._view2d._COLORMAPS) — keep the two in sync.
  var COLORMAPS = {
    viridis: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
    magma: [[0, 0, 4], [81, 18, 124], [183, 55, 121], [252, 137, 97], [252, 253, 191]],
    grays: [[30, 30, 30], [90, 90, 90], [140, 140, 140], [195, 195, 195], [245, 245, 245]],
    inferno: [[0, 0, 4], [87, 16, 110], [188, 55, 84], [249, 142, 9], [252, 255, 164]],
  };
  var COLORMAP_NAMES = ["viridis", "magma", "grays", "inferno"];
  function rampColor(name, t) {
    if (!isFinite(t)) return null;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    var stops = COLORMAPS[name] || COLORMAPS.viridis;
    var seg = (stops.length - 1) * t;
    var i = Math.min(stops.length - 2, Math.floor(seg));
    var f = seg - i;
    var a = stops[i], b = stops[i + 1];
    return [
      Math.round(a[0] + (b[0] - a[0]) * f),
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f),
    ];
  }
  function rampCss(name, t) { var c = rampColor(name, t); return c ? "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")" : "transparent"; }
  function rampGradient(name) {
    var stops = COLORMAPS[name] || COLORMAPS.viridis;
    return "linear-gradient(90deg," + stops.map(function (c, i) {
      return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ") " + Math.round((i / (stops.length - 1)) * 100) + "%";
    }).join(",") + ")";
  }

  // ---- display names -------------------------------------------------------
  // A payload may carry an optional `display_name` on any named entity (schema
  // additive). The viewer renders it when present, else beautifies the raw
  // internal name: an "A::B" scoped name reads as "A (B)". The identity KEY
  // (colour slot) always uses the raw name — only the drawn label changes.
  function pretty(name) {
    if (name == null) return "";
    var s = String(name);
    var i = s.indexOf("::");
    if (i >= 0) return s.slice(0, i) + " (" + s.slice(i + 2).replace(/::/g, ", ") + ")";
    return s;
  }
  function disp(o, rawName) {
    if (o && o.display_name) return o.display_name;
    return pretty(rawName != null ? rawName : (o && o.name));
  }
  // A TriFill carries the source object's `display_name` and the value-layer
  // identity in `name`. Keep both visible: auto-enumerated attributes from one
  // surface (and equal attribute names across several surfaces) must never become
  // an ambiguous row of duplicate selector/legend labels.
  function fillLabel(fill) {
    if (!fill) return "fill";
    var attr = pretty(fill.name);
    var source = fill.display_name ? String(fill.display_name) : "";
    if (source && attr && source !== attr) return source + " · " + attr;
    return source || attr || "fill";
  }

  // ---- units / formatting --------------------------------------------------
  function fmt(v, unit) {
    if (v == null || !isFinite(v)) return "—";
    var s = Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 })
      : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4);
    return unit ? s + " " + unit : s;
  }

  // ---- state ---------------------------------------------------------------
  var S = {};
  function initState() {
    var p = App.payload;
    document.getElementById("title").textContent =
      W && W.manifest.title ? W.manifest.title
        : (p.kind ? p.kind + " · " : "") + (p.property || "model") + " viewer";
    document.getElementById("mode-badge").textContent =
      App.mode === "server" ? "live" : (W ? "offline · static" : "file · static");

    // Map field layers = horizons + zone averages + k-slices (each a ScalarLayer).
    var m = p.map || {};
    S.mapLayers = []
      .concat((m.horizons || []).map(function (l) { return tagLayer(l, "horizon"); }))
      .concat((m.zone_averages || []).map(function (l) { return tagLayer(l, "property"); }))
      .concat((m.k_slices || []).map(function (l) { return tagLayer(l, "property"); }));
    // Default: the top-horizon depth map (structure first, properties by choice).
    // horizons come first in S.mapLayers, so index 0 is the top horizon; fall back
    // to the first property map only when there are no horizon layers.
    S.mapLayerIdx = 0;
    if (S.mapLayerIdx >= S.mapLayers.length) S.mapLayerIdx = Math.max(0, S.mapLayers.length - 1);
    // The payload may pin the initial colormap (a view2d/view3d color=/fill=
    // "<cmap>" spec travels as map.colormap / scene3d.colormap); the panel
    // selector can still change it.
    var pinned = m.colormap || (p.scene3d && p.scene3d.colormap);
    S.colormap = pinned && COLORMAPS[pinned] ? pinned : "viridis";
    S.showOutline = true;
    S.clipRaster = true; // clip the areal raster to the outline polygon (QC toggle)
    // Filled surfaces read cleanly without the dense geometry lattice. Geometry-
    // only payloads keep their lines on so they are not rendered as an empty map.
    // Workspace resources apply this once when their first real map is composed;
    // subsequent resource/lane changes preserve the user's manual toggle.
    S.showGridLines = !(m.fills && m.fills.length) || (m.layers || []).some(function (layer) {
      return layer.kind === "lines" && layer.standalone === true;
    });
    S.mapGridDefaultApplied = !!p.map;
    S.showPoints = true;
    // value-coloured trimesh fills + contour iso-lines (2-D QA payloads):
    // one active fill at a time (selectable), each toggleable like the other
    // map layers. Both default visible — asking for them means wanting them.
    S.mapFillIdx = 0;
    S.showFills = true;
    S.showContours = true;
    // Stride-ladder LOD (view2d lod=): false = full-resolution rings. Flipped on
    // zoom-settle by the map renderer when a data cell shrinks below a few px and
    // the payload carries coarse rings; a payload without LOD keeps it false.
    S.lodActive = false;
    S.contactVis = (m.contacts || []).map(function () { return true; });
    S.wellVis = (p.wells || []).map(function () { return true; });

    S.sectionIdx = 0;
    S.vexag = 5;
    S.showHorizons = true;
    S.showContacts = true;
    S.showPathZ = true;
    // Section fill source: "property" (the continuous colormap) or "zone" (the
    // fixed categorical zone identity). The Intersection "Color by" select flips
    // it; it only appears when the active section carries zone bands (graceful
    // fallback — a payload without zone_ids stays on the property colormap).
    S.sectionColorBy = "property";

    // The 3-D scene tab (view3d payloads): z-exaggeration seed (the payload's
    // z_exaggeration, the volume tab's 5x default otherwise) + per-kind layer
    // visibility + the neutral-mesh wireframe option. The "3D" tab button only
    // shows when the payload carries a scene3d bundle (older payloads see no
    // new chrome).
    var s3 = p.scene3d || {};
    S.s3dExag = s3.z_exaggeration || 5;
    S.s3dShow = { points: true, meshes: true, lattice: !(s3.meshes && s3.meshes.length) || (s3.layers || []).some(function (layer) {
      return layer.kind === "lines" && layer.standalone === true;
    }), contours: true, wells: true, outlines: true };
    S.s3dLatticeDefaultApplied = !!p.scene3d;
    S.s3dWireframe = false;
    var tab3d = document.querySelector('.tab[data-tab="scene3d"]');
    if (tab3d) tab3d.hidden = !p.scene3d && !workspaceHasView("scene3d");

    var v = p.volume || {};
    S.dims = deriveDims();
    // Default vertical exaggeration is 5× (fixed) for BOTH the section and the
    // volume (owner ruling). The aspect-derived suggestion is not the default —
    // it is an explicit "fit z ×N" affordance beside the slider.
    S.volExag = 5;
    S.threshold = v.value_range ? v.value_range.min : 0;
    S.zoneVis = (v.zone_names || []).map(function () { return true; });
    S.clip = { i: [0, S.dims.ni - 1], j: [0, S.dims.nj - 1], k: [0, S.dims.nk - 1] };
    // v3 shell: server-side re-cut off by default (client-side shell filter first).
    S.trueInterior = false;

    // Live sections get appended here; labels mirror payload.section_labels.
    S.sections = (p.sections || []).slice();
    S.sectionLabels = (p.section_labels || []).slice();
    S.fence = { drawing: false, pts: [] };

    // Well correlation (Wells tab). The log lanes (md/tvd + curve values) are f32
    // binary blocks — decoded here on the SAME machinery the volume blocks use
    // (window.PETEK_DECODE); they are tiny, so it is a synchronous inline decode,
    // no worker. Two hanging modes: TVD (shared absolute depth axis) and
    // FLATTEN-ON-PICK (each well shifted so a chosen horizon aligns — viewer-side).
    initWellsState(p);

    // Chart marks (tornado / scatter / distribution). Render-only: every number
    // (bins, cdf points, regression coefficients, pivots) arrives in the payload.
    S.charts = (p.charts || []).slice();
    S.chartIdx = 0;
    // Per-chart UI overrides (log-axis toggles start from the payload's declared
    // scale; group visibility defaults on). Keyed by chart index.
    S.chartUI = S.charts.map(function (ch) {
      return {
        xlog: !!(ch.x && ch.x.log),
        ylog: !!(ch.y && ch.y.log),
        trends: true,
      };
    });
  }
  function tagLayer(l, kind) { return { name: l.name, display: disp(l, l.name), units: l.units, values: l.values, range: l.range, kind: kind }; }
  function deriveDims() {
    var f = App.payload.map ? App.payload.map.frame : null;
    var cc = App.payload.volume ? App.payload.volume.cell_count : 0;
    var ni = f ? f.ncol : 1, nj = f ? f.nrow : 1;
    var nk = ni * nj > 0 ? Math.max(1, Math.round(cc / (ni * nj))) : 1;
    return { ni: ni, nj: nj, nk: nk };
  }
  // Suggest a z-exaggeration from the mesh's areal-vs-vertical extent ratio so a
  // thin, wide reservoir (~km × ~m) shows relief instead of a pancake. Clamped to
  // the slider's 1..20 range; falls back to 8 when the mesh is unavailable.
  function suggestVolExag(v) {
    if (!v || !v.positions || !v.positions.length) return 8;
    var xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, zmin = Infinity, zmax = -Infinity;
    var n = v.positions.length / 3;
    for (var q = 0; q < n; q++) {
      var x = v.positions[q * 3], y = v.positions[q * 3 + 1], z = v.positions[q * 3 + 2];
      if (x < xmin) xmin = x; if (x > xmax) xmax = x;
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
      if (z < zmin) zmin = z; if (z > zmax) zmax = z;
    }
    var xy = Math.max(xmax - xmin, ymax - ymin), dz = (zmax - zmin) || 1;
    // Aim for roughly a 1:2.5 apparent aspect so a thin, wide reservoir shows real
    // relief (a ~20:1 field lands near the ~8× the owner asked for), clamped 4..20.
    var r = xy / dz / 2.5;
    if (!isFinite(r)) return 8;
    return Math.min(20, Math.max(4, Math.round(r)));
  }
