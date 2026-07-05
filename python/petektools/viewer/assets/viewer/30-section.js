  // ================================================================== SECTION
  function renderSection() {
    var cv = document.getElementById("section-canvas");
    if (!S.sections.length) { showEmpty("No sections. Draw a fence or click a well on the Map tab."); return; }
    hideEmpty(); sizeCanvas(cv);
    var ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = token("--surface-1"); ctx.fillRect(0, 0, cv.width, cv.height);

    var b = S.sections[Math.min(S.sectionIdx, S.sections.length - 1)];
    var cols = b.columns || [];
    if (!cols.length) { showEmpty("Section has no columns (trace outside the grid)."); return; }

    // domain. The depth axis frames the RESERVOIR ENVELOPE (layer tops/bases +
    // contacts) plus a margin — NOT the full surface→TD bore path, which would
    // squash the reservoir to a sliver. The bore path is clamped into this window
    // and an off-scale arrow marks where it exits (drawn below).
    // NULL-SAFETY (the NaN=inactive wire contract): petekStatic emits f64::NAN for
    // an inactive/truncated layer, which serde serializes to JSON `null`. The
    // global isFinite() COERCES (`Number(null) === 0`), so `isFinite(null)` is
    // true and a null depth would count as depth 0 — dragging zlo to 0 and
    // stretching the frame to a rogue negative top. Number.isFinite() rejects
    // null/undefined/strings; every depth read below uses it.
    var dmin = cols[0].distance_m, dmax = cols[cols.length - 1].distance_m || 1;
    // Sugar-cube ruling (v4-additive): when each column carries the per-k EDGE
    // arrays (layer_tops_l/r + layer_bases_l/r = the cell interval at the
    // column's left/right fence edges, NaN-gapped exactly like layer_tops) and
    // the payload does not declare `sugar_cube: true`, cells render as
    // TRAPEZOIDS that follow the zone edges (dip) WITHIN each column — the
    // default. `sugar_cube: true`, or an older payload without the edge arrays,
    // keeps the flat-rect ("sugar cube") path unchanged. Centroid
    // layer_tops/layer_bases stay authoritative for hover.
    var nkAll = cols[0].layer_tops.length;
    var hasEdges = !b.sugar_cube
      && cols[0].layer_tops_l && cols[0].layer_tops_r
      && cols[0].layer_bases_l && cols[0].layer_bases_r
      && cols[0].layer_tops_l.length === nkAll
      && cols[0].layer_tops_r.length === nkAll
      && cols[0].layer_bases_l.length === nkAll
      && cols[0].layer_bases_r.length === nkAll;
    var resDepths = [];
    cols.forEach(function (c) {
      c.layer_tops.forEach(function (v) { if (Number.isFinite(v)) resDepths.push(v); });
      c.layer_bases.forEach(function (v) { if (Number.isFinite(v)) resDepths.push(v); });
      if (hasEdges) {
        // the dipping edge extremes can exceed the centroid envelope — frame them
        [c.layer_tops_l, c.layer_tops_r, c.layer_bases_l, c.layer_bases_r].forEach(function (arr) {
          arr.forEach(function (v) { if (Number.isFinite(v)) resDepths.push(v); });
        });
      }
    });
    (b.contacts || []).forEach(function (c) { if (Number.isFinite(c.depth_m)) resDepths.push(c.depth_m); });
    if (!resDepths.length) { showEmpty("Section has no reservoir layers to frame."); return; }
    var zlo = Math.min.apply(null, resDepths), zhi = Math.max.apply(null, resDepths);
    var margin = Math.max(25, 0.12 * (zhi - zlo));
    var zmin = zlo - margin, zmax = zhi + margin;
    var padL = 60, padR = 20, padT = 24, padB = 42;
    var W = cv.width - padL - padR, H = cv.height - padT - padB;
    // vertical exaggeration compresses the horizontal so relief reads; here we
    // just scale the depth axis span by vexag against a nominal 1:1.
    function X(d) { return padL + ((d - dmin) / ((dmax - dmin) || 1)) * W; }
    function Y(z) { return padT + ((z - zmin) / ((zmax - zmin) || 1)) * H; }

    var range = App.payload.volume ? App.payload.volume.value_range : { min: 0, max: 1 };
    var span = (range.max - range.min) || 1;
    var nk = cols[0].layer_tops.length;

    // Zone-colour mode: a SectionBundle may carry `zones: [{name, color?}]` and
    // per-column `zone_ids` (per-k u16, aligned/NaN-gapped exactly like `values`;
    // an index into `zones`). With that payload present, "Color by: zone" fills
    // each cell by zone IDENTITY instead of the property ramp — the trapezoid /
    // sugar-cube geometry path is unchanged, only the fill SOURCE changes. Absent
    // (no `zones` or no `zone_ids`) → the select hides and we stay on the property
    // colormap (graceful fallback, no error).
    var zones = b.zones || [];
    var hasZoneData = zones.length > 0 && cols.some(function (c) { return c.zone_ids && c.zone_ids.length; });
    var zoneMode = hasZoneData && S.sectionColorBy === "zone";

    // The screen x-extent of column ci (midpoints to its `step`-strided
    // neighbours; the fence-edge positions the trapezoid corners hang on).
    function colEdgeX(ci, step) {
      var c = cols[ci];
      var p = Math.max(0, ci - step), n = Math.min(cols.length - 1, ci + step);
      var xL = ci === 0 ? X(c.distance_m) : X((cols[p].distance_m + c.distance_m) / 2);
      var xR = ci + step >= cols.length ? X(c.distance_m) : X((c.distance_m + cols[n].distance_m) / 2);
      return [xL, xR];
    }

    // fills (property colour per layer cell). WINDOWED: at very high column counts
    // draw at most ~2 columns per horizontal pixel (sub-pixel columns can't be
    // resolved), so the O(columns × nk) fill loop stays bounded on a dense section.
    var hasVals = b.property && cols[0].values && cols[0].values.length === nk;
    var cstride = Math.max(1, Math.ceil(cols.length / Math.max(1, W * 2)));
    for (var ci = 0; ci < cols.length; ci += cstride) {
      var c = cols[ci];
      var ex = colEdgeX(ci, cstride), xL = ex[0], xR = ex[1];
      for (var k = 0; k < nk; k++) {
        // a null/NaN top or base is an INACTIVE layer cell (pinched/truncated) —
        // nothing to fill (Y(null) would land the rect at depth 0).
        if (!Number.isFinite(c.layer_tops[k]) || !Number.isFinite(c.layer_bases[k])) continue;
        ctx.fillStyle = zoneMode
          ? sectionZoneColor(zones, c.zone_ids && c.zone_ids[k])
          : (hasVals ? rampCss(S.colormap, (c.values[k] - range.min) / span) : token("--grid"));
        if (hasEdges
          && Number.isFinite(c.layer_tops_l[k]) && Number.isFinite(c.layer_tops_r[k])
          && Number.isFinite(c.layer_bases_l[k]) && Number.isFinite(c.layer_bases_r[k])) {
          // TRAPEZOID (default): (d0,top_l)-(d1,top_r)-(d1,bot_r)-(d0,bot_l) —
          // the cell follows the zone-edge dip across the column.
          ctx.beginPath();
          ctx.moveTo(xL, Y(c.layer_tops_l[k]));
          ctx.lineTo(xR, Y(c.layer_tops_r[k]));
          ctx.lineTo(xR, Y(c.layer_bases_r[k]));
          ctx.lineTo(xL, Y(c.layer_bases_l[k]));
          ctx.closePath();
          ctx.fill();
        } else {
          // sugar-cube mode / older payload / an edge-NaN cell: the flat rect.
          var yt = Y(c.layer_tops[k]), yb = Y(c.layer_bases[k]);
          ctx.fillRect(xL, yt, Math.max(1, xR - xL), Math.max(1, yb - yt));
        }
      }
    }

    // horizon traces (top of layer 0, base of layer nk-1). With edge arrays the
    // trace follows the dip through each column's (xL,edge_l)->(xR,edge_r) pair;
    // otherwise the centroid polyline (unchanged).
    if (S.showHorizons) {
      if (hasEdges) {
        drawEdgeTrace(ctx, cols, colEdgeX, function (c) { return [c.layer_tops_l[0], c.layer_tops_r[0]]; }, Y, idColor("hz:" + b.top_name));
        drawEdgeTrace(ctx, cols, colEdgeX, function (c) { return [c.layer_bases_l[nk - 1], c.layer_bases_r[nk - 1]]; }, Y, idColor("hz:" + b.base_name));
      } else {
        drawTrace(ctx, cols, function (c) { return c.layer_tops[0]; }, X, Y, idColor("hz:" + b.top_name));
        drawTrace(ctx, cols, function (c) { return c.layer_bases[nk - 1]; }, X, Y, idColor("hz:" + b.base_name));
      }
    }
    // interior-horizon traces (v4): one polyline per interior framework horizon,
    // its `depths` array parallel to `columns` (NaN where a column doesn't reach
    // it — the line breaks there), labelled once at the right per the section
    // idiom. On a LONG fence (~16 km) every trace ends hard against the right
    // edge, so the labels pile into one x-column. The slot ledger is extended on
    // TWO axes: a vertical slot (labelSlot) as before, PLUS a horizontal stagger
    // — a label sharing a crowded vertical band steps left one notch (with a
    // leader line back to its trace end) — and a FADE for a label dragged far
    // from its own line, so the on-line labels stay legible instead of a blob.
    if (S.showHorizons && b.horizon_traces && b.horizon_traces.length) {
      var hzLabelY = [];
      var hzLabels = [];   // placed labels {name,x,y,alpha} — exposed for the test
      var displacedCount = 0;   // how many labels the ledger has had to drag off-line
      ctx.font = "10px system-ui"; ctx.textAlign = "right"; ctx.textBaseline = "bottom";
      b.horizon_traces.forEach(function (ht) {
        var depths = ht.depths || [];
        ctx.strokeStyle = idColor("hz:" + ht.name); ctx.lineWidth = 1.5; ctx.lineJoin = "round";
        ctx.beginPath(); var started = false, lastX = null, lastY = null;
        cols.forEach(function (c, i) {
          var z = depths[i];
          if (!Number.isFinite(z)) { started = false; return; }   // null/NaN gap
          var x = X(c.distance_m), y = Y(z);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          lastX = x; lastY = y;
        });
        ctx.stroke();
        if (lastX == null) return;
        var anchorX = Math.min(lastX, cv.width - padR) - 2;
        var hy = labelSlot(hzLabelY, lastY - 2, padT + 10, padT + H - 2);
        // A crowded fence drags a label off its trace end (the vertical slot moved
        // it). Such DISPLACED labels also STAGGER horizontally — each steps one
        // 40px notch left of the last — so their leader lines fan out from the
        // right edge instead of stacking into one x-column, and a heavily-dragged
        // label FADES so the on-line labels stay dominant.
        var displaced = Math.abs(hy - (lastY - 2));
        var lx = anchorX, alpha = 1;
        if (displaced > 6) {
          lx = Math.max(padL + 30, anchorX - displacedCount * 40);
          alpha = displaced > 26 ? 0.5 : 1;
          displacedCount++;
          // leader line ties the staggered label back to where its trace ends.
          ctx.save(); ctx.globalAlpha = alpha * 0.55; ctx.strokeStyle = idColor("hz:" + ht.name);
          ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(lx, hy - 3); ctx.stroke(); ctx.restore();
        }
        ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = token("--text-secondary");
        ctx.fillText(pretty(ht.name), lx, hy); ctx.restore();
        hzLabels.push({ name: ht.name, x: lx, y: hy, alpha: alpha });
      });
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      if (typeof window !== "undefined") window.__PETEK_SECTION_LABELS = hzLabels;
    } else if (typeof window !== "undefined") {
      window.__PETEK_SECTION_LABELS = [];
    }
    // path_z overlay (AlongBore) — clamped to the framed window with off-scale
    // arrows where the true trajectory exits it.
    if (S.showPathZ && cols.some(function (c) { return c.path_z != null; })) {
      var label = S.sectionLabels[S.sectionIdx] || "bore";
      drawBorePath(ctx, cols, X, Y, zmin, zmax, idColor("well:" + label));
    }
    // contacts (flat depth lines). SAME-DEPTH pairs (a GOC/OWC at one depth)
    // COMBINE into a single label ("GOC + OWC 2050 m") — two labels at one line
    // can only overprint; distinct depths stack via the slot ledger, which
    // searches AWAY from the nearer frame edge so a clamped label never
    // overprints another (the old nudge clamped after colliding, so two
    // bottom-edge labels landed on the same y).
    if (S.showContacts) {
      var usedY = [];
      var groups = {};   // rounded depth -> { depth, kinds[] }, insertion-ordered
      (b.contacts || []).forEach(function (c) {
        if (!Number.isFinite(c.depth_m)) return;   // a null contact depth draws nothing
        var y = Y(c.depth_m); ctx.strokeStyle = idColor("ct:" + c.kind); ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cv.width - padR, y); ctx.stroke(); ctx.setLineDash([]);
        var key = Math.round(c.depth_m * 2) / 2;   // 0.5 m bucket = "same depth"
        if (!groups[key]) groups[key] = { depth: c.depth_m, kinds: [] };
        if (groups[key].kinds.indexOf(c.kind) < 0) groups[key].kinds.push(c.kind);
      });
      Object.keys(groups).forEach(function (key) {
        var g = groups[key];
        var ly = labelSlot(usedY, Y(g.depth) - 3, padT + 9, padT + H - 2);
        ctx.fillStyle = token("--text-secondary"); ctx.font = "11px system-ui";
        ctx.fillText(g.kinds.map(pretty).join(" + ") + " " + fmt(g.depth, "m"), padL + 4, ly);
      });
    }

    // axes (recessive hairlines)
    ctx.strokeStyle = token("--baseline"); ctx.lineWidth = 1;
    ctx.strokeRect(padL, padT, W, H);
    ctx.fillStyle = token("--muted"); ctx.font = "10px system-ui"; ctx.textBaseline = "middle";
    for (var t = 0; t <= 4; t++) {
      var zv = zmin + (t / 4) * (zmax - zmin), yv = Y(zv);
      ctx.fillText(Math.round(zv) + "", 6, yv);
      ctx.strokeStyle = token("--grid"); ctx.beginPath(); ctx.moveTo(padL, yv); ctx.lineTo(padL + W, yv); ctx.stroke();
    }
    ctx.textBaseline = "alphabetic";
    ctx.fillText("distance (m) →", padL, cv.height - 8);
    ctx.save(); ctx.translate(14, padT + H / 2); ctx.rotate(-Math.PI / 2); ctx.fillText("depth (m, +down)", 0, 0); ctx.restore();

    S._sectionHit = { cols: cols, X: X, Y: Y, nk: nk, dmin: dmin, dmax: dmax, hasVals: hasVals, range: range, span: span, units: b.property, zones: hasZoneData ? zones : null };
    // Expose the computed depth frame for the test harness (like __PETEK_RENDER_MS):
    // the null-poisoning regression asserts zmin/zmax frame the FINITE data only.
    // __PETEK_SECTION_MODE names the active cell-render path ("trapezoid" =
    // zone-edge-following default; "rect" = sugar-cube / legacy payload).
    // __PETEK_SECTION_COLORBY names the active fill source ("property" | "zone").
    if (typeof window !== "undefined") {
      window.__PETEK_SECTION_FRAME = { zmin: zmin, zmax: zmax, zlo: zlo, zhi: zhi };
      window.__PETEK_SECTION_MODE = hasEdges ? "trapezoid" : "rect";
      window.__PETEK_SECTION_COLORBY = zoneMode ? "zone" : "property";
      window.__PETEK_SECTION_HAS_ZONES = hasZoneData;
    }
    // Legend: zone chips in zone mode (the fill is categorical, no ramp); the
    // property ramp otherwise. Horizon / contact identity chips overlay both.
    if (zoneMode) drawFieldLegend(null);
    else drawFieldLegend(hasVals ? { name: b.property || "value", units: "fraction", range: range, kind: "property" } : null);
  }
  // Resolve a section cell's zone fill. A user-declared hex on the zone WINS
  // (the owner's colour choice — logged, but NOT palette-validated: by design the
  // consumer's declared colour beats the automatic categorical assignment). A
  // zone with no declared colour takes its fixed categorical identity slot — the
  // SAME slot the volume/wells zone legend uses for that name (identity follows
  // the entity across views). A null/NaN zone id (a gapped cell) falls back to
  // the recessive grid fill (the geometry still draws; only the colour is muted).
  function sectionZoneColor(zones, zid) {
    if (zid == null || !isFinite(zid)) return token("--grid");
    var z = zones[zid];
    if (!z) return token("--grid");
    if (z.color) { noteUserZoneHex(z.name, z.color); return z.color; }
    return idColor("zone:" + z.name);
  }
  // User-declared zone hexes bypass the validated categorical palette by design
  // (owner's choice wins). We do not enforce a contrast/CVD check on them — but we
  // SURFACE the fact once per bundle as a console.info so it is auditable, never
  // silently swallowed (the validator is advisory here, not a gate).
  var _loggedZoneHex = {};
  function noteUserZoneHex(name, hex) {
    if (_loggedZoneHex[name] === hex) return;
    _loggedZoneHex[name] = hex;
    if (typeof console !== "undefined" && console.info) {
      console.info("[petek.viewer] zone \"" + name + "\" uses a user-declared colour " + hex +
        " (owner override — applied as declared; not palette-validated by design).");
    }
  }
  // Find a free 12px label slot near `want`, searching AWAY from the nearer
  // frame edge (down normally; up when `want` sits in the bottom band), clamped
  // to [top, bottom]; records the slot in `used`. Shared by the contact and
  // interior-horizon labels so edge-clamped labels stack instead of overprint.
  function labelSlot(used, want, top, bottom) {
    var ly = Math.max(top, Math.min(bottom, want));
    var dir = ly + 13 > bottom ? -13 : 13, tries = 0;
    while (used.some(function (u) { return Math.abs(u - ly) < 12; }) && tries++ < 40) {
      ly += dir;
      if (ly > bottom || ly < top) { dir = -dir; ly = Math.max(top, Math.min(bottom, want)) + dir; }
    }
    used.push(ly);
    return ly;
  }
  // Edge-following horizon trace: per column, the segment (xL, z_l) -> (xR, z_r)
  // so the line carries the within-column dip the trapezoid fill shows. `f`
  // returns [z_left, z_right]; a non-finite pair BREAKS the polyline (the same
  // Number.isFinite null-gap idiom as drawTrace).
  function drawEdgeTrace(ctx, cols, colEdgeX, f, Y, color) {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round";
    ctx.beginPath();
    var started = false;
    cols.forEach(function (c, ci) {
      var zz = f(c);
      if (!Number.isFinite(zz[0]) || !Number.isFinite(zz[1])) { started = false; return; }
      var ex = colEdgeX(ci, 1);
      if (!started) { ctx.moveTo(ex[0], Y(zz[0])); started = true; } else ctx.lineTo(ex[0], Y(zz[0]));
      ctx.lineTo(ex[1], Y(zz[1]));
    });
    ctx.stroke();
  }
  function drawTrace(ctx, cols, f, X, Y, color, wide) {
    ctx.strokeStyle = color; ctx.lineWidth = wide ? 2.5 : 2; ctx.lineJoin = "round";
    ctx.beginPath();
    var started = false;
    // Number.isFinite rejects a JSON `null` (inactive layer) — the global
    // isFinite coerces null to 0 and would draw a rogue flat trace at Y(0).
    // A null run BREAKS the polyline (gap), matching the horizon-trace idiom.
    cols.forEach(function (c) { var z = f(c); if (!Number.isFinite(z)) { started = false; return; } var x = X(c.distance_m), y = Y(z); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); });
    ctx.stroke();
  }
  // Draw the along-bore trace clamped to [zmin, zmax]; where the true path exits
  // the framed depth window, drop an off-scale arrow (spaced ≥ 44px) pointing the
  // way the bore continues.
  function drawBorePath(ctx, cols, X, Y, zmin, zmax, color) {
    var pts = cols.filter(function (c) { return c.path_z != null && isFinite(c.path_z); });
    if (!pts.length) return;
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineJoin = "round";
    ctx.beginPath();
    var started = false;
    pts.forEach(function (c) {
      var z = Math.max(zmin, Math.min(zmax, c.path_z));
      var x = X(c.distance_m), y = Y(z);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = color;
    var lastArrowX = -1e9;
    pts.forEach(function (c) {
      if (c.path_z >= zmin && c.path_z <= zmax) return;
      var x = X(c.distance_m);
      if (x - lastArrowX < 44) return;
      lastArrowX = x;
      var up = c.path_z < zmin;
      drawArrow(ctx, x, up ? Y(zmin) : Y(zmax), up);
    });
  }
  function drawArrow(ctx, x, y, up) {
    var h = 7, dir = up ? -1 : 1, base = y + dir * 3;
    ctx.beginPath();
    ctx.moveTo(x, base - dir * h);
    ctx.lineTo(x - 4, base);
    ctx.lineTo(x + 4, base);
    ctx.closePath(); ctx.fill();
  }
  function sectionHover(cv, ev) {
    var h = S._sectionHit; if (!h) return;
    var px = canvasPx(cv, ev);
    // nearest column by distance
    var best = null, bd = 1e9;
    h.cols.forEach(function (c, i) { var d = Math.abs(h.X(c.distance_m) - px[0]); if (d < bd) { bd = d; best = i; } });
    if (best == null) { hideReadout(); return; }
    var c = h.cols[best];
    // layer under pointer (an inactive — null/NaN — layer cell can never hit;
    // unguarded, Y(null)=Y(0) would make a phantom band match near the frame top)
    var kHit = -1;
    for (var k = 0; k < h.nk; k++) {
      if (!Number.isFinite(c.layer_tops[k]) || !Number.isFinite(c.layer_bases[k])) continue;
      if (px[1] >= h.Y(c.layer_tops[k]) && px[1] <= h.Y(c.layer_bases[k])) { kHit = k; break; }
    }
    var rows = [["", "dist " + Math.round(c.distance_m) + " m · i " + c.i + " j " + c.j]];
    if (kHit >= 0) {
      rows.push(["layer", "k " + kHit + "  (" + Math.round(c.layer_tops[kHit]) + "–" + Math.round(c.layer_bases[kHit]) + " m)"]);
      // zone name at the hit cell (whenever the section carries zone bands — so a
      // zone read is available in property mode too, and is the headline in zone
      // mode). Sits above the property value: "zone name + the property value".
      if (h.zones && c.zone_ids) {
        var zid = c.zone_ids[kHit];
        if (zid != null && isFinite(zid) && h.zones[zid]) rows.push(["zone", pretty(h.zones[zid].name)]);
      }
      if (h.hasVals) rows.push(["value", fmt(c.values[kHit], "fraction")]);
    }
    if (c.path_z != null) rows.push(["bore z", fmt(c.path_z, "m")]);
    showReadout(ev, rows);
  }

