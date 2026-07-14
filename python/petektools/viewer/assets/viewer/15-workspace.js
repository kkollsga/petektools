  // ================================================================= WORKSPACE
  // Optional project shell over the existing typed renderers. Old payloads never
  // allocate this state and follow their historic boot/render path exactly.
  var W = null;

  function workspaceViewName(tab) {
    return tab === "section" ? "sections" : tab;
  }
  function workspaceHasView(view) {
    return !!(W && W.available.indexOf(view) >= 0);
  }
  function workspaceIdentityKeys() {
    if (!W) return [];
    return W.order.map(function (id) { return "item:" + id; });
  }
  function workspaceItemVisible(id, view) {
    return !W || !id || !!(W.visible[id] && W.visible[id][view]);
  }
  function workspaceLane(id, view) {
    return W && W.activeLane[id] ? (W.activeLane[id][view] == null ? null : W.activeLane[id][view]) : null;
  }
  function workspaceColorBy(id, view) {
    return W && W.activeColorBy[id] ? (W.activeColorBy[id][view] == null ? null : W.activeColorBy[id][view]) : null;
  }
  function workspaceDetail(id, view) {
    return W && W.activeDetail[id] ? (W.activeDetail[id][view] == null ? null : W.activeDetail[id][view]) : null;
  }
  function workspaceResourceSlot(view, lane, detail) {
    return view + "\u0000" + (lane == null ? "" : String(lane)) + "\u0000" + (detail == null ? "" : String(detail));
  }
  function workspaceRequestKey(id, view, lane, detail) {
    return id + "\u0000" + workspaceResourceSlot(view, lane, detail);
  }
  function workspaceResource(id, view, lane, detail) {
    return W && W.resources[id] && W.resources[id][workspaceResourceSlot(view, lane, detail)];
  }
  function storeWorkspaceResource(id, view, resource) {
    if (!W.resources[id]) return;
    W.resources[id][workspaceResourceSlot(view, resource.lane, resource.detail)] = resource;
  }

  function initWorkspace(payload) {
    var manifest = payload && payload.workspace;
    if (!manifest) return;
    if (manifest.schema_version !== 1) throw new Error("unsupported workspace schema_version " + manifest.schema_version);
    W = {
      manifest: manifest, available: (manifest.available_views || []).slice(),
      order: [], items: {}, visible: {}, activeLane: {}, activeColorBy: {}, activeDetail: {}, resources: {}, loading: {}, errors: {}, detailErrors: {}, searchText: {},
      query: "", expanded: {}, expansionManual: {}, groups: {}, fetches: 0, compositions: 0, searchTimer: null,
      treeBuildMs: [], groupToggleMs: [], panelTimer: null, composeTimers: {},
      focusedTreeId: null, restoreTreeFocus: false, treeScrollTop: 0,
    };
    function visit(nodes) {
      (nodes || []).forEach(function (node) {
        var searchable = String(node.label || "") + " " + String(node.reason || "");
        if (node.diagnostic) {
          try { searchable += " " + JSON.stringify(node.diagnostic); } catch (_) {}
        }
        W.searchText[node.id] = searchable.toLowerCase();
        if (node.children) {
          W.groups[node.id] = node;
          if (Object.prototype.hasOwnProperty.call(node, "expanded")) W.expanded[node.id] = !!node.expanded;
          visit(node.children);
        } else {
          W.order.push(node.id); W.items[node.id] = node;
          W.visible[node.id] = Object.assign({}, node.visible || {});
          W.activeLane[node.id] = {};
          W.activeColorBy[node.id] = {};
          W.activeDetail[node.id] = {};
          Object.keys(node.resources || {}).forEach(function (view) {
            var spec = node.resources[view];
            if (spec && spec.lanes && spec.lanes.length) W.activeLane[node.id][view] = spec.active_lane || spec.lanes[0].id;
            if (spec && spec.lanes && spec.lanes.length) W.activeColorBy[node.id][view] = spec.active_color_by || W.activeLane[node.id][view];
            if (spec && spec.tiers && spec.tiers.length) W.activeDetail[node.id][view] = spec.active_detail || spec.tiers[0].id;
          });
          W.resources[node.id] = {};
        }
      });
    }
    visit(manifest.tree);
    // Deterministic first disclosure: reveal every initially selected path and
    // otherwise open only compact branches with at most two actionable leaves.
    // Larger catalogues start folded. From the first user twist onward the
    // decision lives in expansionManual and is never overwritten by rebuilds.
    function disclosure(node) {
      if (!node.children) {
        var selected = Object.keys(W.visible[node.id] || {}).some(function (view) { return W.visible[node.id][view]; });
        return { actionable: node.disabled ? 0 : ((node.views || []).length ? 1 : 0), selected: selected };
      }
      var result = { actionable: 0, selected: false };
      node.children.forEach(function (child) {
        var value = disclosure(child); result.actionable += value.actionable; result.selected = result.selected || value.selected;
      });
      if (!Object.prototype.hasOwnProperty.call(W.expanded, node.id)) {
        W.expanded[node.id] = result.selected || (result.actionable > 0 && result.actionable <= 2);
      }
      return result;
    }
    (manifest.tree || []).forEach(disclosure);
    var embedded = manifest.resources || {};
    Object.keys(embedded).forEach(function (id) {
      if (!W.resources[id]) return;
      Object.keys(embedded[id] || {}).forEach(function (view) {
        var values = Array.isArray(embedded[id][view]) ? embedded[id][view] : [embedded[id][view]];
        values.forEach(function (resource) {
          if (resource && resource.kind === "workspace_resource") {
            storeWorkspaceResource(id, view, resource);
            if (resource.detail === "full" && W.activeDetail[id]) W.activeDetail[id][view] = "full";
          }
        });
      });
    });
    exposeWorkspaceState();
  }

  function exposeWorkspaceState() {
    if (!W) return;
    window.__PETEK_WORKSPACE_STATE = {
      itemCount: W.order.length, activeView: workspaceViewName(App.tab),
      visible: JSON.parse(JSON.stringify(W.visible)),
      activeLane: JSON.parse(JSON.stringify(W.activeLane)),
      activeColorBy: JSON.parse(JSON.stringify(W.activeColorBy)),
      activeDetail: JSON.parse(JSON.stringify(W.activeDetail)),
      expanded: JSON.parse(JSON.stringify(W.expanded)),
      expansionManual: JSON.parse(JSON.stringify(W.expansionManual)),
      loaded: W.order.reduce(function (n, id) { return n + Object.keys(W.resources[id]).length; }, 0),
      loading: Object.keys(W.loading).length, errors: Object.keys(W.errors).length,
      fetches: W.fetches, compositions: W.compositions,
      treeBuildMs: W.treeBuildMs.slice(), groupToggleMs: W.groupToggleMs.slice(),
    };
    updateWorkspaceChrome();
  }

  function workspaceLoadingHint(view) {
    if (!W || !workspaceHasView(view)) return "";
    var pending = Object.keys(W.loading).some(function (key) { return W.loading[key].view === view && !W.loading[key].background; });
    return pending ? "Loading selected workspace resources…" : "Select an item in the Project navigator.";
  }

  function workspaceViewFeedback(view) {
    if (!W || !workspaceHasView(view)) return null;
    var selected = 0, loaded = 0, drawable = 0, malformed = 0, pending = 0, failures = [];
    W.order.forEach(function (id) {
      if (!workspaceItemVisible(id, view) || !workspaceItemHasView(id, view)) return;
      selected++;
      var lane = workspaceLane(id, view), detail = workspaceDetail(id, view), key = workspaceRequestKey(id, view, lane, detail);
      if (W.loading[key]) pending++;
      if (W.errors[key]) failures.push(W.errors[key]);
      var resource = workspaceResource(id, view, lane, detail);
      if (!resource) return;
      var payload = resource.payload;
      var valid = view === "scene3d" ? !!(payload && payload.scene3d && typeof payload.scene3d === "object")
        : view === "wells" ? !!(payload && payload.wells_logs && Array.isArray(payload.wells_logs.wells))
        : !!payload;
      if (valid) {
        loaded++;
        if (view === "scene3d") {
          var sc = payload.scene3d;
          if (["points", "meshes", "lattices", "contours", "wells", "outlines"].some(function (name) {
            return sc[name] && sc[name].length;
          })) drawable++;
        } else if (view === "wells" && payload.wells_logs.wells.length) drawable++;
        else if (view !== "scene3d" && view !== "wells") drawable++;
      } else malformed++;
    });
    if (pending) return { state: "loading", message: "Loading " + pending + " selected " + view + " resource" + (pending === 1 ? "…" : "s…") };
    if (malformed) return { state: "malformed", message: malformed + " selected resource" + (malformed === 1 ? " is" : "s are") + " malformed for " + view + "." };
    if (failures.length) return { state: "error", message: "Could not load selected " + view + " resources — " + failures[0] };
    if (!selected) return { state: "empty", message: "No " + view + " items are selected. Use the Project navigator to select one." };
    if (!loaded) return { state: "empty", message: "The selected items contain no " + view + " resource." };
    if (!drawable) return { state: "empty", message: "The selected " + view + " resources contain no drawable data." };
    return { state: "ready", message: "" };
  }

  function ensureWorkspaceTab(tab) {
    if (!W) return;
    var view = workspaceViewName(tab);
    if (!workspaceHasView(view)) return;
    var hasLoaded = false;
    W.order.forEach(function (id) {
      if (!workspaceItemVisible(id, view) || !workspaceItemHasView(id, view)) return;
      var lane = workspaceLane(id, view);
      var detail = workspaceDetail(id, view);
      if (workspaceResource(id, view, lane, detail)) hasLoaded = true;
      else loadWorkspaceResource(id, view, lane, false, null, detail);
    });
    if (hasLoaded) composeWorkspaceView(view);
    exposeWorkspaceState();
  }

  function workspaceItemHasView(id, view) {
    var item = W && W.items[id];
    return !!(item && !item.disabled && (item.views || []).indexOf(view) >= 0);
  }
  function workspaceViewSupportsSelectionControls(view) {
    return view === "map" || view === "scene3d" || view === "wells";
  }

  function resourceHref(id, view, lane, detail) {
    var item = W.items[id], spec = item.resources && item.resources[view];
    if (!spec || !spec.href) return null;
    return spec.href + (lane == null ? "" : "&lane=" + encodeURIComponent(lane))
      + (detail == null ? "" : "&detail=" + encodeURIComponent(detail));
  }

  function scheduleWorkspacePanel() {
    if (W.panelTimer) return;
    W.panelTimer = setTimeout(function () {
      W.panelTimer = null; exposeWorkspaceState(); buildWorkspaceNavigator(); buildPanel();
    }, 0);
  }

  function scheduleWorkspaceCompose(view) {
    if (W.composeTimers[view]) return;
    W.composeTimers[view] = setTimeout(function () {
      delete W.composeTimers[view]; composeWorkspaceView(view);
    }, 0);
  }

  function loadFullAfterPreviewReady(id, view, lane) {
    var checks = 0;
    function check() {
      var status = window.__PETEK_SCENE3D_STATUS;
      if (status && status.state === "ok" && status.detail === "preview") {
        loadWorkspaceResource(id, view, lane, false, null, "full", true); return;
      }
      if (++checks < 1800 && workspaceDetail(id, view) === "preview") {
        setTimeout(check, 16);
      }
    }
    requestAnimationFrame(check);
  }

  function loadWorkspaceResource(id, view, lane, retry, fallbackLane, detail, background) {
    if (!W || !workspaceItemHasView(id, view)) return;
    if (detail === undefined) detail = workspaceDetail(id, view);
    var key = workspaceRequestKey(id, view, lane, detail);
    if (workspaceResource(id, view, lane, detail) && !retry) { composeWorkspaceView(view); return; }
    if (W.loading[key]) return;
    delete W.errors[key];
    if (App.mode === "file") {
      if (!workspaceResource(id, view, lane, detail)) {
        W.errors[key] = (W.manifest.snapshot && W.manifest.snapshot.message) || "Resource was not embedded in this static snapshot.";
        if (fallbackLane != null && workspaceLane(id, view) === lane) W.activeLane[id][view] = fallbackLane;
        scheduleWorkspacePanel();
      } else composeWorkspaceView(view);
      return;
    }
    var href = resourceHref(id, view, lane, detail);
    if (!href) { W.errors[key] = "No resource link declared."; scheduleWorkspacePanel(); return; }
    W.loading[key] = { view: view, lane: lane, detail: detail, background: !!background }; W.fetches++; scheduleWorkspacePanel();
    fetch(href)
      .then(function (r) { if (!r.ok) return r.text().then(function (t) { throw new Error(t || ("HTTP " + r.status)); }); return r.json(); })
      .then(function (resource) {
        if (!resource || resource.kind !== "workspace_resource") throw new Error("invalid workspace resource envelope");
        if (resource.item_id !== id || resource.view !== view || (resource.lane == null ? null : resource.lane) !== lane || (resource.detail == null ? null : resource.detail) !== detail) {
          throw new Error("workspace resource identity/lane/detail mismatch");
        }
        storeWorkspaceResource(id, view, resource);
        delete W.loading[key];
        if (detail === "full" && W.activeDetail[id]) W.activeDetail[id][view] = "full";
        scheduleWorkspaceCompose(view);
        var spec = W.items[id].resources && W.items[id].resources[view];
        if (detail === "preview" && spec && (spec.tiers || []).some(function (tier) { return tier.id === "full"; })) {
          setTimeout(function () { loadFullAfterPreviewReady(id, view, lane); }, 0);
        }
      })
      .catch(function (e) {
        delete W.loading[key];
        if (background) W.detailErrors[key] = String((e && e.message) || e);
        else W.errors[key] = String((e && e.message) || e);
        if (fallbackLane != null && workspaceLane(id, view) === lane) W.activeLane[id][view] = fallbackLane;
        scheduleWorkspacePanel();
      });
  }

  function virtualConcat(values) {
    var parts = [], start = 0;
    values.forEach(function (value) {
      if (!value || !value.length) return;
      parts.push({ value: value, start: start, end: start + value.length });
      start += value.length;
    });
    if (!parts.length) return [];
    if (parts.length === 1) return parts[0].value;
    return { length: start, parts: parts };
  }

  function cloneStamped(value, id) {
    var out = Object.assign({}, value);
    if (!out.item_id) out.item_id = id;
    return out;
  }

  function composeWorkspaceView(view) {
    if (!W) return;
    if (view === "map") composeWorkspaceMap();
    else if (view === "scene3d") composeWorkspaceScene3d();
    else if (view === "wells") composeWorkspaceWells();
    W.compositions++; exposeWorkspaceState();
    buildWorkspaceNavigator(); buildPanel(); if (workspaceViewName(App.tab) === view) renderActive();
  }

  function composeWorkspaceMap() {
    var entries = [];
    W.order.forEach(function (id) {
      if (!workspaceItemVisible(id, "map")) return;
      var r = workspaceResource(id, "map", workspaceLane(id, "map"), workspaceDetail(id, "map"));
      if (r && r.payload && r.payload.map) entries.push({ id: id, payload: r.payload });
    });
    if (!entries.length) {
      App.payload.map = null; App.payload.wells = []; refreshWorkspaceMapState();
      repaintWorkspaceView("map"); return;
    }
    // Decode sources serially: a later resource can reuse digests populated by
    // an earlier one instead of racing a duplicate worker request.
    var next = 0;
    function decodeNext() {
      while (next < entries.length) {
        var entry = entries[next++], m = entry.payload.map;
        if (m.blocks && !m.__blocksReady) {
          decodeMap2d(entry.payload, decodeNext); return;
        }
      }
      composeWorkspaceMapReady(entries);
    }
    decodeNext();
  }

  function composeWorkspaceMapReady(entries) {
    var pointParts = [], gridParts = [], gridLodParts = [];
    var map = {
      schema_version: 2, frame: null, outline: [], grid_lines: [], points: [],
      point_color: null, colormap: null, layers: [], fills: [], contours: [],
      horizons: [], zone_averages: [], k_slices: [], contacts: [], wells: [],
      well_overlays: [], __wellOverlaySources: [], items: [],
      __blocksReady: true,
    };
    var wells = [], pointOffset = 0;
    entries.forEach(function (entry) {
      var id = entry.id, m = entry.payload.map;
      if (!map.frame && m.frame) map.frame = m.frame;
      if (!map.point_color && m.point_color) map.point_color = m.point_color;
      if (!map.colormap && m.colormap) map.colormap = m.colormap;
      pointParts.push(m.points); gridParts.push(m.grid_lines); gridLodParts.push(m.grid_lines_lod);
      (m.outline || []).forEach(function (v) { map.outline.push(v); });
      (m.fills || []).forEach(function (v) {
        var fill = cloneStamped(v, id);
        // The composed map intentionally has no block table of its own. Keep a
        // reference to the producing map so inactive attribute lanes retain
        // the existing content-addressed lazy decoder and deduplication path.
        fill.__workspaceMap = m;
        map.fills.push(fill);
      });
      (m.contours || []).forEach(function (v) { map.contours.push(cloneStamped(v, id)); });
      // Context identities are producer-declared stable workspace IDs. Keep
      // overlay records byte-for-byte; the Map renderer validates and selects
      // them against the active fill without another provider request.
      (m.well_overlays || []).forEach(function (v) {
        map.well_overlays.push(v); map.__wellOverlaySources.push(id);
      });
      ["horizons", "zone_averages", "k_slices", "contacts"].forEach(function (name) {
        (m[name] || []).forEach(function (v) { map[name].push(cloneStamped(v, id)); });
      });
      (m.layers || []).forEach(function (v) {
        var layer = cloneStamped(v, id);
        if (layer.kind === "points") layer.start = (layer.start || 0) + pointOffset;
        map.layers.push(layer);
      });
      map.items.push({ id: id });
      pointOffset += m.points ? m.points.length : 0;
      (entry.payload.wells || []).forEach(function (v) { wells.push(cloneStamped(v, id)); });
    });
    map.points = virtualConcat(pointParts); map.grid_lines = virtualConcat(gridParts);
    var lod = virtualConcat(gridLodParts); if (lod.length) map.grid_lines_lod = lod;
    App.payload.map = map; App.payload.wells = wells;
    refreshWorkspaceMapState();
    repaintWorkspaceView("map");
  }

  function repaintWorkspaceView(view) {
    exposeWorkspaceState();
    if (workspaceViewName(App.tab) !== view) return;
    buildPanel(); renderActive();
  }

  function refreshWorkspaceMapState() {
    if (typeof S === "undefined") return;
    var m = App.payload.map || {};
    S.mapLayers = []
      .concat((m.horizons || []).map(function (l) { return tagLayer(l, "horizon"); }))
      .concat((m.zone_averages || []).map(function (l) { return tagLayer(l, "property"); }))
      .concat((m.k_slices || []).map(function (l) { return tagLayer(l, "property"); }));
    S.mapLayerIdx = Math.min(S.mapLayerIdx || 0, Math.max(0, S.mapLayers.length - 1));
    S.mapFillIdx = Math.min(S.mapFillIdx || 0, Math.max(0, (m.fills || []).length - 1));
    var pointSegments = (m.layers || []).filter(function (entry) {
      return entry.kind === "points" && entry.start != null && entry.n != null;
    });
    S.pointLayerVis = (pointSegments.length ? pointSegments : ((m.points || []).length ? [null] : []))
      .map(function (_, i) { return S.pointLayerVis && S.pointLayerVis[i] !== undefined ? S.pointLayerVis[i] : true; });
    S.showPoints = S.pointLayerVis.some(function (visible) { return visible; });
    if (!S.mapGridDefaultApplied && App.payload.map) {
      S.showGridLines = !(m.fills && m.fills.length) || (m.layers || []).some(function (layer) {
        return layer.kind === "lines" && layer.standalone === true;
      });
      S.mapGridDefaultApplied = true;
    }
    S.contactVis = (m.contacts || []).map(function () { return true; });
    S.wellVis = (App.payload.wells || []).map(function (w) { return workspaceItemVisible(w.item_id, "map"); });
  }

  function composeWorkspaceScene3d() {
    var entries = [];
    W.order.forEach(function (id) {
      var r = workspaceResource(id, "scene3d", workspaceLane(id, "scene3d"), workspaceDetail(id, "scene3d"));
      if (r && r.payload && r.payload.scene3d) entries.push({ id: id, scene: r.payload.scene3d, detail: r.detail || null });
    });
    if (!entries.length) { App.payload.scene3d = null; s3dBuilt = null; return; }
    var scene = { schema_version: 1, points: [], meshes: [], lattices: [], contours: [], wells: [], outlines: [], layers: [], point_color: null, colormap: null, z_exaggeration: 5, ref_z: 0,
      detail: entries.every(function (entry) { return entry.detail === "full"; }) ? "full" : (entries.some(function (entry) { return entry.detail === "preview"; }) ? "preview" : null) };
    entries.forEach(function (entry) {
      var sc = entry.scene;
      ["points", "meshes", "lattices", "contours", "wells", "layers"].forEach(function (name) {
        (sc[name] || []).forEach(function (value) { scene[name].push(cloneStamped(value, entry.id)); });
      });
      (sc.outlines || []).forEach(function (value) {
        if (Array.isArray(value)) scene.outlines.push({ points: value, item_id: entry.id });
        else scene.outlines.push(cloneStamped(value, entry.id));
      });
      if (!scene.point_color && sc.point_color) scene.point_color = sc.point_color;
      if (!scene.colormap && sc.colormap) scene.colormap = sc.colormap;
      scene.z_exaggeration = sc.z_exaggeration || scene.z_exaggeration;
      scene.ref_z = sc.ref_z == null ? scene.ref_z : sc.ref_z;
    });
    App.payload.scene3d = scene; S.s3dExag = scene.z_exaggeration;
    if (!S.s3dLatticeDefaultApplied) {
      S.s3dShow.lattice = !scene.meshes.length || scene.layers.some(function (layer) {
        return layer.kind === "lines" && layer.standalone === true;
      });
      S.s3dLatticeDefaultApplied = true;
    }
    if (!(scene.detail === "full" && s3dBuilt && s3dBuilt._detail === "preview")) s3dBuilt = null;
    var tab = document.querySelector('.tab[data-tab="scene3d"]'); if (tab) tab.hidden = false;
  }

  function composeWorkspaceWells() {
    var bundles = [];
    W.order.forEach(function (id) {
      var r = workspaceResource(id, "wells", workspaceLane(id, "wells"), workspaceDetail(id, "wells"));
      if (r && r.payload && r.payload.wells_logs) bundles.push({ id: id, bundle: r.payload.wells_logs });
    });
    if (!bundles.length) {
      App.payload.wells_logs = null; S.wl = null; S.wlVis = []; return;
    }
    var out = { kind: "wells_logs", schema_version: 4, wells: [], template: null, flatten_default: null };
    bundles.forEach(function (entry) {
      var b = entry.bundle;
      (b.wells || []).forEach(function (well) { out.wells.push(cloneStamped(well, entry.id)); });
      if (!out.template && b.template) out.template = b.template;
      if (!out.flatten_default && b.flatten_default) out.flatten_default = b.flatten_default;
    });
    var old = S.wl;
    App.payload.wells_logs = out; initWellsState(App.payload);
    if (old && S.wl) { S.wl.hang = old.hang; S.wl.pick = old.pick; }
    if (S.wl) S.wl.wells.forEach(function (well, i) {
      S.wlVis[i] = workspaceItemVisible(well.item_id, "wells");
    });
    repaintWorkspaceView("wells");
  }

  function setWorkspaceVisible(id, view, visible) {
    if (!W || !W.visible[id]) return;
    W.visible[id][view] = visible;
    var lane = workspaceLane(id, view), detail = workspaceDetail(id, view);
    if (visible && !workspaceResource(id, view, lane, detail)) loadWorkspaceResource(id, view, lane, false, null, detail);
    else if (view === "map") composeWorkspaceMap();
    else if (view === "scene3d") { applyScene3dVisibility(); if (s3d) s3d.render(); }
    else if (view === "wells" && S.wl) {
      S.wl.wells.forEach(function (well, i) { if (well.item_id === id) S.wlVis[i] = visible; });
      renderWells();
    }
    exposeWorkspaceState(); buildWorkspaceNavigator(); buildPanel();
  }

  function setWorkspaceViewSelection(view, selectedIds) {
    if (!W) return;
    var selected = {};
    (selectedIds || []).forEach(function (id) { selected[id] = true; });
    var any = false;
    W.order.forEach(function (id) {
      if (!workspaceItemHasView(id, view)) return;
      W.visible[id][view] = !!selected[id]; any = any || !!selected[id];
    });
    exposeWorkspaceState(); buildWorkspaceNavigator(); buildPanel();
    if (workspaceViewName(App.tab) !== view) return;
    if (any) ensureWorkspaceTab(App.tab);
    else if (view === "map") composeWorkspaceMap();
    else if (view === "scene3d") { applyScene3dVisibility(); if (s3d) s3d.render(); }
    else if (view === "wells") composeWorkspaceWells();
  }

  function setWorkspaceLane(id, view, lane) {
    if (!W || !W.activeLane[id] || workspaceLane(id, view) === lane) return;
    var previous = workspaceLane(id, view);
    W.activeLane[id][view] = lane;
    if (W.activeColorBy[id]) W.activeColorBy[id][view] = lane;
    var spec = W.items[id].resources && W.items[id].resources[view];
    if (spec && spec.tiers && spec.tiers.length) W.activeDetail[id][view] = spec.active_detail || spec.tiers[0].id;
    var detail = workspaceDetail(id, view);
    if (workspaceItemVisible(id, view)) {
      if (workspaceResource(id, view, lane, detail)) composeWorkspaceView(view);
      else loadWorkspaceResource(id, view, lane, false, previous, detail);
    }
    exposeWorkspaceState(); buildWorkspaceNavigator(); buildPanel();
  }

  function workspaceDescendantItems(node, view, out) {
    if (node.children) node.children.forEach(function (child) { workspaceDescendantItems(child, view, out); });
    else if ((node.views || []).indexOf(view) >= 0) out.push(node.id);
  }

  function workspaceSearchText(node) {
    return W.searchText[node.id] || String(node.label || "").toLowerCase();
  }

  // Explicit kind registry: icons encode kind; categorical colour remains
  // reserved for stable entity identity. Unknown roles are a geometric dot,
  // never a truncated text badge.
  var WORKSPACE_ICON_SVGS = {
    surface: '<path stroke d="M1.5 10.5c2-2.6 4-2.6 6 0s4 2.6 6 0"/><path stroke d="M1.5 6.5c2-2.6 4-2.6 6 0s4 2.6 6 0" opacity=".55"/>',
    points: '<circle fill cx="3.6" cy="11.4" r="1.25"/><circle fill cx="7.2" cy="5.6" r="1.25"/><circle fill cx="11.6" cy="9.2" r="1.25"/><circle fill cx="12.6" cy="3.9" r="1.25"/><circle fill cx="6.4" cy="12.6" r="1.25" opacity=".5"/>',
    bore: '<path stroke d="M8 1.8v6.4c0 2.4 1.4 3.7 3.6 4.6"/><circle fill cx="8" cy="1.8" r="1.5"/>',
    well: '<path stroke d="M8 2v5"/><circle fill cx="8" cy="2" r="1.4"/><path stroke d="M8 7c0 2.6 1.3 4 3.4 5.2" opacity=".9"/><path stroke d="M8 7c0 2.6-1.3 4-3.4 5.2" opacity=".45"/>',
    folderClosed: '<path class="workspace-folder-body" d="M1.8 12.2V4.4a.9.9 0 0 1 .9-.9h3.1l1.5 1.7h6a.9.9 0 0 1 .9.9v6.1a.9.9 0 0 1-.9.9H2.7a.9.9 0 0 1-.9-.9Z"/><path stroke d="M1.8 12.2V4.4a.9.9 0 0 1 .9-.9h3.1l1.5 1.7h6a.9.9 0 0 1 .9.9v6.1a.9.9 0 0 1-.9.9H2.7a.9.9 0 0 1-.9-.9Z"/><path stroke d="M1.8 6.6h12.4" opacity=".45"/>',
    folderOpen: '<path class="workspace-folder-body" d="M1.8 12.2 3.6 7.6a.9.9 0 0 1 .85-.6h9.6a.55.55 0 0 1 .52.74l-1.6 4.3a.9.9 0 0 1-.85.6H2.7a.9.9 0 0 1-.9-.9Z"/><path stroke d="M1.8 12.2V4.4a.9.9 0 0 1 .9-.9h3.1l1.5 1.7h5.1a.9.9 0 0 1 .9.9v1.1"/><path stroke d="M1.8 12.2 3.6 7.6a.9.9 0 0 1 .85-.6h9.6a.55.55 0 0 1 .52.74l-1.6 4.3a.9.9 0 0 1-.85.6H2.7a.9.9 0 0 1-.9-.9Z"/>',
    tops: '<rect stroke x="2" y="2.6" width="12" height="10.8" rx="1"/><path stroke d="M2 6.1h12M6.3 6.1v7.3"/>',
    grid: '<path stroke d="M2 5.2 8 2.2l6 3-6 3-6-3Z"/><path stroke d="M2 8.2 8 11.2l6-3M2 11 8 14l6-3" opacity=".5"/>',
    polygon: '<path stroke d="M3.2 4.1 8.6 2.2l4.4 4-1.7 5.6-5.9.9-2.9-4.3Z"/><circle fill cx="3.2" cy="4.1" r="1.15"/><circle fill cx="13" cy="6.2" r="1.15"/><circle fill cx="5.4" cy="12.7" r="1.15"/>',
    log: '<path stroke d="M4 2.2v11.6M12 2.2v11.6" opacity=".35"/><path stroke d="M8 2.4c-2.3 1.1-2.3 2.6 0 3.7s2.3 2.6 0 3.7-2.3 2.6 0 3.8"/>',
    zone: '<rect fill x="2" y="3" width="12" height="2.6" rx=".5" opacity=".9"/><rect fill x="2" y="6.7" width="12" height="2.6" rx=".5" opacity=".55"/><rect fill x="2" y="10.4" width="12" height="2.6" rx=".5" opacity=".3"/>',
    chart: '<path stroke d="M2 13V3M2 13h12"/><path stroke d="M4.6 10.6 7 7.4l2.5 2 3.4-4.6"/>',
    unknown: '<circle fill cx="8" cy="8" r="2.2"/>',
  };
  var WORKSPACE_ICON_ROLES = {
    surface: "surface", point: "points", points: "points", point_set: "points",
    bore: "bore", wellbore: "bore", well: "well", folder: "folder",
    well_top: "tops", source_top: "tops", tops: "tops", top_table: "tops",
    grid: "grid", volume: "grid", polygon: "polygon", log: "log", curve: "log",
    zone: "zone", chart: "chart",
  };
  function workspaceIcon(role, expanded) {
    var key = WORKSPACE_ICON_ROLES[String(role || "").toLowerCase()] || "unknown";
    var sourceKey = key === "folder" ? (expanded ? "folderOpen" : "folderClosed") : key;
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("data-workspace-icon", key);
    svg.setAttribute("class", "workspace-icon" + (key === "folder" ? " workspace-icon-folder" : ""));
    svg.innerHTML = WORKSPACE_ICON_SVGS[sourceKey];
    return svg;
  }
  function workspaceGroupRole(node) {
    var children = node.children || [];
    if (children.length > 1 && children.every(function (child) { return !child.children && child.role === "bore"; })) return "well";
    return node.role || "folder";
  }
  function workspaceSingleBore(node) {
    return !!(node && node.children && node.children.length === 1
      && !node.children[0].children && node.children[0].role === "bore");
  }
  function workspaceBoreGroup(node) {
    return !!(node && node.children && node.children.length
      && node.children.every(function (child) { return !child.children && child.role === "bore"; }));
  }
  function workspaceRails(entry) {
    var rails = el("span", "workspace-rails");
    (entry.rails || []).forEach(function (rail) {
      var cls = "workspace-rail";
      if (rail.active) cls += " workspace-rail-active";
      if (rail.last) cls += " workspace-rail-last";
      if (rail.gap) cls += " workspace-rail-gap";
      rails.appendChild(el("span", cls));
    });
    return rails;
  }
  function workspaceTwist(expanded, label, onclick) {
    var twist = el("button", "workspace-twist"); twist.type = "button";
    twist.innerHTML = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    twist.setAttribute("aria-label", (expanded ? "Collapse " : "Expand ") + label);
    twist.setAttribute("aria-expanded", expanded ? "true" : "false"); twist.onclick = onclick;
    return twist;
  }
  function workspaceLeafTwist() {
    var spacer = el("span", "workspace-twist workspace-twist-leaf"); spacer.setAttribute("aria-hidden", "true"); return spacer;
  }
  function workspaceSpinner() {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "workspace-spinner"); svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = '<path d="M8 1.7a6.3 6.3 0 1 1-6.3 6.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    return svg;
  }
  function workspacePaintMark(colorLabel, attributeLabel) {
    var mark = el("span", "workspace-paint");
    mark.title = "Coloured by " + colorLabel + ", not " + attributeLabel;
    mark.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 12.6c0-1.7 1.2-2.4 2.3-2.4 1.2 0 2 .8 2 1.9 0 1.4-1.3 2.3-2.9 2.3-1.9 0-3.3-1.4-3.3-3.4 0-3.2 3.1-5.6 6.4-5.6 3 0 5 1.9 5 4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
    return mark;
  }
  function workspaceIsolateButton(ids, view, label) {
    var button = el("button", "workspace-isolate"); button.type = "button"; button.title = "Isolate " + label + " in " + view;
    button.setAttribute("aria-label", button.title);
    button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.6 8S3.9 3.9 8 3.9 14.4 8 14.4 8 12.1 12.1 8 12.1 1.6 8 1.6 8Z"/><circle cx="8" cy="8" r="1.9"/></svg>';
    button.onclick = function () { setWorkspaceViewSelection(view, ids); };
    return button;
  }

  function buildWorkspaceTree(body) {
    if (!W) return;
    var started = performance.now();
    var view = workspaceViewName(App.tab), selectionSupported = workspaceViewSupportsSelectionControls(view);
    var groupEl = el("div", "workspace-project");
    var search = el("input", "workspace-search"); search.type = "search";
    search.placeholder = "Search project"; search.value = W.query; search.setAttribute("aria-label", "Search project");
    search.addEventListener("input", function () {
      W.query = search.value.toLowerCase();
      var caret = search.selectionStart;
      if (W.searchTimer) clearTimeout(W.searchTimer);
      W.searchTimer = setTimeout(function () {
        W.searchTimer = null; buildWorkspaceNavigator();
        var next = document.querySelector("#navigator .workspace-search");
        if (next) { next.focus(); next.setSelectionRange(caret, caret); }
      }, 80);
    });
    groupEl.appendChild(search);
    var tree = el("div", "workspace-tree");
    tree.setAttribute("role", "tree"); tree.setAttribute("aria-label", "Project items");
    tree.setAttribute("aria-multiselectable", "true");
    // The virtual window is sized from this rendered viewport. Attach before
    // reading clientHeight/computed tokens; a detached tree reports zero.
    groupEl.appendChild(tree); body.appendChild(groupEl);
    var flat = [];
    function compactChain(node) {
      var chain = [node], tail = node;
      while (tail.children && tail.children.length === 1 && tail.children[0].children) {
        var child = tail.children[0];
        // A well folder is semantic: one bore collapses into the well row and
        // multiple bores must retain their own explicit parent/twisty.
        if (workspaceBoreGroup(child)) break;
        // Mixed explicit/manual disclosure states need separate controls; only
        // collapse a semantically identical singleton chain into a breadcrumb.
        if (!!W.expanded[tail.id] !== !!W.expanded[child.id]) break;
        chain.push(child); tail = child;
      }
      return { chain: chain, tail: tail };
    }
    function flatten(node, depth, ancestorRails, isLast) {
      var matches = !W.query || workspaceSearchText(node).indexOf(W.query) >= 0;
      var rails = (ancestorRails || []).slice();
      if (depth > 0) rails.push({ active: true, last: !!isLast });
      if (node.children) {
        var childMatches = node.children.some(function (child) { return subtreeMatches(child); });
        if (!matches && !childMatches) return;
        if (workspaceSingleBore(node)) {
          flat.push({ node: node.children[0], label: node.label, depth: depth,
            rails: rails, collapsedBore: true });
          return;
        }
        var compacted = W.query ? { chain: [node], tail: node } : compactChain(node);
        flat.push({ node: compacted.tail, chain: compacted.chain, depth: depth, rails: rails });
        if (W.expanded[compacted.tail.id] || W.query) {
          var nextRails = (ancestorRails || []).slice();
          if (depth > 0) nextRails.push({ gap: !!isLast });
          compacted.tail.children.forEach(function (child, index, children) {
            flatten(child, depth + 1, nextRails, index === children.length - 1);
          });
        }
      } else if (matches) {
        flat.push({ node: node, depth: depth, rails: rails });
      }
    }
    function subtreeMatches(node) {
      if (!W.query || workspaceSearchText(node).indexOf(W.query) >= 0) return true;
      return !!(node.children && node.children.some(subtreeMatches));
    }
    function draw(entry, target) {
      var node = entry.node, depth = entry.depth, chain = entry.chain || [node];
      if (node.children) {
        var ids = []; workspaceDescendantItems(node, view, ids);
        var checked = ids.filter(function (id) { return workspaceItemVisible(id, view); }).length;
        var row = el("div", "workspace-row workspace-group");
        var groupLabel = chain.map(function (group) { return group.label; }).join(" › ");
        row.setAttribute("role", "treeitem"); row.setAttribute("aria-level", String(depth + 1));
        row.setAttribute("aria-expanded", W.expanded[node.id] ? "true" : "false"); row.dataset.workspaceId = node.id;
        row.tabIndex = W.focusedTreeId === node.id ? 0 : -1;
        row.addEventListener("focus", function () { W.focusedTreeId = node.id; });
        var twist = workspaceTwist(!!W.expanded[node.id], groupLabel, function () {
          var next = !W.expanded[node.id];
          chain.forEach(function (group) { W.expanded[group.id] = next; W.expansionManual[group.id] = true; });
          W.focusedTreeId = node.id; W.restoreTreeFocus = true;
          buildWorkspaceNavigator();
        });
        var cb;
        if (selectionSupported) {
          cb = el("input"); cb.type = "checkbox"; cb.checked = ids.length > 0 && checked === ids.length;
          cb.indeterminate = checked > 0 && checked < ids.length; cb.disabled = !ids.length;
          cb.setAttribute("aria-label", "Show " + groupLabel + " in " + view);
          cb.onchange = function () {
            var toggleStarted = performance.now(), next = cb.checked;
            ids.forEach(function (id) { W.visible[id][view] = cb.checked; });
            row.querySelector(".workspace-count").textContent = (next ? ids.length : 0) + "/" + ids.length;
            tree.querySelectorAll("input[data-workspace-item]").forEach(function (input) {
              input.checked = workspaceItemVisible(input.dataset.workspaceItem, view);
            });
            W.groupToggleMs.push(performance.now() - toggleStarted);
            exposeWorkspaceState();
            setTimeout(function () {
              if (next) ensureWorkspaceTab(App.tab);
              else if (view === "map") composeWorkspaceMap();
              else if (view === "scene3d") { applyScene3dVisibility(); if (s3d) s3d.render(); }
              else if (view === "wells") composeWorkspaceWells();
            }, 0);
          };
        } else cb = el("span", "workspace-checkbox-spacer");
        var meta = el("span", "workspace-meta");
        if (selectionSupported) meta.appendChild(el("span", "workspace-count", checked + "/" + ids.length));
        if (ids.length && selectionSupported) {
          meta.appendChild(workspaceIsolateButton(ids.slice(), view, groupLabel));
        }
        row.appendChild(workspaceRails(entry)); row.appendChild(twist); row.appendChild(cb);
        row.appendChild(workspaceIcon(workspaceGroupRole(node), !!W.expanded[node.id]));
        row.appendChild(el("span", "workspace-label", groupLabel)); row.appendChild(meta); target.appendChild(row);
      } else {
        var has = !node.disabled && (node.views || []).indexOf(view) >= 0, lane = workspaceLane(node.id, view), detail = workspaceDetail(node.id, view);
        var key = workspaceRequestKey(node.id, view, lane, detail);
        var selected = has && workspaceItemVisible(node.id, view);
        var displayLabel = entry.label || node.label;
        var row = el("div", "workspace-row workspace-object" + (selected ? " workspace-selected" : "")
          + (W.loading[key] ? " workspace-loading" : "") + (W.errors[key] ? " workspace-error" : "")
          + (!has ? " workspace-unavailable" : ""));
        row.setAttribute("role", "treeitem"); row.setAttribute("aria-level", String(depth + 1));
        row.setAttribute("aria-selected", selected ? "true" : "false"); row.dataset.workspaceId = node.id;
        row.tabIndex = W.focusedTreeId === node.id ? 0 : -1;
        row.addEventListener("focus", function () { W.focusedTreeId = node.id; });
        if (entry.collapsedBore) row.dataset.collapsedBore = "true";
        var cb;
        if (selectionSupported) {
          cb = el("input"); cb.type = "checkbox"; cb.checked = has && workspaceItemVisible(node.id, view); cb.disabled = !has;
          cb.setAttribute("aria-label", (has ? "Show " : "Unavailable: ") + displayLabel + " in " + view);
          cb.dataset.workspaceItem = node.id;
          cb.onchange = function () { setWorkspaceVisible(node.id, view, cb.checked); };
        } else cb = el("span", "workspace-checkbox-spacer");
        row.appendChild(workspaceRails(entry)); row.appendChild(workspaceLeafTwist()); row.appendChild(cb);
        row.appendChild(workspaceIcon(node.role, false));
        var label = el("span", "workspace-label" + (!has ? " workspace-disabled" : ""), displayLabel);
        if (node.reason) label.title = node.reason;
        row.appendChild(label);
        if (node.role === "bore") {
          var dot = el("span", "workspace-identity-dot"); dot.style.background = idColor("item:" + node.id); row.appendChild(dot);
        }
        var meta = el("span", "workspace-meta");
        var spec = node.resources && node.resources[view];
        if (has && spec && spec.lanes && spec.lanes.length > 1) {
          var select = el("select", "workspace-lane-select");
          spec.lanes.forEach(function (entry) {
            var option = el("option", null, entry.label); option.value = entry.id; select.appendChild(option);
          });
          select.value = lane;
          select.title = "Active attribute (sets geometry, resets colour)"; select.setAttribute("aria-label", "Active attribute for " + displayLabel);
          select.onchange = function () { setWorkspaceLane(node.id, view, select.value); };
          meta.appendChild(select);
          var colorBy = workspaceColorBy(node.id, view);
          if (colorBy != null && colorBy !== lane) {
            var labels = {}; spec.lanes.forEach(function (candidate) { labels[candidate.id] = candidate.label; });
            meta.appendChild(workspacePaintMark(labels[colorBy] || colorBy, labels[lane] || lane));
          }
        }
        if (W.loading[key]) { meta.appendChild(workspaceSpinner()); meta.appendChild(el("span", "workspace-status", "loading")); }
        if (W.errors[key]) {
          if (App.mode === "file") {
            var offline = el("span", "workspace-status", "offline"); offline.title = W.errors[key]; meta.appendChild(offline);
          } else {
            var retry = el("button", "workspace-retry", "retry"); retry.title = W.errors[key];
            retry.setAttribute("aria-label", "Retry " + displayLabel); retry.onclick = function () { loadWorkspaceResource(node.id, view, lane, true, null, detail); }; meta.appendChild(retry);
          }
        } else if (!has && node.reason) {
          var unavailable = el("span", "workspace-status", node.reason);
          unavailable.title = node.reason; meta.appendChild(unavailable);
        }
        if (has && selectionSupported) {
          meta.appendChild(workspaceIsolateButton([node.id], view, displayLabel));
        }
        row.appendChild(meta); target.appendChild(row);
      }
    }
    (W.manifest.tree || []).forEach(function (node, index, roots) {
      flatten(node, 0, [], index === roots.length - 1);
    });
    if (flat.length && !flat.some(function (entry) { return entry.node.id === W.focusedTreeId; })) {
      W.focusedTreeId = flat[0].node.id;
    }
    if (!flat.length) {
      tree.appendChild(el("div", "workspace-region-state", W.query
        ? "No project items match this search." : "This workspace has no catalogued items."));
    }
    var rowHeight = 0, renderVirtualWindow = null;
    if (flat.length <= 160) {
      flat.forEach(function (entry) { draw(entry, tree); });
      tree.scrollTop = W.treeScrollTop || 0;
    } else {
      // Keep search and bulk toggles within one frame for project-scale trees.
      // The canonical flat list remains complete; only the scroll window owns
      // DOM rows, so 2,000+ leaves do not turn each panel rebuild into layout
      // work proportional to the project size.
      rowHeight = parseFloat(getComputedStyle(tree).getPropertyValue("--row-h"));
      if (!(rowHeight > 0) || !isFinite(rowHeight)) {
        // CSS owns the row geometry. This probe is only a defensive fallback
        // for an embedding page that strips the token; it introduces no second
        // hard-coded row-height source.
        var probe = el("div", "workspace-row");
        probe.style.cssText = "position:absolute;visibility:hidden";
        tree.appendChild(probe); rowHeight = probe.getBoundingClientRect().height;
        tree.removeChild(probe);
      }
      if (!(rowHeight > 0) || !isFinite(rowHeight)) rowHeight = 1;
      var overscan = 8;
      tree.classList.add("workspace-tree-virtual");
      var spacer = el("div", "workspace-tree-spacer");
      spacer.style.height = (flat.length * rowHeight) + "px";
      var layer = el("div", "workspace-tree-window");
      tree.appendChild(spacer); tree.appendChild(layer);
      renderVirtualWindow = function () {
        var viewportRows = Math.max(1, Math.ceil(tree.clientHeight / rowHeight));
        var first = Math.max(0, Math.floor(tree.scrollTop / rowHeight) - overscan);
        var last = Math.min(flat.length, first + viewportRows + overscan * 2);
        layer.innerHTML = ""; layer.style.transform = "translateY(" + (first * rowHeight) + "px)";
        for (var i = first; i < last; i++) draw(flat[i], layer);
      };
      tree.scrollTop = W.treeScrollTop || 0;
      tree.addEventListener("scroll", function () {
        W.treeScrollTop = tree.scrollTop; renderVirtualWindow();
      }, { passive: true });
      if (typeof ResizeObserver !== "undefined") {
        W.treeResizeObserver = new ResizeObserver(renderVirtualWindow);
        W.treeResizeObserver.observe(tree);
      }
      renderVirtualWindow();
    }
    function renderedTreeRow(id) {
      return Array.prototype.find.call(tree.querySelectorAll('[role="treeitem"]'), function (row) {
        return row.dataset.workspaceId === id;
      });
    }
    function syncTreeTabStops() {
      Array.prototype.forEach.call(tree.querySelectorAll('[role="treeitem"]'), function (row) {
        row.tabIndex = row.dataset.workspaceId === W.focusedTreeId ? 0 : -1;
      });
    }
    function focusFlatIndex(index) {
      if (!flat.length) return;
      index = Math.max(0, Math.min(flat.length - 1, index));
      W.focusedTreeId = flat[index].node.id;
      if (renderVirtualWindow) {
        var top = index * rowHeight, bottom = top + rowHeight;
        if (top < tree.scrollTop) tree.scrollTop = top;
        else if (bottom > tree.scrollTop + tree.clientHeight) tree.scrollTop = bottom - tree.clientHeight;
        W.treeScrollTop = tree.scrollTop; renderVirtualWindow();
      }
      syncTreeTabStops();
      var row = renderedTreeRow(W.focusedTreeId); if (row) row.focus();
    }
    function setGroupExpanded(entry, expanded) {
      (entry.chain || [entry.node]).forEach(function (group) {
        W.expanded[group.id] = expanded; W.expansionManual[group.id] = true;
      });
      W.focusedTreeId = entry.node.id; W.restoreTreeFocus = true;
      buildWorkspaceNavigator();
    }
    tree.addEventListener("keydown", function (event) {
      var row = event.target.closest && event.target.closest('[role="treeitem"]');
      if (!row || row.parentElement == null || event.target !== row) return;
      var index = flat.findIndex(function (entry) { return entry.node.id === row.dataset.workspaceId; });
      if (index < 0) return;
      var entry = flat[index], node = entry.node, key = event.key;
      if (key === "ArrowDown") { event.preventDefault(); focusFlatIndex(index + 1); }
      else if (key === "ArrowUp") { event.preventDefault(); focusFlatIndex(index - 1); }
      else if (key === "Home") { event.preventDefault(); focusFlatIndex(0); }
      else if (key === "End") { event.preventDefault(); focusFlatIndex(flat.length - 1); }
      else if (key === "ArrowRight" && node.children) {
        event.preventDefault();
        if (!W.expanded[node.id]) setGroupExpanded(entry, true);
        else if (index + 1 < flat.length && flat[index + 1].depth > entry.depth) focusFlatIndex(index + 1);
      } else if (key === "ArrowLeft") {
        event.preventDefault();
        if (node.children && W.expanded[node.id]) setGroupExpanded(entry, false);
        else {
          var parent = index - 1;
          while (parent >= 0 && flat[parent].depth >= entry.depth) parent--;
          if (parent >= 0) focusFlatIndex(parent);
        }
      } else if (key === "Enter" || key === " ") {
        event.preventDefault();
        if (node.children) setGroupExpanded(entry, !W.expanded[node.id]);
        else if (selectionSupported && workspaceItemHasView(node.id, view)) {
          W.focusedTreeId = node.id; W.restoreTreeFocus = true;
          setWorkspaceVisible(node.id, view, !workspaceItemVisible(node.id, view));
        }
      }
    });
    if (W.restoreTreeFocus && flat.length) {
      W.restoreTreeFocus = false;
      var restoreIndex = flat.findIndex(function (entry) { return entry.node.id === W.focusedTreeId; });
      focusFlatIndex(restoreIndex < 0 ? 0 : restoreIndex);
    }
    if (selectionSupported) {
      var viewLabels = { map: "Map", scene3d: "3-D", wells: "Wells" };
      var selectedInView = W.order.filter(function (id) {
        return workspaceItemHasView(id, view) && workspaceItemVisible(id, view);
      }).length;
      var footer = el("div", "workspace-tree-footer");
      var visibilityNote = el("span");
      visibilityNote.appendChild(document.createTextNode("Visibility applies to "));
      visibilityNote.appendChild(el("strong", null, viewLabels[view] || view));
      footer.appendChild(visibilityNote);
      var clear = el("button", "workspace-clear", "Clear all"); clear.type = "button";
      clear.disabled = selectedInView === 0;
      clear.title = "Clear all visible items in " + (viewLabels[view] || view);
      clear.onclick = function () { setWorkspaceViewSelection(view, []); };
      footer.appendChild(clear);
      groupEl.appendChild(footer);
    }
    exposeWorkspaceState();
    W.treeBuildMs.push(performance.now() - started); exposeWorkspaceState();
  }

  function buildWorkspaceNavigator() {
    if (!W) return;
    var body = document.getElementById("navigator-body");
    if (!body) return;
    var oldTree = body.querySelector(".workspace-tree");
    if (oldTree) W.treeScrollTop = oldTree.scrollTop;
    if (W.treeResizeObserver) { W.treeResizeObserver.disconnect(); W.treeResizeObserver = null; }
    body.innerHTML = "";
    buildWorkspaceTree(body);
  }
