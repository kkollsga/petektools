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
  function workspaceResourceSlot(view, lane) {
    return view + "\u0000" + (lane == null ? "" : String(lane));
  }
  function workspaceRequestKey(id, view, lane) {
    return id + "\u0000" + workspaceResourceSlot(view, lane);
  }
  function workspaceResource(id, view, lane) {
    return W && W.resources[id] && W.resources[id][workspaceResourceSlot(view, lane)];
  }
  function storeWorkspaceResource(id, view, resource) {
    if (!W.resources[id]) return;
    W.resources[id][workspaceResourceSlot(view, resource.lane)] = resource;
  }

  function initWorkspace(payload) {
    var manifest = payload && payload.workspace;
    if (!manifest) return;
    if (manifest.schema_version !== 1) throw new Error("unsupported workspace schema_version " + manifest.schema_version);
    W = {
      manifest: manifest, available: (manifest.available_views || []).slice(),
      order: [], items: {}, visible: {}, activeLane: {}, resources: {}, loading: {}, errors: {}, searchText: {},
      query: "", expanded: {}, fetches: 0, compositions: 0, searchTimer: null,
      treeBuildMs: [], groupToggleMs: [], panelTimer: null, composeTimers: {},
    };
    function visit(nodes) {
      (nodes || []).forEach(function (node) {
        var searchable = String(node.label || "") + " " + String(node.reason || "");
        if (node.diagnostic) {
          try { searchable += " " + JSON.stringify(node.diagnostic); } catch (_) {}
        }
        W.searchText[node.id] = searchable.toLowerCase();
        if (node.children) {
          W.expanded[node.id] = node.expanded !== false;
          visit(node.children);
        } else {
          W.order.push(node.id); W.items[node.id] = node;
          W.visible[node.id] = Object.assign({}, node.visible || {});
          W.activeLane[node.id] = {};
          Object.keys(node.resources || {}).forEach(function (view) {
            var spec = node.resources[view];
            if (spec && spec.lanes && spec.lanes.length) W.activeLane[node.id][view] = spec.active_lane || spec.lanes[0].id;
          });
          W.resources[node.id] = {};
        }
      });
    }
    visit(manifest.tree);
    var embedded = manifest.resources || {};
    Object.keys(embedded).forEach(function (id) {
      if (!W.resources[id]) return;
      Object.keys(embedded[id] || {}).forEach(function (view) {
        var values = Array.isArray(embedded[id][view]) ? embedded[id][view] : [embedded[id][view]];
        values.forEach(function (resource) {
          if (resource && resource.kind === "workspace_resource") storeWorkspaceResource(id, view, resource);
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
      loaded: W.order.reduce(function (n, id) { return n + Object.keys(W.resources[id]).length; }, 0),
      loading: Object.keys(W.loading).length, errors: Object.keys(W.errors).length,
      fetches: W.fetches, compositions: W.compositions,
      treeBuildMs: W.treeBuildMs.slice(), groupToggleMs: W.groupToggleMs.slice(),
    };
  }

  function workspaceLoadingHint(view) {
    if (!W || !workspaceHasView(view)) return "";
    var pending = Object.keys(W.loading).some(function (key) { return W.loading[key].view === view; });
    return pending ? "Loading selected workspace resources…" : "Select an item in the project tree.";
  }

  function ensureWorkspaceTab(tab) {
    if (!W) return;
    var view = workspaceViewName(tab);
    if (!workspaceHasView(view)) return;
    var hasLoaded = false;
    W.order.forEach(function (id) {
      if (!workspaceItemVisible(id, view) || !workspaceItemHasView(id, view)) return;
      var lane = workspaceLane(id, view);
      if (workspaceResource(id, view, lane)) hasLoaded = true;
      else loadWorkspaceResource(id, view, lane);
    });
    if (hasLoaded) composeWorkspaceView(view);
    exposeWorkspaceState();
  }

  function workspaceItemHasView(id, view) {
    var item = W && W.items[id];
    return !!(item && (item.views || []).indexOf(view) >= 0);
  }

  function resourceHref(id, view, lane) {
    var item = W.items[id], spec = item.resources && item.resources[view];
    if (!spec || !spec.href) return null;
    return spec.href + (lane == null ? "" : "&lane=" + encodeURIComponent(lane));
  }

  function scheduleWorkspacePanel() {
    if (W.panelTimer) return;
    W.panelTimer = setTimeout(function () {
      W.panelTimer = null; exposeWorkspaceState(); buildPanel();
    }, 0);
  }

  function scheduleWorkspaceCompose(view) {
    if (W.composeTimers[view]) return;
    W.composeTimers[view] = setTimeout(function () {
      delete W.composeTimers[view]; composeWorkspaceView(view);
    }, 0);
  }

  function loadWorkspaceResource(id, view, lane, retry, fallbackLane) {
    if (!W || !workspaceItemHasView(id, view)) return;
    var key = workspaceRequestKey(id, view, lane);
    if (workspaceResource(id, view, lane) && !retry) { composeWorkspaceView(view); return; }
    if (W.loading[key]) return;
    delete W.errors[key];
    if (App.mode === "file") {
      if (!workspaceResource(id, view, lane)) {
        W.errors[key] = (W.manifest.snapshot && W.manifest.snapshot.message) || "Resource was not embedded in this static snapshot.";
        if (fallbackLane != null && workspaceLane(id, view) === lane) W.activeLane[id][view] = fallbackLane;
        scheduleWorkspacePanel();
      } else composeWorkspaceView(view);
      return;
    }
    var href = resourceHref(id, view, lane);
    if (!href) { W.errors[key] = "No resource link declared."; scheduleWorkspacePanel(); return; }
    W.loading[key] = { view: view, lane: lane }; W.fetches++; scheduleWorkspacePanel();
    fetch(href)
      .then(function (r) { if (!r.ok) return r.text().then(function (t) { throw new Error(t || ("HTTP " + r.status)); }); return r.json(); })
      .then(function (resource) {
        if (!resource || resource.kind !== "workspace_resource") throw new Error("invalid workspace resource envelope");
        if (resource.item_id !== id || resource.view !== view || (resource.lane == null ? null : resource.lane) !== lane) {
          throw new Error("workspace resource identity/lane mismatch");
        }
        storeWorkspaceResource(id, view, resource);
        delete W.loading[key];
        scheduleWorkspaceCompose(view);
      })
      .catch(function (e) {
        delete W.loading[key]; W.errors[key] = String((e && e.message) || e);
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
    buildPanel(); if (workspaceViewName(App.tab) === view) renderActive();
  }

  function composeWorkspaceMap() {
    var entries = [];
    W.order.forEach(function (id) {
      if (!workspaceItemVisible(id, "map")) return;
      var r = workspaceResource(id, "map", workspaceLane(id, "map"));
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
      horizons: [], zone_averages: [], k_slices: [], contacts: [], wells: [], items: [],
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
    mapView.fitted = false;
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
    S.contactVis = (m.contacts || []).map(function () { return true; });
    S.wellVis = (App.payload.wells || []).map(function (w) { return workspaceItemVisible(w.item_id, "map"); });
  }

  function composeWorkspaceScene3d() {
    var entries = [];
    W.order.forEach(function (id) {
      var r = workspaceResource(id, "scene3d", workspaceLane(id, "scene3d"));
      if (r && r.payload && r.payload.scene3d) entries.push({ id: id, scene: r.payload.scene3d });
    });
    if (!entries.length) { App.payload.scene3d = null; return; }
    var scene = { schema_version: 1, points: [], meshes: [], lattices: [], contours: [], wells: [], outlines: [], layers: [], point_color: null, colormap: null, z_exaggeration: 5, ref_z: 0 };
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
    s3dBuilt = null;
    var tab = document.querySelector('.tab[data-tab="scene3d"]'); if (tab) tab.hidden = false;
  }

  function composeWorkspaceWells() {
    var bundles = [];
    W.order.forEach(function (id) {
      var r = workspaceResource(id, "wells", workspaceLane(id, "wells"));
      if (r && r.payload && r.payload.wells_logs) bundles.push({ id: id, bundle: r.payload.wells_logs });
    });
    if (!bundles.length) return;
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
    var lane = workspaceLane(id, view);
    if (visible && !workspaceResource(id, view, lane)) loadWorkspaceResource(id, view, lane);
    else if (view === "map") composeWorkspaceMap();
    else if (view === "scene3d") { applyScene3dVisibility(); if (s3d) s3d.render(); }
    else if (view === "wells" && S.wl) {
      S.wl.wells.forEach(function (well, i) { if (well.item_id === id) S.wlVis[i] = visible; });
      renderWells();
    }
    exposeWorkspaceState(); buildPanel();
  }

  function setWorkspaceLane(id, view, lane) {
    if (!W || !W.activeLane[id] || workspaceLane(id, view) === lane) return;
    var previous = workspaceLane(id, view);
    W.activeLane[id][view] = lane;
    if (workspaceItemVisible(id, view)) {
      if (workspaceResource(id, view, lane)) composeWorkspaceView(view);
      else loadWorkspaceResource(id, view, lane, false, previous);
    }
    exposeWorkspaceState(); buildPanel();
  }

  function workspaceDescendantItems(node, view, out) {
    if (node.children) node.children.forEach(function (child) { workspaceDescendantItems(child, view, out); });
    else if ((node.views || []).indexOf(view) >= 0) out.push(node.id);
  }

  function workspaceSearchText(node) {
    return W.searchText[node.id] || String(node.label || "").toLowerCase();
  }

  function buildWorkspaceTree(body) {
    if (!W) return;
    var started = performance.now();
    var view = workspaceViewName(App.tab), groupEl = group("Project");
    var search = el("input", "workspace-search"); search.type = "search";
    search.placeholder = "Search project"; search.value = W.query;
    search.addEventListener("input", function () {
      W.query = search.value.toLowerCase();
      var caret = search.selectionStart;
      if (W.searchTimer) clearTimeout(W.searchTimer);
      W.searchTimer = setTimeout(function () {
        W.searchTimer = null; buildPanel();
        var next = document.querySelector(".workspace-search");
        if (next) { next.focus(); next.setSelectionRange(caret, caret); }
      }, 80);
    });
    groupEl.appendChild(search);
    var tree = el("div", "workspace-tree");
    var flat = [];
    function flatten(node, depth) {
      var matches = !W.query || workspaceSearchText(node).indexOf(W.query) >= 0;
      if (node.children) {
        var childMatches = node.children.some(function (child) { return subtreeMatches(child); });
        if (!matches && !childMatches) return;
        flat.push({ node: node, depth: depth });
        if (W.expanded[node.id] || W.query) node.children.forEach(function (child) { flatten(child, depth + 1); });
      } else if (matches) {
        flat.push({ node: node, depth: depth });
      }
    }
    function subtreeMatches(node) {
      if (!W.query || workspaceSearchText(node).indexOf(W.query) >= 0) return true;
      return !!(node.children && node.children.some(subtreeMatches));
    }
    function draw(entry, target) {
      var node = entry.node, depth = entry.depth;
      if (node.children) {
        var ids = []; workspaceDescendantItems(node, view, ids);
        var checked = ids.filter(function (id) { return workspaceItemVisible(id, view); }).length;
        var row = el("div", "workspace-row workspace-group"); row.style.paddingLeft = (depth * 12) + "px";
        var twist = el("button", "workspace-twist", W.expanded[node.id] ? "▾" : "▸");
        twist.onclick = function () { W.expanded[node.id] = !W.expanded[node.id]; buildPanel(); };
        var cb = el("input"); cb.type = "checkbox"; cb.checked = ids.length > 0 && checked === ids.length;
        cb.indeterminate = checked > 0 && checked < ids.length; cb.disabled = !ids.length;
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
        row.appendChild(twist); row.appendChild(cb); row.appendChild(el("span", null, node.label));
        row.appendChild(el("span", "workspace-count", checked + "/" + ids.length)); target.appendChild(row);
      } else {
        var has = (node.views || []).indexOf(view) >= 0, lane = workspaceLane(node.id, view);
        var key = workspaceRequestKey(node.id, view, lane);
        var row = el("div", "workspace-row"); row.style.paddingLeft = (depth * 12 + 22) + "px";
        var cb = el("input"); cb.type = "checkbox"; cb.checked = has && workspaceItemVisible(node.id, view); cb.disabled = !has;
        cb.dataset.workspaceItem = node.id;
        cb.onchange = function () { setWorkspaceVisible(node.id, view, cb.checked); };
        row.appendChild(cb); row.appendChild(el("span", "workspace-role", node.role ? "◆" : "•"));
        var label = el("span", !has ? "workspace-disabled" : null, node.label);
        if (node.reason) label.title = node.reason;
        row.appendChild(label);
        var spec = node.resources && node.resources[view];
        if (has && spec && spec.lanes && spec.lanes.length > 1) {
          var select = el("select", "workspace-lane-select");
          spec.lanes.forEach(function (entry) {
            var option = el("option", null, entry.label); option.value = entry.id; select.appendChild(option);
          });
          select.value = lane;
          select.title = "Attribute for " + node.label;
          select.onchange = function () { setWorkspaceLane(node.id, view, select.value); };
          row.appendChild(select);
        }
        if (W.loading[key]) row.appendChild(el("span", "workspace-status", "…"));
        if (W.errors[key]) {
          var retry = el("button", "workspace-retry", "retry"); retry.title = W.errors[key];
          retry.onclick = function () { loadWorkspaceResource(node.id, view, lane, true); }; row.appendChild(retry);
        } else if (!has && node.reason) {
          var unavailable = el("span", "workspace-status", "unavailable");
          unavailable.title = node.reason; row.appendChild(unavailable);
        }
        target.appendChild(row);
      }
    }
    (W.manifest.tree || []).forEach(function (node) { flatten(node, 0); });
    if (flat.length <= 160) {
      flat.forEach(function (entry) { draw(entry, tree); });
    } else {
      // Keep search and bulk toggles within one frame for project-scale trees.
      // The canonical flat list remains complete; only the scroll window owns
      // DOM rows, so 2,000+ leaves do not turn each panel rebuild into layout
      // work proportional to the project size.
      var rowHeight = 25, overscan = 8, viewportRows = 13;
      tree.classList.add("workspace-tree-virtual");
      var spacer = el("div", "workspace-tree-spacer");
      spacer.style.height = (flat.length * rowHeight) + "px";
      var layer = el("div", "workspace-tree-window");
      tree.appendChild(spacer); tree.appendChild(layer);
      function renderWindow() {
        var first = Math.max(0, Math.floor(tree.scrollTop / rowHeight) - overscan);
        var last = Math.min(flat.length, first + viewportRows + overscan * 2);
        layer.innerHTML = ""; layer.style.transform = "translateY(" + (first * rowHeight) + "px)";
        for (var i = first; i < last; i++) draw(flat[i], layer);
      }
      tree.addEventListener("scroll", renderWindow); renderWindow();
    }
    groupEl.appendChild(tree); body.appendChild(groupEl); exposeWorkspaceState();
    W.treeBuildMs.push(performance.now() - started); exposeWorkspaceState();
  }
