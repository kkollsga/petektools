  // ================================================================== SCENE3D
  // The view3d tab: ONE Three.js scene (the volume tab's renderer/controls/
  // budget idioms) rendering the payload's `scene3d` bundle — colour-coded
  // point clouds (compact f32 blocks, decoded on the same kernel as the volume
  // blocks / log lanes), value-coloured or neutral surface meshes, geometry
  // lattice lines, contour polylines at their level elevation, well
  // trajectories with wellhead markers, and outline rings. z is ELEVATION
  // (family convention: negative down); the render maps (x, z, y) into three's
  // y-up frame so depth reads down-screen, and z-exaggeration is a display-only
  // group scale (true values in the readout, a "z ×N" badge).
  var s3d = null;      // { renderer, scene, camera, controls, group, badge }
  var s3dBuilt = null; // built scene registry for the current payload
  var _s3dRegularPending = {}, _s3dRegularRequestId = 0, _s3dPendingFor = null;
  var _s3dSharedDerived = {};
  var _s3dSharedPaintPending = {};
  var _s3dSharedBuildTotals = {};
  var S3D_NEUTRAL = [150, 150, 150];      // non-finite / monochrome vertex colour
  var S3D_MESH_NEUTRAL = 0x8f9aa5;        // neutral (no-values) surface material

  function scene3dWorkspaceView() {
    return App.tab === "map" && typeof workspaceMapMode === "function" && workspaceMapMode() === "3d"
      ? "map" : "scene3d";
  }
  function activeScene3dBundle() {
    var shared = scene3dWorkspaceView() === "map";
    var sc = shared ? App.payload.__workspaceMapScene3d : App.payload.scene3d;
    if (shared && sc) {
      (sc.meshes || []).forEach(function (mesh) {
        var fill = (App.payload.map.fills || []).filter(function (candidate) {
          return candidate.item_id === mesh.item_id && candidate.geometry_attribute === mesh.name;
        })[0];
        if (!fill) return;
        mesh.values = fill.regular_grid.values; mesh.range = fill.range;
        mesh.colormap = fill.colormap; mesh.colormap_reversed = fill.colormap_reversed;
        mesh.categorical = !!fill.categorical; mesh.categorical_codes = fill.categorical_codes;
        mesh.__sharedPaintIdentity = fill.__paintIdentity;
        mesh.regular_surface.values = fill.regular_grid.values;
        mesh.regular_surface.mask = fill.regular_grid.mask;
      });
    }
    return sc;
  }
  function scene3dHostElement() {
    return document.getElementById(scene3dWorkspaceView() === "map" ? "map-scene3d-host" : "scene3d-host");
  }
  function scene3dWebGLAvailable() {
    try {
      var probe = document.createElement("canvas");
      return !!(probe.getContext && (probe.getContext("webgl2") || probe.getContext("webgl") || probe.getContext("experimental-webgl")));
    } catch (_) { return false; }
  }
  function sharedScene3dFallback(reason) {
    setScene3dStatus("fallback", { reason: reason, requested: "3d", rendered: "2d" });
    syncWorkspaceMapModeHosts(true); renderMap();
    showBanner("3-D unavailable — showing 2-D", reason,
      "The requested mode is retained; 2-D remains fully usable without provider access.");
  }

  // Expose the scene build outcome for the test harness (like
  // __PETEK_VOLUME_STATUS): { state: "ok"|"error", points, triangles, buildMs }.
  function setScene3dStatus(state, info) {
    if (typeof window !== "undefined") {
      // A renderer/decode completion may arrive after the selected workspace
      // resource changed. Never let that stale success overwrite the current
      // localized loading/empty/malformed/error state.
      if (state === "ok") {
        var feedback = workspaceViewFeedback(scene3dWorkspaceView());
        if (feedback && feedback.state !== "ready") {
          state = feedback.state; info = { reason: feedback.message };
        }
      }
      window.__PETEK_SCENE3D_STATUS = Object.assign({ state: state }, info || {});
    }
  }

  function renderScene3d() {
    var view = scene3dWorkspaceView(), shared = view === "map";
    var host = scene3dHostElement(), sc = activeScene3dBundle();
    var feedback = workspaceViewFeedback(view);
    if (feedback && feedback.state !== "ready") {
      setScene3dStatus(feedback.state, { reason: feedback.message }); showEmpty(feedback.message); return;
    }
    if (!sc) {
      var state = { state: "empty", message: "No 3-D scene bundle in this payload." };
      setScene3dStatus(state.state, { reason: state.message }); showEmpty(state.message); return;
    }
    if (!window.THREE) {
      if (shared) { sharedScene3dFallback("The 3-D runtime is unavailable."); return; }
      setScene3dStatus("runtime", { reason: "Three.js did not load" });
      showEmpty("The 3-D runtime is unavailable. Reload the viewer or re-export this file."); return;
    }
    if (shared && !scene3dWebGLAvailable()) {
      sharedScene3dFallback("WebGL is unavailable or disabled in this browser."); return;
    }
    if (shared) syncWorkspaceMapModeHosts(false);
    hideEmpty();
    // LOUD, never silent: a malformed bundle (bad block, inconsistent arrays)
    // surfaces a banner + an error status hook, not a blank canvas.
    try {
      if (!s3d) initScene3d(host); else attachScene3dHost(host);
      resizeScene3d(host);
      if (!s3dBuilt || s3dBuilt._for !== sc) {
        buildScene3d(sc);
        if (App.tab === "scene3d" || shared) buildPanel(); // counts + fit-z now known
      } else if (shared && s3dBuilt._workspaceGeometryRevision !==
          (sc.__workspaceGeometryRevision || 0)) {
        reconcileSharedRegularScene(sc);
      } else if (s3dBuilt._colormapKey !== scene3dPaintSignature(sc)) {
        recolorScene3d(sc);
      }
      applyScene3dVisibility();
      restyleScene3dLines();
      s3d.group.scale.set(1, S.s3dExag, 1);
      if (!s3d.framed && !(s3dBuilt && s3dBuilt._regularPending)) { frameScene3d(); s3d.framed = true; }
      updateS3dBadge();
      drawScene3dLegend(sc);
      if (s3dBuilt._degraded) showScene3dDegradeBanner(s3dBuilt._degraded); else hideBanner();
      s3d.render();
    } catch (e) {
      var reason = String((e && e.message) || e);
      var webgl = /webgl|graphics context|context (?:lost|creation|create)/i.test(reason);
      if (shared && webgl) { sharedScene3dFallback(reason); return; }
      setScene3dStatus(webgl ? "webgl" : "error", { reason: reason });
      showEmpty(webgl ? "WebGL is unavailable or disabled in this browser." : "3-D scene failed to build — " + reason);
      showBanner(webgl ? "WebGL unavailable" : "3-D scene failed",
        reason, webgl ? "Enable hardware acceleration/WebGL and reload the viewer."
          : "The scene3d payload is malformed or exceeds this browser's limits. Re-export the view.");
    }
  }

  function initScene3d(host) {
    var THREE = window.THREE;
    var renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    host.appendChild(renderer.domElement);
    var badge = document.createElement("div");
    badge.style.cssText = "position:absolute;right:12px;bottom:12px;padding:2px 7px;border-radius:4px;font:600 11px system-ui;pointer-events:none;background:var(--surface-2);color:var(--text-secondary);border:1px solid var(--border)";
    host.appendChild(badge);
    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1e9);
    var controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.addEventListener("change", function () { if (s3d && s3d.render) s3d.render(); else renderer.render(scene, camera); });
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    var dir = new THREE.DirectionalLight(0xffffff, 0.7); dir.position.set(1, 1, 2); scene.add(dir);
    var group = new THREE.Group(); scene.add(group);
    var labels = document.createElement("div");
    labels.className = "scene3d-well-labels";
    labels.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none";
    host.appendChild(labels);
    s3d = { THREE: THREE, renderer: renderer, scene: scene, camera: camera, controls: controls, group: group, badge: badge, labels: labels, host: host, framed: false };
    s3d.render = function () { renderer.render(scene, camera); updateScene3dWellLabels(); };
    wireScene3dClickInspect(renderer.domElement);
  }
  function attachScene3dHost(host) {
    if (!s3d || !host || s3d.host === host) return;
    host.appendChild(s3d.renderer.domElement); host.appendChild(s3d.badge); host.appendChild(s3d.labels);
    s3d.host = host;
  }
  function resizeScene3d(host) {
    var w = host.clientWidth || 1, h = host.clientHeight || 1;
    s3d.renderer.setSize(w, h, false);
    s3d.camera.aspect = w / h; s3d.camera.updateProjectionMatrix();
  }

  function s3dRampVertex(col, i, t, cmap, reversed) {
    var c = isFinite(t) ? rampColor(cmap || S.colormap, t, reversed) : null;
    if (!c) c = S3D_NEUTRAL;
    col[i * 3] = c[0] / 255; col[i * 3 + 1] = c[1] / 255; col[i * 3 + 2] = c[2] / 255;
  }
  // Per-cloud colour resolution (the per-object color ruling): a cloud entry
  // may carry {range, colormap, colored} — read per-cloud FIRST, then the
  // global scene3d.point_color / the panel colormap (older payloads).
  function s3dCloudColor(src, pc) {
    var colored = !(src && src.colored === false);
    return {
      range: colored ? ((src && src.range) || (pc && pc.range) || null) : null,
      cmap: (src && src.colormap) || S.colormap,
      reversed: src && (src.colormap != null || src.colormap_reversed != null)
        ? !!src.colormap_reversed : !!S.colormapReversed,
    };
  }

  // A LOUD, dismissible degradation notice (the volume tab's auto-degrade
  // idiom): past the primitive budget the scene decimates to a 1-in-stride
  // preview and says so — it never refuses, crashes, or blanks.
  function showScene3dDegradeBanner(d) {
    showBanner("Decimated preview",
      d.full.toLocaleString() + " points/triangles exceeds the " + d.budget.toLocaleString()
      + "-primitive render budget — showing 1 in " + d.stride + " (" + d.kept.toLocaleString() + " kept).",
      "Re-export with a lower point_limit / a coarser mesh for the full-resolution scene.");
  }

  function buildScene3d(sc) {
    if (sc.detail === "full" && s3dBuilt && s3dBuilt._detail === "preview") {
      refineRegularScene3d(sc); return;
    }
    var THREE = s3d.THREE;
    var t0 = (typeof performance !== "undefined") ? performance.now() : 0;
    // drop the previous payload's objects (GPU buffers included)
    for (var gi = s3d.group.children.length - 1; gi >= 0; gi--) {
      var ch = s3d.group.children[gi];
      s3d.group.remove(ch);
      if (ch.geometry) ch.geometry.dispose();
      if (ch.material) ch.material.dispose();
    }
    var refZ = isFinite(sc.ref_z) ? sc.ref_z : 0;

    // ---- decode + extent pass (world coords; z is elevation) ----------------
    var clouds = (sc.points || []).map(function (c) {
      var f = decodeLane(c.xyz);
      if (!f) throw new Error("point block undecodable (decode kernel unavailable)");
      return { f: f, n: (f.length / 3) | 0, name: c.name, src: c };
    });
    var xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, zmin = Infinity, zmax = -Infinity;
    function ext(x, y, z) {
      if (isFinite(x)) { if (x < xmin) xmin = x; if (x > xmax) xmax = x; }
      if (isFinite(y)) { if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
      if (isFinite(z)) { if (z < zmin) zmin = z; if (z > zmax) zmax = z; }
    }
    clouds.forEach(function (c) {
      for (var q = 0; q < c.n; q++) ext(c.f[q * 3], c.f[q * 3 + 1], c.f[q * 3 + 2]);
    });
    (sc.meshes || []).forEach(function (m) {
      if (m.regular_surface) {
        var G = m.regular_surface, ni = G.dimensions[0] - 1, nj = G.dimensions[1] - 1;
        [0, ni].forEach(function (i) { [0, nj].forEach(function (j) {
          ext(G.origin[0] + i * G.step_i[0] + j * G.step_j[0],
              G.origin[1] + i * G.step_i[1] + j * G.step_j[1], NaN);
        }); });
        var er = G.elevation_range || [refZ, refZ]; ext(NaN, NaN, er[0]); ext(NaN, NaN, er[1]);
      } else m.nodes.forEach(function (nd) { ext(nd[0], nd[1], nd[2] == null ? NaN : nd[2]); });
    });
    (sc.wells || []).forEach(function (w) {
      w.trajectory.forEach(function (p) { ext(p[0], p[1], p[2] == null ? NaN : p[2]); });
    });
    // a lattice may carry its own flat level (L.z, the item's shallowest
    // point); an outline entry may be object-form {points, z} — both fall
    // back to ref_z (older payloads / all-flat scenes).
    (sc.lattices || []).forEach(function (L) {
      var lz = L.z != null ? L.z : refZ;
      L.lines.forEach(function (line) { line.forEach(function (p) { ext(p[0], p[1], lz); }); });
    });
    (sc.outlines || []).forEach(function (entry) {
      var ring = entry.points || entry, oz = entry.z != null ? entry.z : refZ;
      ring.forEach(function (p) { ext(p[0], p[1], oz); });
    });
    (sc.contours || []).forEach(function (cs) {
      cs.lines.forEach(function (line) { line.forEach(function (p) { ext(p[0], p[1], cs.level); }); });
    });
    if (!isFinite(xmin)) { xmin = xmax = ymin = ymax = 0; }
    if (!isFinite(zmin)) { zmin = zmax = refZ; }
    var cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2, cz = (zmin + zmax) / 2;
    // world -> render: (x, y, zElev) -> (x - cx, zElev - cz, y - cy); three is
    // y-up, so elevation maps straight onto the vertical axis (negative = down).
    var ry = function (z) { return (isFinite(z) ? z : refZ) - cz; };

    // ---- primitive budget (the volume tab's auto-degrade discipline) --------
    var budget = triBudget();
    var totalTris = 0;
    (sc.meshes || []).forEach(function (m) {
      if (m.regular_surface) totalTris += m.regular_surface.triangle_count == null
        ? Math.max(0, m.regular_surface.dimensions[0] - 1) * Math.max(0, m.regular_surface.dimensions[1] - 1) * 2
        : m.regular_surface.triangle_count;
      else totalTris += m.triangles.length;
    });
    var totalPts = 0;
    clouds.forEach(function (c) { totalPts += c.n; });
    var triStride = totalTris > budget ? Math.ceil(totalTris / budget) : 1;
    var ptStride = totalPts > budget ? Math.ceil(totalPts / budget) : 1;

    var built = {
      _for: sc, _colormapKey: scene3dPaintSignature(sc), _detail: sc.detail || null,
      pointObjs: [], meshObjs: [], wellObjs: [], wellLabels: [],
      latticeObjs: [], contourObjs: [], outlineObjs: [],
      latticeZ: [], // per-lattice rendered flat level (data-space; tests)
      pointCount: 0, triangleCount: 0,
      extent: { dx: Math.max(xmax - xmin, ymax - ymin) || 1, dz: (zmax - zmin) || 1 },
      depthRange: { min: zmin, max: zmax },
      _center: { cx: cx, cy: cy, cz: cz, refZ: refZ }, // world<->render transform (picking)
      _degraded: null,
      _regularPending: 0, _maxAttachMs: 0,
      _workspaceGeometryRevision: sc.__workspaceGeometryRevision || 0,
    };

    // ---- point clouds: ONE THREE.Points per cloud, per-vertex ramp colours
    // (each cloud's OWN range/colormap first; the global point_color fallback)
    var pc = sc.point_color;
    clouds.forEach(function (c) {
      var cc = s3dCloudColor(c.src, pc);
      var kept = Math.ceil(c.n / ptStride);
      var pos = new Float32Array(kept * 3), col = new Float32Array(kept * 3);
      var k = 0;
      for (var q = 0; q < c.n; q += ptStride) {
        var z = c.f[q * 3 + 2];
        pos[k * 3] = c.f[q * 3] - cx;
        pos[k * 3 + 1] = ry(z);
        pos[k * 3 + 2] = c.f[q * 3 + 1] - cy;
        var t = cc.range ? (z - cc.range[0]) / ((cc.range[1] - cc.range[0]) || 1) : NaN;
        s3dRampVertex(col, k, isFinite(z) ? t : NaN, cc.cmap, cc.reversed);
        k++;
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      var mat = new THREE.PointsMaterial({ size: 2.5, sizeAttenuation: false, vertexColors: true });
      var obj = new THREE.Points(geo, mat);
      s3d.group.add(obj);
      var entry = { obj: obj, geo: geo, f: c.f, n: c.n, stride: ptStride, kept: kept, src: c.src };
      obj.userData.petek = { kind: "points", name: c.name, item_id: c.src.item_id, o: entry };
      built.pointObjs.push(entry);
      built.pointCount += kept;
    });

    // ---- surface meshes: value-coloured (fill=) or neutral + wireframe ------
    (sc.meshes || []).forEach(function (m) {
      if (m.regular_surface) {
        queueRegularSurface(m, built, [cx, cy, cz], false);
        return;
      }
      var nNodes = m.nodes.length;
      var pos = new Float32Array(nNodes * 3);
      var finiteZ = new Array(nNodes);
      for (var q = 0; q < nNodes; q++) {
        var nd = m.nodes[q], z = nd[2] == null ? NaN : nd[2];
        finiteZ[q] = isFinite(z);
        pos[q * 3] = nd[0] - cx;
        pos[q * 3 + 1] = ry(z);
        pos[q * 3 + 2] = nd[1] - cy;
      }
      var idx = [];
      for (var ti = 0; ti < m.triangles.length; ti += triStride) {
        var tr = m.triangles[ti];
        // a triangle touching a z-less node is a HOLE, never geometry-guessed
        if (!finiteZ[tr[0]] || !finiteZ[tr[1]] || !finiteZ[tr[2]]) continue;
        idx.push(tr[0], tr[1], tr[2]);
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      var hasValues = !!(m.values && m.range);
      if (hasValues) {
        var col = new Float32Array(nNodes * 3);
        bakeMeshColors(m, col);
        geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      }
      geo.setIndex(idx);
      geo.computeVertexNormals();
      var mat = new THREE.MeshLambertMaterial({
        vertexColors: hasValues, side: THREE.DoubleSide,
        color: hasValues ? 0xffffff : S3D_MESH_NEUTRAL,
      });
      var mesh = new THREE.Mesh(geo, mat);
      mesh.userData.petek = { kind: "mesh", item_id: m.item_id, m: m };
      s3d.group.add(mesh);
      built.meshObjs.push({ mesh: mesh, geo: geo, m: m, hasValues: hasValues });
      built.triangleCount += idx.length / 3;
    });

    // ---- flat lattice lines (geometry grids + bare-item wireframes): one
    // LineSegments per lattice at its own flat level (L.z; ref_z fallback) --
    (sc.lattices || []).forEach(function (L) {
      var lz = L.z != null ? L.z : refZ;
      var obj = polylinesToSegments(L.lines, function (p) { return [p[0] - cx, lz - cz, p[1] - cy]; }, token("--muted"));
      if (obj) {
        obj.userData.petek = { kind: "lines", name: L.name, item_id: L.item_id, label: L.name ? pretty(L.name) : "grid lines" };
        s3d.group.add(obj); built.latticeObjs.push(obj);
        // the REAL rendered level, read back from the built geometry (tests)
        built.latticeZ.push(obj.geometry.attributes.position.count
          ? +(obj.geometry.attributes.position.getY(0) + cz).toFixed(6) : null);
      }
    });

    // ---- contour polylines at their level elevation (minor + major batches) -
    var contourGroups = {};
    (sc.contours || []).forEach(function (cs) {
      var key = (cs.item_id || "") + "::" + (cs.major ? "major" : "minor");
      var group = contourGroups[key] || (contourGroups[key] = { item_id: cs.item_id, major: !!cs.major, pairs: [] });
      cs.lines.forEach(function (line) {
        for (var q = 0; q < line.length - 1; q++) {
          group.pairs.push([line[q][0] - cx, cs.level - cz, line[q][1] - cy]);
          group.pairs.push([line[q + 1][0] - cx, cs.level - cz, line[q + 1][1] - cy]);
        }
      });
    });
    Object.keys(contourGroups).forEach(function (key) {
      var cg = contourGroups[key]; if (!cg.pairs.length) return;
      var obj = segmentsFromPairs(cg.pairs, token("--text-secondary"), cg.major ? 0.9 : 0.55);
      obj.userData.petek = { kind: "contours", item_id: cg.item_id, label: "contour" };
      s3d.group.add(obj); built.contourObjs.push(obj);
    });

    // ---- outline rings: plain rings flat at ref_z; object-form {points, z}
    // rings at their flat item's level ----------------------------------------
    (sc.outlines || []).forEach(function (entry) {
      var ring = entry.points || entry, oz = entry.z != null ? entry.z : refZ;
      var obj = polylinesToSegments([ring], function (p) { return [p[0] - cx, oz - cz, p[1] - cy]; }, token("--text-secondary"));
      if (obj) {
        obj.userData.petek = { kind: "outline", item_id: entry.item_id, label: "outline" };
        s3d.group.add(obj); built.outlineObjs.push(obj);
      }
    });

    // ---- well trajectories (identity-coloured) + a wellhead marker ----------
    (sc.wells || []).forEach(function (w) {
      var pts = [];
      w.trajectory.forEach(function (p) {
        if (p[2] == null || !isFinite(p[2])) return; // z-less samples are gaps
        pts.push(new THREE.Vector3(p[0] - cx, p[2] - cz, p[1] - cy));
      });
      if (!pts.length) return;
      var ws = w.style || {}, ps = ws.path || {}, ms = ws.marker || {};
      var color = ps.color || idColor("well:" + w.id) || "#888";
      var line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: new THREE.Color(color), transparent: (ps.opacity == null ? .9 : ps.opacity) < 1, opacity: ps.opacity == null ? .9 : ps.opacity })
      );
      // wellhead marker: a screen-sized point sprite (immune to z-exaggeration)
      var mgeo = new THREE.BufferGeometry();
      mgeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([pts[0].x, pts[0].y, pts[0].z]), 3));
      var markerColor = ms.fill || idColor("well:" + w.id) || color;
      var marker = new THREE.Points(mgeo, new THREE.PointsMaterial({ size: ms.size || 7, sizeAttenuation: false, color: new THREE.Color(markerColor) }));
      line.userData.petek = { kind: "well", name: w.id, item_id: w.item_id, label: disp(w, w.id) };
      marker.userData.petek = { kind: "well", name: w.id, item_id: w.item_id, label: disp(w, w.id) };
      s3d.group.add(line); s3d.group.add(marker);
      built.wellObjs.push(line); built.wellObjs.push(marker);
      if (w.label) built.wellLabels.push({ w: w, p: pts[0].clone() });
    });

    var stride = Math.max(triStride, ptStride);
    if (stride > 1) {
      built._degraded = {
        stride: stride, budget: budget,
        full: totalTris + totalPts,
        kept: built.triangleCount + built.pointCount,
      };
    }
    built.buildMs = Math.round(((typeof performance !== "undefined") ? performance.now() : 0) - t0);
    s3dBuilt = built;
    s3d.framed = false; // a fresh payload reframes the camera
    setScene3dStatus(built._regularPending ? "loading" : "ok", {
      points: built.pointCount, triangles: built.triangleCount,
      meshes: built.meshObjs.length, wells: (sc.wells || []).length,
      lattices: built.latticeObjs.length, latticeZ: built.latticeZ,
      buildMs: built.buildMs, labels: built.wellLabels.length,
      detail: built._detail,
    });
  }

  function runSharedRegularBuild(msg, colorsOnly, done, fail, current, cancel, allocated) {
    var D = window.PETEK_DECODE;
    var state = colorsOnly
      ? D.startRegularSurfaceColors(msg.surface, msg.range, msg.stops, msg.categories)
      : D.startRegularSurface(msg.surface, msg.center, msg.range, msg.stops, msg.categories);
    if (allocated) allocated(state);
    function step() {
      try {
        if (current && !current()) { if (cancel) cancel(); return; }
        var complete = colorsOnly ? D.stepRegularSurfaceColors(state, 16384)
          : D.stepRegularSurface(state, 16384);
        if (complete) done(state.result); else setTimeout(step, 0);
      } catch (error) { fail(error); }
    }
    step();
  }

  function s3dCenterKey(center) {
    return (center || [0, 0, 0]).map(function (value) { return String(Number(value) || 0); }).join(",");
  }
  function sharedDerivedKey(m, center) {
    return m.__sharedLedgerKey + "|center:" + s3dCenterKey(center);
  }
  function sharedRequestSupersedes(candidate, request) {
    if (!candidate || candidate.evictionGroup !== request.evictionGroup) return false;
    return candidate.cacheGroup === request.cacheGroup ||
      (request.detail === "full" && candidate.detail === "preview");
  }
  function cancelSupersededSharedWork(request) {
    Object.keys(_s3dRegularPending).forEach(function (pendingId) {
      var pending = _s3dRegularPending[pendingId];
      if (pending.requestId === request.requestId || !sharedRequestSupersedes(pending, request)) return;
      pending.cancelled = true;
      if (!pending.countReleased && pending.built && pending.built._regularPending > 0) {
        pending.built._regularPending--; pending.countReleased = true;
      }
    });
    Object.keys(_s3dSharedPaintPending).forEach(function (pendingKey) {
      var pending = _s3dSharedPaintPending[pendingKey];
      if (sharedRequestSupersedes(pending, request)) pending.cancelled = true;
    });
  }
  function evictSupersededSharedDerived(request) {
    Object.keys(_s3dSharedDerived).forEach(function (key) {
      var candidate = _s3dSharedDerived[key];
      if (key !== request.derivedKey && sharedRequestSupersedes(candidate, request)) {
        delete _s3dSharedDerived[key];
      }
    });
  }
  function supersedeWorkspaceSharedPreview(m) {
    Object.keys(_s3dRegularPending).forEach(function (pendingId) {
      var pending = _s3dRegularPending[pendingId];
      if (pending.evictionGroup !== m.__sharedEvictionGroup || pending.detail !== "preview") return;
      pending.cancelled = true;
      if (!pending.countReleased && pending.built && pending.built._regularPending > 0) {
        pending.built._regularPending--; pending.countReleased = true;
      }
    });
    Object.keys(_s3dSharedPaintPending).forEach(function (pendingKey) {
      var pending = _s3dSharedPaintPending[pendingKey];
      if (pending.evictionGroup === m.__sharedEvictionGroup && pending.detail === "preview") {
        pending.cancelled = true;
      }
    });
    Object.keys(_s3dSharedDerived).forEach(function (key) {
      var candidate = _s3dSharedDerived[key];
      if (candidate.evictionGroup === m.__sharedEvictionGroup && candidate.detail === "preview") {
        delete _s3dSharedDerived[key];
      }
    });
  }

  function queueRegularSurface(m, built, center, refining, staging, sharedReplace) {
    var paintKey = s3dMeshPaintKey(m), paintParts = paintKey.split("|");
    var id = ++_s3dRegularRequestId, stops = colormapStops(paintParts[0], paintParts[1] === "true");
    var request = { requestId: id, m: m, built: built, refining: !!refining, staging: staging,
      sharedReplace: !!sharedReplace,
      detail: m.__sharedDetail || built._detail, center: center.slice(), paintKey: paintKey,
      ledgerKey: m.__sharedLedgerKey, cacheGroup: m.__sharedCacheGroup,
      evictionGroup: m.__sharedEvictionGroup,
      centerKey: s3dCenterKey(center), derivedKey: sharedDerivedKey(m, center) };
    var surface = m.regular_surface.shared_decoded ? Object.assign({}, m.regular_surface) : m.regular_surface;
    var msg = { cmd: "buildRegularSurface", requestId: id, surface: surface,
      center: request.center, range: m.range, stops: stops,
      categories: m.categorical ? m.categorical_codes : null };
    if (m.regular_surface.shared_decoded) {
      cancelSupersededSharedWork(request); evictSupersededSharedDerived(request);
    }
    _s3dRegularPending[id] = request; built._regularPending++;
    if (m.regular_surface.shared_decoded) {
      setTimeout(function () {
        function fail(error) {
          delete _s3dRegularPending[id];
          if (!request.countReleased && built._regularPending > 0) built._regularPending--;
          request.pendingAllocation = null; refreshSharedModeLedger();
          setScene3dStatus("error", { reason: String((error && error.message) || error) });
        }
        function current() { return !!_s3dRegularPending[id] && !request.cancelled && s3dBuilt === built; }
        function cancel() {
          if (_s3dRegularPending[id]) {
            delete _s3dRegularPending[id];
            if (!request.countReleased && built._regularPending > 0) built._regularPending--;
          }
          request.pendingAllocation = null; refreshSharedModeLedger();
        }
        try {
          if (!current()) { cancel(); return; }
          evictSupersededSharedDerived(request);
          var cached = _s3dSharedDerived[request.derivedKey] ||
            (_s3dSharedDerived[request.derivedKey] = { paints: {}, paintOrder: [],
              cacheGroup: request.cacheGroup, evictionGroup: request.evictionGroup,
              detail: request.detail, centerKey: request.centerKey,
              geometryBuilds: 0, paintBuilds: 0 });
          var totals = _s3dSharedBuildTotals[request.evictionGroup] ||
            (_s3dSharedBuildTotals[request.evictionGroup] = { positions: 0, paints: 0 });
          var colors = cached.paints[paintKey];
          function finish() {
            while (cached.paintOrder.length > 4) delete cached.paints[cached.paintOrder.shift()];
            updateSharedModeLedger(m, cached, paintKey, request);
            onRegularSurfaceBuilt({ requestId: id, pos: cached.pos.buffer, index: cached.index.buffer,
              col: colors ? colors.buffer : null, triangleCount: cached.triangleCount,
              buildMs: 0, sharedCache: true });
          }
          if (!cached.pos || !cached.index) {
            runSharedRegularBuild(msg, false, function (first) {
              cached.pos = first.pos; cached.index = first.index; cached.triangleCount = first.triangleCount;
              request.pendingAllocation = null;
              cached.geometryBuilds++; cached.positionBuildOrdinal = ++totals.positions; colors = first.col;
              if (colors) { cached.paints[paintKey] = colors; cached.paintOrder.push(paintKey);
                cached.paintBuilds++; cached.paintBuildOrdinal = ++totals.paints; }
              finish();
            }, fail, current, cancel, function (state) {
              request.pendingAllocation = { pos: state.pos, index: state.index,
                color: state.colors && state.colors.col };
              refreshSharedModeLedger();
            });
          } else if (!colors && msg.surface.values) {
            runSharedRegularBuild(msg, true, function (nextColors) {
              request.pendingAllocation = null;
              colors = nextColors; cached.paints[paintKey] = colors;
              cached.paintOrder.push(paintKey); cached.paintBuilds++;
              cached.paintBuildOrdinal = ++totals.paints; finish();
            }, fail, current, cancel, function (state) {
              request.pendingAllocation = { pos: null, index: null, color: state.col };
              refreshSharedModeLedger();
            });
          } else finish();
        } catch (e) {
          fail(e);
        }
      }, 0);
      return;
    }
    var worker = typeof ensureWorker === "function" ? ensureWorker() : null;
    if (worker) worker.postMessage(msg);
    else setTimeout(function () {
      try {
        var r = window.PETEK_DECODE.buildRegularSurface(msg.surface, msg.center, msg.range,
          msg.stops, msg.categories);
        onRegularSurfaceBuilt({ requestId: id, pos: r.pos.buffer, index: r.index.buffer,
          col: r.col ? r.col.buffer : null, triangleCount: r.triangleCount, buildMs: 0 });
      } catch (e) {
        delete _s3dRegularPending[id]; built._regularPending--;
        setScene3dStatus("error", { reason: String((e && e.message) || e) });
      }
    }, 0);
  }

  function refreshSharedModeLedger() {
    var ledger = window.__PETEK_SHARED_MODE_LEDGER; if (!ledger) return;
    if (typeof workspaceRetainedSourceLedger === "function") {
      var retainedSources = workspaceRetainedSourceLedger();
      ledger.source_decoded_bytes = retainedSources.source_decoded_bytes;
      ledger.source_allocations = retainedSources.allocations;
    }
    var entries = ledger.entries || [], entryByGroup = {};
    entries.forEach(function (entry) {
      entry.derived_position_bytes = 0; entry.derived_topology_bytes = 0;
      entry.derived_paint_bytes = 0; entry.retained_paint_bytes = 0;
      entry.gpu_position_bytes = 0; entry.gpu_topology_bytes = 0;
      entry.gpu_paint_bytes = 0; entry.gpu_upload_bytes = 0;
      entry.geometry_builds = 0; entry.paint_builds = 0;
      entryByGroup[entry.eviction_group] = entry;
    });
    var seenCpu = typeof WeakSet !== "undefined" ? new WeakSet() : [];
    var seenGpu = typeof WeakSet !== "undefined" ? new WeakSet() : [];
    var cpuPosition = 0, cpuTopology = 0, cpuPaint = 0;
    var gpuPosition = 0, gpuTopology = 0, gpuPaint = 0;
    var allocations = [];
    function seen(set, value) {
      if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
      if (set instanceof Array) { if (set.indexOf(value) >= 0) return true; set.push(value); return false; }
      if (set.has(value)) return true; set.add(value); return false;
    }
    function bytes(value) {
      if (!value) return 0;
      var view = value.array || value;
      return typeof view.byteLength === "number" ? view.byteLength :
        (view.buffer && typeof view.buffer.byteLength === "number" ? view.buffer.byteLength : 0);
    }
    function cpu(group, kind, value) {
      if (!value) return 0;
      var view = value.array || value, identity = view.buffer || view;
      if (seen(seenCpu, identity)) return 0;
      var n = bytes(view), entry = entryByGroup[group];
      if (kind === "position") cpuPosition += n;
      else if (kind === "topology") cpuTopology += n;
      else cpuPaint += n;
      if (entry) {
        if (kind === "position") entry.derived_position_bytes += n;
        else if (kind === "topology") entry.derived_topology_bytes += n;
        else entry.retained_paint_bytes += n;
      }
      return n;
    }
    function gpu(group, kind, attribute) {
      if (!attribute || seen(seenGpu, attribute)) return 0;
      var n = bytes(attribute), entry = entryByGroup[group];
      if (kind === "position") gpuPosition += n;
      else if (kind === "topology") gpuTopology += n;
      else gpuPaint += n;
      if (entry) {
        if (kind === "position") entry.gpu_position_bytes += n;
        else if (kind === "topology") entry.gpu_topology_bytes += n;
        else entry.gpu_paint_bytes += n;
      }
      return n;
    }
    function record(state, group, detail, pos, index, color) {
      var before = { position: bytes(pos), topology: bytes(index), paint: bytes(color) };
      cpu(group, "position", pos); cpu(group, "topology", index); cpu(group, "paint", color);
      allocations.push({ state: state, eviction_group: group, detail: detail,
        position_bytes: before.position, topology_bytes: before.topology, paint_bytes: before.paint });
    }
    Object.keys(_s3dSharedDerived).forEach(function (key) {
      var cached = _s3dSharedDerived[key], paints = Object.keys(cached.paints || {});
      record("cache", cached.evictionGroup, cached.detail, cached.pos, cached.index, null);
      paints.forEach(function (paintKey) {
        record("cache-paint", cached.evictionGroup, cached.detail, null, null, cached.paints[paintKey]);
      });
      var entry = entryByGroup[cached.evictionGroup];
      if (entry) {
        entry.geometry_builds = Math.max(entry.geometry_builds, cached.geometryBuilds || 0);
        entry.paint_builds = Math.max(entry.paint_builds, cached.paintBuilds || 0);
        entry.position_builds_total = Math.max(entry.position_builds_total || 0, cached.positionBuildOrdinal || 0);
        entry.paint_builds_total = Math.max(entry.paint_builds_total || 0, cached.paintBuildOrdinal || 0);
        entry.center_identity = cached.centerKey;
      }
    });
    Object.keys(_s3dRegularPending).forEach(function (key) {
      var pending = _s3dRegularPending[key], a = pending.pendingAllocation;
      if (a) record(pending.cancelled ? "pending-cancelled" : "pending", pending.evictionGroup,
        pending.detail, a.pos, a.index, a.color);
    });
    Object.keys(_s3dSharedPaintPending).forEach(function (key) {
      var pending = _s3dSharedPaintPending[key], a = pending.pendingAllocation;
      if (a) record(pending.cancelled ? "paint-cancelled" : "paint-pending",
        pending.evictionGroup, pending.detail, null, null, a.color);
    });
    if (s3dBuilt) (s3dBuilt.meshObjs || []).forEach(function (object) {
      if (!object.m || !object.m.regular_surface || !object.m.regular_surface.shared_decoded) return;
      var group = object.evictionGroup || object.m.__sharedEvictionGroup;
      var detail = object.detail || s3dBuilt._detail;
      var pos = object.geo && object.geo.attributes && object.geo.attributes.position;
      var index = object.geo && object.geo.index;
      var color = object.geo && object.geo.attributes && object.geo.attributes.color;
      record(object.retiring ? "attached-retiring" : "attached", group, detail, pos, index, color);
      gpu(group, "position", pos); gpu(group, "topology", index); gpu(group, "paint", color);
    });
    entries.forEach(function (entry) {
      entry.derived_paint_bytes = entry.retained_paint_bytes;
      entry.gpu_upload_bytes = entry.gpu_position_bytes + entry.gpu_topology_bytes + entry.gpu_paint_bytes;
    });
    ledger.derived_position_bytes = cpuPosition;
    ledger.derived_topology_bytes = cpuTopology;
    ledger.retained_paint_bytes = cpuPaint;
    ledger.derived_paint_bytes = ledger.retained_paint_bytes;
    ledger.gpu_position_bytes = gpuPosition;
    ledger.gpu_topology_bytes = gpuTopology;
    ledger.gpu_paint_bytes = gpuPaint;
    ledger.gpu_upload_bytes = ledger.gpu_position_bytes + ledger.gpu_topology_bytes + ledger.gpu_paint_bytes;
    ledger.geometry_builds = entries.reduce(function (n, entry) { return n + (entry.geometry_builds || 0); }, 0);
    ledger.paint_builds = entries.reduce(function (n, entry) { return n + (entry.paint_builds || 0); }, 0);
    ledger.position_builds_total = entries.reduce(function (n, entry) { return n + (entry.position_builds_total || 0); }, 0);
    ledger.retained_bytes = ledger.source_decoded_bytes + ledger.derived_position_bytes +
      ledger.derived_topology_bytes + ledger.retained_paint_bytes + ledger.gpu_upload_bytes;
    ledger.allocations = allocations;
  }

  function updateSharedModeLedger(m, cached, paintKey, request) {
    var ledger = window.__PETEK_SHARED_MODE_LEDGER; if (!ledger) return;
    var ledgerKey = request ? request.ledgerKey : m.__sharedLedgerKey;
    var entry = (ledger.entries || []).filter(function (candidate) { return candidate.key === ledgerKey; })[0];
    if (entry) {
      entry.derived_key = request ? request.derivedKey : sharedDerivedKey(m,
        s3dBuilt ? [s3dBuilt._center.cx, s3dBuilt._center.cy, s3dBuilt._center.cz] : [0, 0, 0]);
      entry.center_identity = cached.centerKey;
    }
    refreshSharedModeLedger();
  }

  function s3dMeshPaintKey(mesh) {
    var name = canonicalColormap(mesh.colormap || S.colormap);
    var reversed = mesh.colormap != null || mesh.colormap_reversed != null
      ? !!mesh.colormap_reversed : !!S.colormapReversed;
    return [name, reversed, displayId(mesh.__sharedPaintIdentity),
      displayId(mesh.regular_surface && mesh.regular_surface.values),
      mesh.range ? mesh.range[0] + "," + mesh.range[1] : "-", mesh.categorical ? 1 : 0,
      displayId(mesh.categorical_codes)].join("|");
  }
  function scene3dPaintSignature(sc) {
    return [S.colormap, !!S.colormapReversed].concat((sc.meshes || []).map(s3dMeshPaintKey)).join(";");
  }

  function regularSurfaceObject(m, data) {
    var THREE = s3d.THREE, t0 = performance.now();
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(data.pos), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(data.index), 1));
    var hasValues = !!data.col;
    if (hasValues) geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(data.col), 3));
    // Avoid an O(n) main-thread normal pass: the worker-built immutable buffers
    // attach directly and retain their value colours under ambient display.
    var mat = new THREE.MeshBasicMaterial({
      vertexColors: hasValues, side: THREE.DoubleSide,
      color: hasValues ? 0xffffff : S3D_MESH_NEUTRAL,
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.userData.petek = { kind: "mesh", item_id: m.item_id, m: m };
    return { mesh: mesh, geo: geo, m: m, hasValues: hasValues,
      triangleCount: data.triangleCount, attachMs: performance.now() - t0 };
  }

  function onRegularSurfaceBuilt(data) {
    var pending = _s3dRegularPending[data.requestId]; if (!pending) return;
    delete _s3dRegularPending[data.requestId];
    var built = pending.built;
    if (!pending.countReleased && built._regularPending > 0) built._regularPending--;
    if (s3dBuilt !== built) return;
    var completion = paintCompletionState(data.requestId, pending.requestId,
      pending.paintKey, s3dMeshPaintKey(pending.m));
    if (completion === "stale-request") return;
    if (completion === "stale-paint") {
      queueRegularSurface(pending.m, built, pending.center, pending.refining,
        pending.staging, pending.sharedReplace); return;
    }
    var entry = regularSurfaceObject(pending.m, data); entry.paintKey = pending.paintKey;
    entry.sourceKey = pending.ledgerKey; entry.derivedKey = pending.derivedKey;
    entry.evictionGroup = pending.evictionGroup; entry.detail = pending.detail;
    built._maxAttachMs = Math.max(built._maxAttachMs || 0, entry.attachMs);
    if (pending.sharedReplace) {
      var currentMesh = (built._for.meshes || []).filter(function (mesh) {
        return mesh.item_id === pending.m.item_id && mesh.name === pending.m.name;
      })[0];
      if (!currentMesh || currentMesh.__sharedLedgerKey !== pending.ledgerKey) {
        entry.geo.dispose(); entry.mesh.material.dispose(); return;
      }
      var old = built.meshObjs.filter(function (candidate) {
        return candidate.m.item_id === pending.m.item_id && candidate.m.name === pending.m.name;
      })[0];
      if (old) {
        s3d.group.remove(old.mesh); old.geo.dispose(); old.mesh.material.dispose();
        built.triangleCount -= old.triangleCount;
      }
      s3d.group.add(entry.mesh);
      built.meshObjs = built.meshObjs.filter(function (candidate) { return candidate !== old; });
      built.meshObjs.push(entry); built.triangleCount += entry.triangleCount;
      built._detail = built._for.detail; built._colormapKey = scene3dPaintSignature(built._for);
      setScene3dStatus("ok", { detail: built._detail, refining: built._regularPending > 0,
        triangles: built.triangleCount, meshes: built.meshObjs.length });
      refreshSharedModeLedger(); applyScene3dVisibility(); s3d.render(); buildPanel(); return;
    }
    if (pending.refining) {
      pending.staging.objects.push(entry); pending.staging.triangles += entry.triangleCount;
      pending.staging.remaining--;
      if (pending.staging.remaining === 0) finishRegularRefinement(pending.staging);
      return;
    }
    if (pending.detail === "preview" && built._detail === "full") {
      entry.geo.dispose(); entry.mesh.material.dispose(); return;
    }
    s3d.group.add(entry.mesh); built.meshObjs.push(entry); built.triangleCount += entry.triangleCount;
    refreshSharedModeLedger();
    if (s3dBuilt === built) {
      if (!s3d.framed) { frameScene3d(); s3d.framed = true; }
      setScene3dStatus("ok", { points: built.pointCount, triangles: built.triangleCount,
        meshes: built.meshObjs.length, wells: (built._for.wells || []).length, lattices: built.latticeObjs.length,
        buildMs: built.buildMs, workerBuildMs: data.buildMs, maxAttachMs: built._maxAttachMs,
        detail: built._detail });
      applyScene3dVisibility(); s3d.render(); buildPanel();
    }
  }

  function reconcileSharedRegularScene(sc) {
    var built = s3dBuilt, center = [built._center.cx, built._center.cy, built._center.cz];
    var wanted = {};
    (sc.meshes || []).filter(function (mesh) { return !!mesh.regular_surface; }).forEach(function (mesh) {
      var key = mesh.item_id + "\u0000" + mesh.name; wanted[key] = true;
      var old = built.meshObjs.filter(function (candidate) {
        return candidate.m.item_id === mesh.item_id && candidate.m.name === mesh.name;
      })[0];
      if (!old || old.sourceKey !== mesh.__sharedLedgerKey) {
        if (old) old.retiring = true;
        queueRegularSurface(mesh, built, center, false, null, true);
      }
    });
    built.meshObjs.slice().forEach(function (entry) {
      if (!entry.m.regular_surface || wanted[entry.m.item_id + "\u0000" + entry.m.name]) return;
      s3d.group.remove(entry.mesh); entry.geo.dispose(); entry.mesh.material.dispose();
      built.triangleCount -= entry.triangleCount;
      built.meshObjs = built.meshObjs.filter(function (candidate) { return candidate !== entry; });
    });
    built._workspaceGeometryRevision = sc.__workspaceGeometryRevision || 0;
    built._detail = sc.detail;
    refreshSharedModeLedger();
    setScene3dStatus("ok", { detail: built._detail, refining: built._regularPending > 0,
      triangles: built.triangleCount, meshes: built.meshObjs.length });
  }

  function refineRegularScene3d(sc) {
    if (_s3dPendingFor === sc) return;
    var regular = (sc.meshes || []).filter(function (m) { return !!m.regular_surface; });
    if (!regular.length) { s3dBuilt = null; buildScene3d(sc); return; }
    _s3dPendingFor = sc;
    var c = s3dBuilt._center, staging = { sc: sc, objects: [], triangles: 0, built: s3dBuilt, detail: "full", remaining: regular.length };
    regular.forEach(function (m) { queueRegularSurface(m, s3dBuilt, [c.cx, c.cy, c.cz], true, staging); });
    // Deliberately keep the preview-ready state and camera while full buffers
    // build. No workspace/global loading transition is emitted here.
    setScene3dStatus("ok", { detail: "preview", refining: true,
      triangles: s3dBuilt.triangleCount, maxAttachMs: s3dBuilt._maxAttachMs || 0 });
  }

  function finishRegularRefinement(staging) {
    requestAnimationFrame(function () {
      var stalePaint = staging.objects.some(function (entry) { return entry.paintKey !== s3dMeshPaintKey(entry.m); });
      if (stalePaint || s3dBuilt !== staging.built) {
        staging.objects.forEach(function (entry) { entry.geo.dispose(); entry.mesh.material.dispose(); });
        _s3dPendingFor = null;
        if (s3dBuilt === staging.built) refineRegularScene3d(staging.sc);
        return;
      }
      var built = staging.built, oldRegular = built.meshObjs.filter(function (o) { return !!o.m.regular_surface; });
      var oldTriangles = oldRegular.reduce(function (n, o) { return n + (o.triangleCount || 0); }, 0);
      staging.objects.forEach(function (o) { s3d.group.add(o.mesh); });
      oldRegular.forEach(function (o) {
        s3d.group.remove(o.mesh); o.geo.dispose(); o.mesh.material.dispose();
      });
      built.meshObjs = built.meshObjs.filter(function (o) { return !o.m.regular_surface; }).concat(staging.objects);
      built.triangleCount = built.triangleCount - oldTriangles + staging.triangles;
      built._for = staging.sc; built._detail = staging.detail || "full";
      built._colormapKey = scene3dPaintSignature(staging.sc);
      _s3dPendingFor = null;
      setScene3dStatus("ok", { detail: built._detail, refining: false,
        triangles: built.triangleCount, meshes: built.meshObjs.length,
        maxAttachMs: built._maxAttachMs || 0, cameraPreserved: true });
      applyScene3dVisibility(); s3d.render(); buildPanel();
    });
  }

  // Crisp DOM labels projected only when the scene explicitly renders (initial
  // build, orbit change, resize, theme/z controls). There is no permanent loop.
  function updateScene3dWellLabels() {
    if (!s3d || !s3d.labels) return;
    s3d.labels.textContent = "";
    if (!s3dBuilt || !S.s3dShow.wells) return;
    var rect = s3d.renderer.domElement.getBoundingClientRect(), boxes = [];
    s3dBuilt.wellLabels.forEach(function (entry) {
      if (!workspaceItemVisible(entry.w.item_id, scene3dWorkspaceView())) return;
      var p = entry.p.clone().applyMatrix4(s3d.group.matrixWorld).project(s3d.camera);
      if (p.z < -1 || p.z > 1) return;
      var ax = (p.x * .5 + .5) * rect.width, ay = (-p.y * .5 + .5) * rect.height;
      var ls = (entry.w.style && entry.w.style.label) || {}, fs = ls.font_size || 11;
      var text = disp(entry.w, entry.w.id), tw = Math.max(24, text.length * fs * .58);
      var candidates = [[9,-fs/2],[9,-fs-8],[-tw-9,-fs/2],[-tw-9,-fs-8],[9,10],[-tw-9,10]], chosen = null;
      for (var ci=0; ci<candidates.length; ci++) {
        var dx=candidates[ci][0], dy=candidates[ci][1];
        if (Math.hypot(dx,dy) > (ls.max_displacement || 72)) continue;
        var b={x:ax+dx-2,y:ay+dy-2,w:tw+4,h:fs+5};
        if (!boxes.some(function(o){return b.x<o.x+o.w&&b.x+b.w>o.x&&b.y<o.y+o.h&&b.y+b.h>o.y;})) { chosen={x:ax+dx,y:ay+dy,b:b}; break; }
      }
      if (!chosen) return; boxes.push(chosen.b);
      var d=document.createElement("div"); d.textContent=text;
      d.style.cssText="position:absolute;white-space:nowrap;font:"+fs+"px system-ui;color:"+(ls.color||"var(--text-secondary)")+";left:"+chosen.x+"px;top:"+chosen.y+"px"+(ls.halo===false?"":";text-shadow:-1px -1px var(--surface-1),1px -1px var(--surface-1),-1px 1px var(--surface-1),1px 1px var(--surface-1)");
      s3d.labels.appendChild(d);
      if (ls.leader !== false && Math.hypot(chosen.x-ax,chosen.y-ay)>10) {
        var l=document.createElement("div"), dx2=chosen.x-ax, dy2=chosen.y-ay, len=Math.hypot(dx2,dy2);
        l.style.cssText="position:absolute;left:"+ax+"px;top:"+ay+"px;width:"+len+"px;height:1px;background:"+(ls.color||idColor("well:"+entry.w.id))+";transform-origin:0 0;transform:rotate("+Math.atan2(dy2,dx2)+"rad)";
        s3d.labels.appendChild(l);
      }
    });
    window.__PETEK_SCENE3D_WELL_LABELS = { requested: s3dBuilt.wellLabels.length, visible: boxes.length, boxes: boxes };
  }

  function bakeMeshColors(m, col) {
    var r0 = m.range[0], span = (m.range[1] - m.range[0]) || 1;
    var cmap = m.colormap || S.colormap; // per-mesh pin (dict item form)
    var reversed = m.colormap != null || m.colormap_reversed != null
      ? !!m.colormap_reversed : !!S.colormapReversed;
    for (var q = 0; q < m.nodes.length; q++) {
      var v = m.values[q];
      s3dRampVertex(col, q, v == null ? NaN : (v - r0) / span, cmap, reversed);
    }
  }

  // Colormap flip: re-bake point + value-mesh vertex colours in place (the
  // geometry/positions never rebuild — the volume tab's recolour idiom).
  // Per-object pins (cloud.colormap / mesh.colormap) keep their own ramp.
  function recolorScene3d(sc) {
    var regularMeshes = (sc.meshes || []).filter(function (m) { return !!m.regular_surface; });
    var sharedRegular = regularMeshes.filter(function (m) { return !!m.regular_surface.shared_decoded; });
    var sharedPending = 0;
    sharedRegular.forEach(function (m) {
      var object = s3dBuilt.meshObjs.filter(function (candidate) { return candidate.m === m; })[0];
      var center = [s3dBuilt._center.cx, s3dBuilt._center.cy, s3dBuilt._center.cz];
      var derivedKey = sharedDerivedKey(m, center);
      var cached = _s3dSharedDerived[derivedKey]; if (!object || !cached) return;
      var paintKey = s3dMeshPaintKey(m), colors = cached.paints[paintKey];
      function apply(nextColors) {
        if (!s3dBuilt || s3dBuilt._for !== sc || object.m !== m ||
            s3dMeshPaintKey(m) !== paintKey || sharedDerivedKey(m, center) !== derivedKey) {
          sharedPending--; return false;
        }
        object.geo.setAttribute("color", new s3d.THREE.BufferAttribute(nextColors, 3));
        object.hasValues = !!nextColors; object.paintKey = paintKey;
        updateSharedModeLedger(m, cached, paintKey, { ledgerKey: m.__sharedLedgerKey,
          derivedKey: derivedKey });
        if (!--sharedPending) {
          s3dBuilt._colormapKey = scene3dPaintSignature(sc);
          if (s3d && s3d.render) s3d.render();
        }
        return true;
      }
      if (colors) { sharedPending++; apply(colors); return; }
      var pendingKey = derivedKey + "|paint:" + paintKey;
      if (_s3dSharedPaintPending[pendingKey]) return;
      var pendingPaint = { cacheGroup: m.__sharedCacheGroup,
        evictionGroup: m.__sharedEvictionGroup, detail: m.__sharedDetail,
        derivedKey: derivedKey, paintKey: paintKey };
      _s3dSharedPaintPending[pendingKey] = pendingPaint; sharedPending++;
      var parts = paintKey.split("|"), stops = colormapStops(parts[0], parts[1] === "true");
      var msg = { surface: Object.assign({}, m.regular_surface), range: m.range, stops: stops,
        categories: m.categorical ? m.categorical_codes : null };
      runSharedRegularBuild(msg, true, function (nextColors) {
        delete _s3dSharedPaintPending[pendingKey];
        pendingPaint.pendingAllocation = null;
        cached.paints[paintKey] = nextColors; cached.paintOrder.push(paintKey); cached.paintBuilds++;
        var totals = _s3dSharedBuildTotals[m.__sharedEvictionGroup] ||
          (_s3dSharedBuildTotals[m.__sharedEvictionGroup] = { positions: 0, paints: 0 });
        cached.paintBuildOrdinal = ++totals.paints;
        while (cached.paintOrder.length > 4) delete cached.paints[cached.paintOrder.shift()];
        refreshSharedModeLedger();
        apply(nextColors);
      }, function (error) {
        delete _s3dSharedPaintPending[pendingKey]; pendingPaint.pendingAllocation = null;
        sharedPending--; refreshSharedModeLedger();
        setScene3dStatus("error", { reason: String((error && error.message) || error) });
      }, function () { return !!_s3dSharedPaintPending[pendingKey] && !!s3dBuilt &&
        !_s3dSharedPaintPending[pendingKey].cancelled && s3dBuilt._for === sc &&
        object.m === m && _s3dSharedDerived[derivedKey] === cached; }, function () {
        delete _s3dSharedPaintPending[pendingKey]; pendingPaint.pendingAllocation = null;
        sharedPending--; refreshSharedModeLedger();
      }, function (state) {
        pendingPaint.pendingAllocation = { color: state.col };
        refreshSharedModeLedger();
      });
    });
    var legacyRegular = regularMeshes.filter(function (m) { return !m.regular_surface.shared_decoded; });
    if (legacyRegular.length && _s3dPendingFor !== sc) {
      _s3dPendingFor = sc;
      var center0 = s3dBuilt._center;
      var staging0 = { sc: sc, objects: [], triangles: 0, built: s3dBuilt, detail: s3dBuilt._detail, remaining: legacyRegular.length };
      legacyRegular.forEach(function (m) {
        queueRegularSurface(m, s3dBuilt, [center0.cx, center0.cy, center0.cz], true, staging0);
      });
    }
    var pc = sc.point_color;
    s3dBuilt.pointObjs.forEach(function (o) {
      var cc = s3dCloudColor(o.src, pc);
      var col = o.geo.attributes.color.array;
      var k = 0;
      for (var q = 0; q < o.n; q += o.stride) {
        var z = o.f[q * 3 + 2];
        var t = cc.range ? (z - cc.range[0]) / ((cc.range[1] - cc.range[0]) || 1) : NaN;
        s3dRampVertex(col, k, isFinite(z) ? t : NaN, cc.cmap, cc.reversed);
        k++;
      }
      o.geo.attributes.color.needsUpdate = true;
    });
    s3dBuilt.meshObjs.forEach(function (o) {
      if (!o.hasValues) return;
      if (o.m.regular_surface) return; // rebuilt by the next detail/resource swap
      bakeMeshColors(o.m, o.geo.attributes.color.array);
      o.geo.attributes.color.needsUpdate = true;
    });
    if (!legacyRegular.length && !sharedPending) s3dBuilt._colormapKey = scene3dPaintSignature(sc);
  }

  function polylinesToSegments(lines, map3, colorCss) {
    var pairs = [];
    (lines || []).forEach(function (line) {
      for (var q = 0; q < line.length - 1; q++) {
        pairs.push(map3(line[q]));
        pairs.push(map3(line[q + 1]));
      }
    });
    if (!pairs.length) return null;
    return segmentsFromPairs(pairs, colorCss, 1);
  }
  function segmentsFromPairs(pairs, colorCss, opacity) {
    var THREE = s3d.THREE;
    var pos = new Float32Array(pairs.length * 3);
    for (var q = 0; q < pairs.length; q++) {
      pos[q * 3] = pairs[q][0]; pos[q * 3 + 1] = pairs[q][1]; pos[q * 3 + 2] = pairs[q][2];
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    var mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(colorCss || "#888"),
      transparent: opacity < 1, opacity: opacity == null ? 1 : opacity,
    });
    return new THREE.LineSegments(geo, mat);
  }

  // Theme flip: re-read the live tokens onto the line materials + background
  // (identity/well colours keep their slot; ramp colours are colormap-driven).
  function restyleScene3dLines() {
    s3d.renderer.setClearColor(new s3d.THREE.Color(token("--surface-1") || "#ffffff"), 1);
    if (!s3dBuilt) return;
    s3dBuilt.latticeObjs.forEach(function (o) { o.material.color.set(token("--muted") || "#888"); });
    s3dBuilt.contourObjs.forEach(function (o) { o.material.color.set(token("--text-secondary") || "#666"); });
    s3dBuilt.outlineObjs.forEach(function (o) { o.material.color.set(token("--text-secondary") || "#666"); });
  }

  function applyScene3dVisibility() {
    if (!s3dBuilt) return;
    var view = scene3dWorkspaceView();
    s3dBuilt.pointObjs.forEach(function (o) { o.obj.visible = S.s3dShow.points && workspaceItemVisible(o.src.item_id, view); });
    s3dBuilt.meshObjs.forEach(function (o) {
      o.mesh.visible = S.s3dShow.meshes && workspaceItemVisible(o.m.item_id, view);
      o.mesh.material.wireframe = S.s3dWireframe;
    });
    s3dBuilt.latticeObjs.forEach(function (o) { o.visible = S.s3dShow.lattice && workspaceItemVisible(o.userData.petek.item_id, view); });
    s3dBuilt.contourObjs.forEach(function (o) { o.visible = S.s3dShow.contours && workspaceItemVisible(o.userData.petek.item_id, view); });
    s3dBuilt.outlineObjs.forEach(function (o) { o.visible = S.s3dShow.outlines && workspaceItemVisible(o.userData.petek.item_id, view); });
    s3dBuilt.wellObjs.forEach(function (o) { o.visible = S.s3dShow.wells && workspaceItemVisible(o.userData.petek.item_id, view); });
  }

  // z-exaggeration: a display-only group scale (same control the volume tab
  // has — slider + "fit z ×N" aspect suggestion; true depths in the readout).
  function applyS3dExag(val) {
    S.s3dExag = val;
    if (!s3d) return;
    s3d.group.scale.set(1, val, 1);
    frameScene3d();
    updateS3dBadge();
    s3d.render();
  }
  function suggestS3dExag() {
    if (!s3dBuilt) return 5;
    var r = s3dBuilt.extent.dx / s3dBuilt.extent.dz / 2.5;
    return isFinite(r) ? Math.min(20, Math.max(4, Math.round(r))) : 5;
  }

  function frameScene3d() {
    var THREE = s3d.THREE;
    var box = new THREE.Box3().setFromObject(s3d.group);
    if (box.isEmpty()) return;
    var c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
    var rad = Math.max(sz.x, sz.y, sz.z) * 0.6 || 1;
    s3d.controls.target.copy(c);
    s3d.camera.position.set(c.x + rad * 1.6, c.y + rad * 1.2, c.z + rad * 1.8);
    s3d.camera.near = rad / 100; s3d.camera.far = rad * 100; s3d.camera.updateProjectionMatrix();
    s3d.controls.update();
  }

  function updateS3dBadge() {
    if (!s3d || !s3d.badge) return;
    var pts = s3dBuilt ? s3dBuilt.pointCount : 0, tris = s3dBuilt ? s3dBuilt.triangleCount : 0;
    s3d.badge.textContent = "z ×" + S.s3dExag
      + "  ·  " + pts.toLocaleString() + " pts"
      + (tris ? "  ·  " + tris.toLocaleString() + " tris" : "")
      + (s3dBuilt && s3dBuilt._degraded ? "  ·  1:" + s3dBuilt._degraded.stride : "");
  }

  // Click-to-inspect + orbit re-target (owner rulings): hover shows NOTHING in
  // the 3-D scene. A CLICK on/near an object — THREE.Raycaster picking over the
  // built points/meshes/lines, the points/line threshold sized to the on-screen
  // marker at the pick distance — anchors a readout at the clicked location
  // (dataset/layer name + TRUE x, y, z / value) AND re-targets the orbit
  // controls' rotation pivot to the picked point WITHOUT moving the camera
  // (position kept; the controls re-orient only — no jump). Clicking empty
  // space (or the same target again) dismisses the readout; the pivot keeps its
  // last picked point. A press that moved more than a few px between down/up is
  // an orbit drag, never a pick. The pick outcome is exposed for tests as
  // window.__PETEK_SCENE3D_PICK ({x, y, z, point, target, cameraBefore,
  // camera} on a hit; {miss: true, target, camera} on an empty click).
  var S3D_CLICK_SLOP_PX = 4;
  var S3D_PICK_PX = 6; // pick radius in screen px (the markers are 2.5-8 px)
  var _s3dDownPx = null;
  var _s3dPickKey = null;
  function wireScene3dClickInspect(dom) {
    dom.addEventListener("pointerdown", function (ev) { _s3dDownPx = [ev.clientX, ev.clientY]; });
    dom.addEventListener("pointerup", function (ev) {
      if (!_s3dDownPx) return;
      var moved = Math.hypot(ev.clientX - _s3dDownPx[0], ev.clientY - _s3dDownPx[1]);
      _s3dDownPx = null;
      if (moved <= S3D_CLICK_SLOP_PX) scene3dClickInspect(ev);
    });
  }
  function s3dWorldToData(p) {
    // render/world -> data coords: undo the centring shift + the y-up mapping
    // + the display-only z-exaggeration group scale.
    var c = s3dBuilt._center;
    var exag = (s3d.group.scale && s3d.group.scale.y) || 1;
    return { x: p.x + c.cx, y: p.z + c.cy, z: p.y / exag + c.cz };
  }
  function describeScene3dHit(hit) {
    var u = hit.object.userData.petek;
    if (u.kind === "points") {
      var o = u.o; // the built cloud entry (original floats + decimation stride)
      var vi = (hit.index != null ? hit.index : 0) * o.stride;
      if (vi >= o.n) vi = o.n - 1;
      var z = o.f[vi * 3 + 2];
      return {
        key: "pt:" + (u.name || "") + ":" + vi,
        label: (u.name ? pretty(u.name) : "points") + " · " + vi,
        x: o.f[vi * 3], y: o.f[vi * 3 + 1], z: isFinite(z) ? z : null,
      };
    }
    if (u.kind === "mesh" && hit.face) {
      // nearest face vertex to the hit, in the mesh's local frame — its node
      // row carries the TRUE data coords (and value, when value-coloured)
      var m = u.m;
      if (m.regular_surface) {
        var G = m.regular_surface, nc = G.dimensions[0], vi0 = hit.face.a;
        var ii = vi0 % nc, jj = Math.floor(vi0 / nc);
        var decodeRegular = window.PETEK_DECODE && window.PETEK_DECODE.regularSurfaceArray;
        var elev = G.__elev || (G.__elev = decodeRegular
          ? decodeRegular(G.elevations) : decodeLane(G.elevations));
        var vals = G.values ? (G.__values || (G.__values = decodeRegular
          ? decodeRegular(G.values) : decodeLane(G.values))) : null;
        var value0 = vals ? vals[vi0] : null;
        var elevation0 = elev && isFinite(elev[vi0]) ? elev[vi0] : null;
        if (elevation0 != null && G.positive === "down") elevation0 = -elevation0;
        var regularOut = {
          key: "mesh:" + (m.display_name || m.name || "") + ":" + vi0,
          label: disp(m, m.name) || "mesh",
          x: G.origin[0] + ii * G.step_i[0] + jj * G.step_j[0],
          y: G.origin[1] + ii * G.step_i[1] + jj * G.step_j[1],
          z: elevation0,
        };
        if (value0 != null && isFinite(value0) && m.name !== "z") {
          regularOut.value = value0; regularOut.valueLabel = m.name;
        }
        return regularOut;
      }
      var local = hit.object.worldToLocal(hit.point.clone());
      var pos = hit.object.geometry.attributes.position;
      var best = hit.face.a, bestD = Infinity;
      [hit.face.a, hit.face.b, hit.face.c].forEach(function (vi2) {
        var dx = pos.getX(vi2) - local.x, dy = pos.getY(vi2) - local.y, dz = pos.getZ(vi2) - local.z;
        var dd = dx * dx + dy * dy + dz * dz;
        if (dd < bestD) { bestD = dd; best = vi2; }
      });
      var nd = m.nodes[best];
      var out = {
        key: "mesh:" + (m.display_name || m.name || "") + ":" + best,
        label: disp(m, m.name) || "mesh",
        x: nd[0], y: nd[1], z: nd[2] == null ? null : nd[2],
      };
      if (m.values && m.values[best] != null && m.name !== "z") {
        out.value = m.values[best]; out.valueLabel = m.name;
      }
      return out;
    }
    // lines (well bore/marker, lattice, contour, outline): data coords at the hit
    var w = s3dWorldToData(hit.point);
    return {
      key: u.kind + ":" + (u.name || ""),
      label: u.label || (u.name ? pretty(u.name) : u.kind),
      x: w.x, y: w.y, z: w.z,
    };
  }
  function scene3dClickInspect(ev) {
    if (!s3d || !s3dBuilt) return;
    var THREE = s3d.THREE;
    var rect = s3d.renderer.domElement.getBoundingClientRect();
    var ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / (rect.width || 1)) * 2 - 1,
      -((ev.clientY - rect.top) / (rect.height || 1)) * 2 + 1
    );
    var ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, s3d.camera);
    // world units per screen px at the orbit-target distance -> the pick radius
    var dist = s3d.camera.position.distanceTo(s3d.controls.target);
    var wpp = (2 * dist * Math.tan((s3d.camera.fov * Math.PI) / 360)) / (rect.height || 1);
    ray.params.Points = { threshold: wpp * S3D_PICK_PX };
    ray.params.Line = { threshold: wpp * S3D_PICK_PX };
    var hits = ray.intersectObjects(s3d.group.children, false);
    var hit = null;
    for (var q = 0; q < hits.length; q++) {
      var ob = hits[q].object;
      if (ob.visible && ob.userData && ob.userData.petek) { hit = hits[q]; break; }
    }
    if (!hit) { // empty space: dismiss the readout, KEEP the last pivot
      hideReadout(); _s3dPickKey = null;
      window.__PETEK_SCENE3D_PICK = {
        miss: true,
        target: s3d.controls.target.toArray(),
        camera: s3d.camera.position.toArray(),
      };
      return;
    }
    var d = describeScene3dHit(hit);
    // orbit pivot: re-target to the picked point WITHOUT moving the camera
    var camBefore = s3d.camera.position.toArray();
    s3d.controls.target.copy(hit.point);
    s3d.controls.update();
    s3d.render();
    window.__PETEK_SCENE3D_PICK = {
      x: d.x, y: d.y, z: d.z,
      point: hit.point.toArray(),
      target: s3d.controls.target.toArray(),
      cameraBefore: camBefore,
      camera: s3d.camera.position.toArray(),
    };
    var readout = document.getElementById("readout");
    if (!readout.hidden && d.key === _s3dPickKey) { hideReadout(); _s3dPickKey = null; return; } // same target again
    _s3dPickKey = d.key;
    var rows = [["", d.label], ["x", fmt(d.x, "m")], ["y", fmt(d.y, "m")]];
    if (d.value != null && isFinite(d.value)) rows.push([d.valueLabel || "value", fmt(d.value)]);
    if (d.z != null && isFinite(d.z)) rows.push(["z", fmt(d.z, "m")]);
    showReadout(ev, rows);
  }

  // The scene3d control panel: colormap + z-exag (+ fit) + per-layer toggles.
  function buildScene3dPanel(body) {
    var sc = activeScene3dBundle(), view = scene3dWorkspaceView();
    if (!sc) { body.appendChild(el("div", "hint", workspaceLoadingHint(view) || "No 3-D scene bundle in this payload.")); return; }
    var built = s3dBuilt && s3dBuilt._for === sc ? s3dBuilt : null;
    var g = group("Scene");
    g.appendChild(el("div", "hint",
      (built ? built.pointCount.toLocaleString() : "…") + " pts · "
      + (built ? built.triangleCount.toLocaleString() : "…") + " tris"));
    if (built && built._degraded) {
      var dh = el("div", "hint", "Decimated preview: 1 in " + built._degraded.stride
        + " (budget " + built._degraded.budget.toLocaleString() + ").");
      dh.style.color = "var(--swing-lo)";
      g.appendChild(dh);
    }
    g.appendChild(colormapRow());
    g.appendChild(sliderRow("z exaggeration", 1, 20, 1, S.s3dExag, applyS3dExag));
    if (built) {
      var sg = suggestS3dExag();
      g.appendChild(fitExagButton(sg, function () { applyS3dExag(sg); buildPanel(); }));
    }
    body.appendChild(g);

    var t = group("Layers");
    if ((sc.points || []).length) {
      t.appendChild(toggleRow("Points", S.s3dShow.points, token("--accent"), false, function (v) { S.s3dShow.points = v; renderScene3d(); }));
    }
    if ((sc.meshes || []).length) {
      t.appendChild(toggleRow("Surfaces", S.s3dShow.meshes, rampCss(S.colormap, 0.6), false, function (v) { S.s3dShow.meshes = v; renderScene3d(); }));
      t.appendChild(toggleRow("Wireframe", S.s3dWireframe, null, false, function (v) { S.s3dWireframe = v; renderScene3d(); }));
    }
    if ((sc.lattices || []).length) {
      t.appendChild(toggleRow("Grid lines", S.s3dShow.lattice, token("--muted"), true, function (v) { S.s3dShow.lattice = v; renderScene3d(); }));
    }
    if ((sc.contours || []).length) {
      t.appendChild(toggleRow("Contours", S.s3dShow.contours, token("--text-secondary"), true, function (v) { S.s3dShow.contours = v; renderScene3d(); }));
    }
    if ((sc.outlines || []).length) {
      t.appendChild(toggleRow("Outline", S.s3dShow.outlines, token("--text-secondary"), true, function (v) { S.s3dShow.outlines = v; renderScene3d(); }));
    }
    if ((sc.wells || []).length) {
      t.appendChild(toggleRow("Wells", S.s3dShow.wells, token("--c1"), false, function (v) { S.s3dShow.wells = v; renderScene3d(); }));
    }
    body.appendChild(t);

    var reset = el("button", "btn secondary", "Reset view");
    reset.onclick = function () { if (s3d) { frameScene3d(); s3d.render(); } };
    body.appendChild(reset);
  }

  // The 3D tab's per-layer legend — the SAME machinery as the Map tab (type
  // icons + duck-typed display names + ramp/clamped range on value-coloured
  // layers); value meshes self-describe via display_name, like 2-D fills.
  function drawScene3dLegend(sc) {
    var lg = document.getElementById("legend"); lg.innerHTML = "";
    var keys = el("div", "keys");
    var pc = sc.point_color, pointsRampDrawn = false, ptIdx = 0;
    if (S.s3dShow.meshes) {
      (sc.meshes || []).forEach(function (m) {
        if (!workspaceItemVisible(m.item_id, scene3dWorkspaceView())) return;
        if (m.categorical && m.categorical_codes) {
          Object.keys(m.categorical_codes).sort(function (a, b) { return Number(a) - Number(b); })
            .forEach(function (code) {
              var record = m.categorical_codes[code] || {};
              keys.appendChild(keyRow((disp(m, m.name) || "mesh") + " · " +
                (record.label != null ? record.label : code), record.color || token("--muted"), false));
            });
        } else if (m.values && m.range) {
          var reversed = m.colormap != null || m.colormap_reversed != null
            ? !!m.colormap_reversed : !!S.colormapReversed;
          rampBlock(lg, typeIcon("fill", null, m.colormap, reversed), disp(m, m.name),
            m.range[0], m.range[1], m.colormap, reversed);
        } else {
          keys.appendChild(keyRow(disp(m, m.name) || "mesh", token("--muted"), false));
        }
      });
    }
    (sc.layers || []).forEach(function (ly) {
      if (ly.kind === "points") {
        // points layers pair with sc.points in emission order — each cloud's
        // OWN range/colormap draws its OWN ramp (per-object color ruling);
        // clouds on the global point_color share one ramp block.
        var src = (sc.points || [])[ptIdx++] || null;
        if (!workspaceItemVisible(ly.item_id || (src && src.item_id), scene3dWorkspaceView())) return;
        if (!S.s3dShow.points || !(sc.points || []).length) return;
        var plabel = ly.name ? pretty(ly.name) : "points";
        var cc = s3dCloudColor(src, pc);
        if (cc.range && ((src && src.range) || !pointsRampDrawn)) {
          if (!(src && src.range)) pointsRampDrawn = true;
          rampBlock(lg, typeIcon("points", rampCss(cc.cmap, 0.75, cc.reversed)),
            plabel + " · " + ((pc && pc.by) || "z"), cc.range[0], cc.range[1], cc.cmap, cc.reversed);
        } else {
          keys.appendChild(iconKeyRow("points", plabel,
            cc.range ? rampCss(cc.cmap, 0.75, cc.reversed) : token("--accent")));
        }
      } else if (ly.kind === "lines") {
        if (!workspaceItemVisible(ly.item_id, scene3dWorkspaceView())) return;
        if (!S.s3dShow.lattice || !(sc.lattices || []).length) return;
        keys.appendChild(iconKeyRow("lines", ly.name ? pretty(ly.name) : "grid lines", token("--muted")));
      } else if (ly.kind === "contours") {
        if (!workspaceItemVisible(ly.item_id, scene3dWorkspaceView())) return;
        if (!S.s3dShow.contours || !(sc.contours || []).length) return;
        keys.appendChild(iconKeyRow("contours", ly.name ? pretty(ly.name) : "contours", token("--text-secondary")));
      } else if (ly.kind === "wells") {
        if (!workspaceItemVisible(ly.item_id, scene3dWorkspaceView())) return;
        if (!S.s3dShow.wells) return;
        keys.appendChild(iconKeyRow("wells", pretty(ly.name || "well"), idColor("well:" + ly.name)));
      }
    });
    if (keys.childNodes.length) lg.appendChild(keys);
    lg.style.display = lg.childNodes.length ? "block" : "none";
  }
