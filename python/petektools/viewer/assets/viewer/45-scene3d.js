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
  var S3D_NEUTRAL = [150, 150, 150];      // non-finite / monochrome vertex colour
  var S3D_MESH_NEUTRAL = 0x8f9aa5;        // neutral (no-values) surface material

  // Expose the scene build outcome for the test harness (like
  // __PETEK_VOLUME_STATUS): { state: "ok"|"error", points, triangles, buildMs }.
  function setScene3dStatus(state, info) {
    if (typeof window !== "undefined") {
      window.__PETEK_SCENE3D_STATUS = Object.assign({ state: state }, info || {});
    }
  }

  function renderScene3d() {
    var host = document.getElementById("scene3d-host");
    var sc = App.payload.scene3d;
    if (!sc || !window.THREE) { showEmpty("No 3-D scene bundle / WebGL unavailable."); return; }
    hideEmpty();
    // LOUD, never silent: a malformed bundle (bad block, inconsistent arrays)
    // surfaces a banner + an error status hook, not a blank canvas.
    try {
      if (!s3d) initScene3d(host);
      resizeScene3d(host);
      if (!s3dBuilt || s3dBuilt._for !== sc) {
        buildScene3d(sc);
        if (App.tab === "scene3d") buildPanel(); // counts + fit-z now known
      } else if (s3dBuilt._colormap !== S.colormap) {
        s3dBuilt._colormap = S.colormap; recolorScene3d(sc);
      }
      applyScene3dVisibility();
      restyleScene3dLines();
      s3d.group.scale.set(1, S.s3dExag, 1);
      if (!s3d.framed) { frameScene3d(); s3d.framed = true; }
      updateS3dBadge();
      drawScene3dLegend(sc);
      if (s3dBuilt._degraded) showScene3dDegradeBanner(s3dBuilt._degraded); else hideBanner();
      s3d.render();
    } catch (e) {
      setScene3dStatus("error", { reason: String((e && e.message) || e) });
      showEmpty("3-D scene failed to build — " + String((e && e.message) || e));
      showBanner("3-D scene failed",
        String((e && e.message) || e),
        "The scene3d payload is malformed or exceeds this browser's limits. Re-export the view.");
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
    controls.addEventListener("change", function () { renderer.render(scene, camera); });
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    var dir = new THREE.DirectionalLight(0xffffff, 0.7); dir.position.set(1, 1, 2); scene.add(dir);
    var group = new THREE.Group(); scene.add(group);
    s3d = { THREE: THREE, renderer: renderer, scene: scene, camera: camera, controls: controls, group: group, badge: badge, framed: false };
    s3d.render = function () { renderer.render(scene, camera); };
    renderer.domElement.addEventListener("mousemove", scene3dHover);
    renderer.domElement.addEventListener("mouseleave", hideReadout);
  }
  function resizeScene3d(host) {
    var w = host.clientWidth || 1, h = host.clientHeight || 1;
    s3d.renderer.setSize(w, h, false);
    s3d.camera.aspect = w / h; s3d.camera.updateProjectionMatrix();
  }

  function s3dRampVertex(col, i, t) {
    var c = isFinite(t) ? rampColor(S.colormap, t) : null;
    if (!c) c = S3D_NEUTRAL;
    col[i * 3] = c[0] / 255; col[i * 3 + 1] = c[1] / 255; col[i * 3 + 2] = c[2] / 255;
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
      return { f: f, n: (f.length / 3) | 0, name: c.name };
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
      m.nodes.forEach(function (nd) { ext(nd[0], nd[1], nd[2] == null ? NaN : nd[2]); });
    });
    (sc.wells || []).forEach(function (w) {
      w.trajectory.forEach(function (p) { ext(p[0], p[1], p[2] == null ? NaN : p[2]); });
    });
    (sc.lattices || []).forEach(function (L) {
      L.lines.forEach(function (line) { line.forEach(function (p) { ext(p[0], p[1], refZ); }); });
    });
    (sc.outlines || []).forEach(function (ring) { ring.forEach(function (p) { ext(p[0], p[1], refZ); }); });
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
    (sc.meshes || []).forEach(function (m) { totalTris += m.triangles.length; });
    var totalPts = 0;
    clouds.forEach(function (c) { totalPts += c.n; });
    var triStride = totalTris > budget ? Math.ceil(totalTris / budget) : 1;
    var ptStride = totalPts > budget ? Math.ceil(totalPts / budget) : 1;

    var built = {
      _for: sc, _colormap: S.colormap,
      pointObjs: [], meshObjs: [], wellObjs: [],
      latticeObjs: [], contourObjs: [], outlineObjs: [],
      pointCount: 0, triangleCount: 0,
      extent: { dx: Math.max(xmax - xmin, ymax - ymin) || 1, dz: (zmax - zmin) || 1 },
      depthRange: { min: zmin, max: zmax },
      _degraded: null,
    };

    // ---- point clouds: ONE THREE.Points per cloud, per-vertex ramp colours --
    var pc = sc.point_color;
    clouds.forEach(function (c) {
      var kept = Math.ceil(c.n / ptStride);
      var pos = new Float32Array(kept * 3), col = new Float32Array(kept * 3);
      var k = 0;
      for (var q = 0; q < c.n; q += ptStride) {
        var z = c.f[q * 3 + 2];
        pos[k * 3] = c.f[q * 3] - cx;
        pos[k * 3 + 1] = ry(z);
        pos[k * 3 + 2] = c.f[q * 3 + 1] - cy;
        var t = pc && pc.range ? (z - pc.range[0]) / ((pc.range[1] - pc.range[0]) || 1) : NaN;
        s3dRampVertex(col, k, isFinite(z) ? t : NaN);
        k++;
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      var mat = new THREE.PointsMaterial({ size: 2.5, sizeAttenuation: false, vertexColors: true });
      var obj = new THREE.Points(geo, mat);
      s3d.group.add(obj);
      built.pointObjs.push({ obj: obj, geo: geo, f: c.f, n: c.n, stride: ptStride, kept: kept });
      built.pointCount += kept;
    });

    // ---- surface meshes: value-coloured (fill=) or neutral + wireframe ------
    (sc.meshes || []).forEach(function (m) {
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
      s3d.group.add(mesh);
      built.meshObjs.push({ mesh: mesh, geo: geo, m: m, hasValues: hasValues });
      built.triangleCount += idx.length / 3;
    });

    // ---- geometry lattice lines: one LineSegments per geometry at ref_z -----
    (sc.lattices || []).forEach(function (L) {
      var obj = polylinesToSegments(L.lines, function (p) { return [p[0] - cx, refZ - cz, p[1] - cy]; }, token("--muted"));
      if (obj) { s3d.group.add(obj); built.latticeObjs.push(obj); }
    });

    // ---- contour polylines at their level elevation (minor + major batches) -
    var minor = [], major = [];
    (sc.contours || []).forEach(function (cs) {
      var dst = cs.major ? major : minor;
      cs.lines.forEach(function (line) {
        for (var q = 0; q < line.length - 1; q++) {
          dst.push([line[q][0] - cx, cs.level - cz, line[q][1] - cy]);
          dst.push([line[q + 1][0] - cx, cs.level - cz, line[q + 1][1] - cy]);
        }
      });
    });
    if (minor.length) {
      var mn = segmentsFromPairs(minor, token("--text-secondary"), 0.55);
      s3d.group.add(mn); built.contourObjs.push(mn);
    }
    if (major.length) {
      var mj = segmentsFromPairs(major, token("--text-secondary"), 0.9);
      s3d.group.add(mj); built.contourObjs.push(mj);
    }

    // ---- outline rings (flat at ref_z) ---------------------------------------
    (sc.outlines || []).forEach(function (ring) {
      var obj = polylinesToSegments([ring], function (p) { return [p[0] - cx, refZ - cz, p[1] - cy]; }, token("--text-secondary"));
      if (obj) { s3d.group.add(obj); built.outlineObjs.push(obj); }
    });

    // ---- well trajectories (identity-coloured) + a wellhead marker ----------
    (sc.wells || []).forEach(function (w) {
      var pts = [];
      w.trajectory.forEach(function (p) {
        if (p[2] == null || !isFinite(p[2])) return; // z-less samples are gaps
        pts.push(new THREE.Vector3(p[0] - cx, p[2] - cz, p[1] - cy));
      });
      if (!pts.length) return;
      var color = idColor("well:" + w.id) || "#888";
      var line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: new THREE.Color(color) })
      );
      // wellhead marker: a screen-sized point sprite (immune to z-exaggeration)
      var mgeo = new THREE.BufferGeometry();
      mgeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([pts[0].x, pts[0].y, pts[0].z]), 3));
      var marker = new THREE.Points(mgeo, new THREE.PointsMaterial({ size: 8, sizeAttenuation: false, color: new THREE.Color(color) }));
      s3d.group.add(line); s3d.group.add(marker);
      built.wellObjs.push(line); built.wellObjs.push(marker);
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
    setScene3dStatus("ok", {
      points: built.pointCount, triangles: built.triangleCount,
      meshes: built.meshObjs.length, wells: (sc.wells || []).length,
      buildMs: built.buildMs,
    });
  }

  function bakeMeshColors(m, col) {
    var r0 = m.range[0], span = (m.range[1] - m.range[0]) || 1;
    for (var q = 0; q < m.nodes.length; q++) {
      var v = m.values[q];
      s3dRampVertex(col, q, v == null ? NaN : (v - r0) / span);
    }
  }

  // Colormap flip: re-bake point + value-mesh vertex colours in place (the
  // geometry/positions never rebuild — the volume tab's recolour idiom).
  function recolorScene3d(sc) {
    var pc = sc.point_color;
    s3dBuilt.pointObjs.forEach(function (o) {
      var col = o.geo.attributes.color.array;
      var k = 0;
      for (var q = 0; q < o.n; q += o.stride) {
        var z = o.f[q * 3 + 2];
        var t = pc && pc.range ? (z - pc.range[0]) / ((pc.range[1] - pc.range[0]) || 1) : NaN;
        s3dRampVertex(col, k, isFinite(z) ? t : NaN);
        k++;
      }
      o.geo.attributes.color.needsUpdate = true;
    });
    s3dBuilt.meshObjs.forEach(function (o) {
      if (!o.hasValues) return;
      bakeMeshColors(o.m, o.geo.attributes.color.array);
      o.geo.attributes.color.needsUpdate = true;
    });
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
    s3dBuilt.pointObjs.forEach(function (o) { o.obj.visible = S.s3dShow.points; });
    s3dBuilt.meshObjs.forEach(function (o) {
      o.mesh.visible = S.s3dShow.meshes;
      o.mesh.material.wireframe = S.s3dWireframe;
    });
    s3dBuilt.latticeObjs.forEach(function (o) { o.visible = S.s3dShow.lattice; });
    s3dBuilt.contourObjs.forEach(function (o) { o.visible = S.s3dShow.contours; });
    s3dBuilt.outlineObjs.forEach(function (o) { o.visible = S.s3dShow.outlines; });
    s3dBuilt.wellObjs.forEach(function (o) { o.visible = S.s3dShow.wells; });
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

  function scene3dHover(ev) {
    // lightweight (the volume tab's readout idiom): counts + the TRUE
    // (un-exaggerated) elevation extent — the exaggeration is display-only.
    if (!s3dBuilt) return;
    var rows = [["", App.payload.property || "3D scene"]];
    if (s3dBuilt.pointCount) rows.push(["points", s3dBuilt.pointCount.toLocaleString()]);
    if (s3dBuilt.triangleCount) rows.push(["triangles", s3dBuilt.triangleCount.toLocaleString()]);
    rows.push(["z", fmt(s3dBuilt.depthRange.min) + " – " + fmt(s3dBuilt.depthRange.max) + " m (z ×" + S.s3dExag + ")"]);
    var pc = App.payload.scene3d.point_color;
    if (pc && pc.range) rows.push(["colour range", fmt(pc.range[0]) + " – " + fmt(pc.range[1])]);
    showReadout(ev, rows);
  }

  // The scene3d control panel: colormap + z-exag (+ fit) + per-layer toggles.
  function buildScene3dPanel(body) {
    var sc = App.payload.scene3d;
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
    var pc = sc.point_color, pointsRampDrawn = false;
    if (S.s3dShow.meshes) {
      (sc.meshes || []).forEach(function (m) {
        if (m.values && m.range) {
          rampBlock(lg, typeIcon("fill"), disp(m, m.name), m.range[0], m.range[1]);
        } else {
          keys.appendChild(keyRow(disp(m, m.name) || "mesh", token("--muted"), false));
        }
      });
    }
    (sc.layers || []).forEach(function (ly) {
      if (ly.kind === "points") {
        if (!S.s3dShow.points || !(sc.points || []).length) return;
        var plabel = ly.name ? pretty(ly.name) : "points";
        if (pc && pc.range && !pointsRampDrawn) {
          pointsRampDrawn = true;
          rampBlock(lg, typeIcon("points", rampCss(S.colormap, 0.75)),
            plabel + " · " + (pc.by || "z"), pc.range[0], pc.range[1]);
        } else {
          keys.appendChild(iconKeyRow("points", plabel,
            pc && pc.range ? rampCss(S.colormap, 0.75) : token("--accent")));
        }
      } else if (ly.kind === "lines") {
        if (!S.s3dShow.lattice || !(sc.lattices || []).length) return;
        keys.appendChild(iconKeyRow("lines", ly.name ? pretty(ly.name) : "grid lines", token("--muted")));
      } else if (ly.kind === "contours") {
        if (!S.s3dShow.contours || !(sc.contours || []).length) return;
        keys.appendChild(iconKeyRow("contours", ly.name ? pretty(ly.name) : "contours", token("--text-secondary")));
      } else if (ly.kind === "wells") {
        if (!S.s3dShow.wells) return;
        keys.appendChild(iconKeyRow("wells", pretty(ly.name || "well"), idColor("well:" + ly.name)));
      }
    });
    if (keys.childNodes.length) lg.appendChild(keys);
    lg.style.display = lg.childNodes.length ? "block" : "none";
  }

