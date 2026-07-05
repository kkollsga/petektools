  // ======================================================================= WELLS
  // Multi-well correlation panel (canvas-2D). N wells side-by-side; per well a set
  // of tracks (a flag strip + continuous curve tracks: PHIE w/ cutoff fill, NTG,
  // SW); a SHARED inverted depth axis (depth down); tops as cross-track lines
  // labelled once; zone shading between tops; boxed per-track headers (name +
  // hi–lo scale) instead of legends. TWO hanging modes: TVD (absolute) and
  // FLATTEN-ON-PICK (each well shifted so a chosen horizon aligns; wells with no
  // such pick are parked unflattened + tagged). Curve identity is by TRACK
  // (mnemonic), never by well — PHIE is one colour everywhere.
  function trackRatio(kind) { return kind === "flag" ? 0.42 : 1.0; }
  function curveAutoRange(track) {
    if (track._ar) return track._ar;
    var r = track.curve.range;
    if (r && isFinite(r.min) && isFinite(r.max)) { track._ar = r; return r; }
    var lo = Infinity, hi = -Infinity, v = track.curve.values || [];
    for (var q = 0; q < v.length; q++) { var x = v[q]; if (x === x) { if (x < lo) lo = x; if (x > hi) hi = x; } }
    track._ar = { min: isFinite(lo) ? lo : 0, max: isFinite(hi) ? hi : 1 };
    return track._ar;
  }
  // Shared depth window (TVD or flattened Δ) over the visible, non-parked wells.
  function wellsDepthWindow(vis) {
    var wl = S.wl, flat = wl.hang === "flatten" && !!wl.pick;
    var dmin = Infinity, dmax = -Infinity;
    vis.forEach(function (i) {
      var w = wl.wells[i], shift = flat ? pickShift(w, wl.pick) : 0;
      if (flat && shift == null) return;                 // parked — not in the shared window
      var lo, hi;
      if (w.zones.length) { lo = w.zones[0].top_tvd_m; hi = w.zones[w.zones.length - 1].base_tvd_m; }
      else if (w.tvd && w.tvd.length) { lo = w.tvd[0]; hi = w.tvd[w.tvd.length - 1]; }
      else return;
      dmin = Math.min(dmin, lo - shift); dmax = Math.max(dmax, hi - shift);
    });
    if (!isFinite(dmin)) {                               // every visible well parked → TVD fallback
      flat = false;
      vis.forEach(function (i) {
        var w = wl.wells[i];
        if (!w.tvd || !w.tvd.length) return;
        dmin = Math.min(dmin, w.tvd[0]); dmax = Math.max(dmax, w.tvd[w.tvd.length - 1]);
      });
    }
    if (!isFinite(dmin)) { dmin = 0; dmax = 1; }
    var pad = Math.max(2, 0.03 * (dmax - dmin));
    return { dmin: dmin - pad, dmax: dmax + pad, flat: flat };
  }

  function renderWells() {
    var cv = document.getElementById("wells-canvas");
    if (!S.wl) { showEmpty("No well-log bundle (wells_logs) in this payload."); return; }
    hideEmpty(); sizeCanvas(cv);
    var ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = token("--surface-1"); ctx.fillRect(0, 0, cv.width, cv.height);

    var vis = visibleWellIdx();
    if (!vis.length) { showEmpty("No wells selected. Toggle wells on in the panel."); return; }
    var win = wellsDepthWindow(vis);
    var padL = 56, padR = 14, padT = 82, padB = 28;
    var W = cv.width - padL - padR, H = cv.height - padT - padB;
    var groupGap = 14;
    var groupW = (W - groupGap * (vis.length - 1)) / vis.length;
    function Yshared(z) { return padT + ((z - win.dmin) / ((win.dmax - win.dmin) || 1)) * H; }

    var hit = [];
    vis.forEach(function (wi, gi) {
      var w = S.wl.wells[wi];
      var gx0 = padL + gi * (groupW + groupGap);
      var shift = win.flat ? pickShift(w, S.wl.pick) : 0;
      var parked = win.flat && shift == null;
      // Parked well: its own local TVD window fills the frame height (so its curves
      // are still legible), but it is clearly NOT on the shared datum — tagged.
      var locLo = 0, locHi = 1;
      if (parked) {
        locLo = w.zones.length ? w.zones[0].top_tvd_m : (w.tvd ? w.tvd[0] : 0);
        locHi = w.zones.length ? w.zones[w.zones.length - 1].base_tvd_m : (w.tvd ? w.tvd[w.tvd.length - 1] : 1);
        var lp = Math.max(2, 0.03 * (locHi - locLo)); locLo -= lp; locHi += lp;
      }
      function Y(z) { return parked ? padT + ((z - locLo) / ((locHi - locLo) || 1)) * H : Yshared(z - shift); }

      // derive tracks from the well's curves (flag strips + continuous curves)
      var tratio = 0; w.curves.forEach(function (c) { tratio += trackRatio(c.kind); });
      var usableW = groupW * 0.9;
      var tx = gx0, tracks = [];
      w.curves.forEach(function (c) {
        var tw = usableW * (trackRatio(c.kind) / (tratio || 1));
        tracks.push({ curve: c, x0: tx, w: tw }); tx += tw;
      });
      var spanX0 = gx0, spanX1 = tx;   // the well's full track span (for tops/zones)

      // zone shading between tops (translucent identity fill per zone name)
      w.zones.forEach(function (z) {
        var yt = Y(z.top_tvd_m), yb = Y(z.base_tvd_m);
        ctx.save(); ctx.globalAlpha = 0.14; ctx.fillStyle = idColor("zone:" + z.name);
        ctx.fillRect(spanX0, Math.min(yt, yb), spanX1 - spanX0, Math.abs(yb - yt)); ctx.restore();
      });

      // each track: box header + frame + curve/strip
      tracks.forEach(function (tk) { drawWellTrack(ctx, tk, w, Y, padT, H); });

      // tops: one horizontal rule across the well's tracks, labelled once at right
      w.tops.forEach(function (t) {
        var y = Y(t.tvd_m);
        if (y < padT - 1 || y > padT + H + 1) return;
        ctx.strokeStyle = idColor("hz:" + t.horizon); ctx.lineWidth = 1.5; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(spanX0, y); ctx.lineTo(spanX1, y); ctx.stroke();
        ctx.fillStyle = token("--text-secondary"); ctx.font = "10px system-ui";
        ctx.textAlign = "right"; ctx.textBaseline = "bottom";
        ctx.fillText(pretty(t.horizon), spanX1 - 2, y - 1);
        ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      });

      // well title (id + datum, flatten/parked tag)
      ctx.fillStyle = token("--text-primary"); ctx.font = "600 12px system-ui";
      ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      ctx.fillText(w.display, (spanX0 + spanX1) / 2, 18);
      ctx.fillStyle = token("--muted"); ctx.font = "10px system-ui";
      var sub = "KB " + fmt(w.datum) + " m";
      if (parked) sub = "no " + pretty(S.wl.pick) + " pick · TVD";
      else if (win.flat) sub = "Δ vs " + pretty(S.wl.pick);
      ctx.fillText(sub, (spanX0 + spanX1) / 2, 31);
      if (parked) {
        ctx.strokeStyle = token("--baseline"); ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
        ctx.strokeRect(spanX0, padT, spanX1 - spanX0, H); ctx.setLineDash([]);
      }
      ctx.textAlign = "left";

      hit.push({ wi: wi, x0: spanX0, x1: spanX1, tracks: tracks, Y: Y, parked: parked, shift: shift });
    });

    // shared inverted depth axis (left gutter) — recessive hairlines
    ctx.strokeStyle = token("--baseline"); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + H); ctx.stroke();
    ctx.fillStyle = token("--muted"); ctx.font = "10px system-ui"; ctx.textBaseline = "middle"; ctx.textAlign = "right";
    for (var t = 0; t <= 5; t++) {
      var zv = win.dmin + (t / 5) * (win.dmax - win.dmin), yv = Yshared(zv);
      ctx.fillText(Math.round(zv) + "", padL - 5, yv);
      ctx.strokeStyle = token("--grid"); ctx.beginPath(); ctx.moveTo(padL, yv); ctx.lineTo(cv.width - padR, yv); ctx.stroke();
    }
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    ctx.save(); ctx.translate(13, padT + H / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = token("--muted"); ctx.font = "10px system-ui"; ctx.textAlign = "center";
    ctx.fillText(win.flat ? "Δ depth vs " + pretty(S.wl.pick) + " (m)" : "TVD-SS (m, +down)", 0, 0);
    ctx.restore(); ctx.textAlign = "left";

    S._wellsHit = { wells: hit, win: win, padT: padT, H: H };
    drawWellsLegend();
  }

  // One track: boxed header (name + hi–lo scale), a light frame, then the curve
  // (continuous, with a cutoff line + reservoir fill for a curve that declares
  // one) or the flag strip (categorical bands). Butted against its neighbours.
  // Compact scale-end format so a narrow track's hi–lo numbers don't collide.
  function fmtScale(v) {
    if (v == null || !isFinite(v)) return "";
    if (v === 0) return "0";
    return Math.abs(v) >= 100 ? Math.round(v).toString() : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2);
  }
  function drawWellTrack(ctx, tk, w, Y, padT, H) {
    var c = tk.curve, x0 = tk.x0, tw = tk.w, x1 = x0 + tw;
    // frame
    ctx.strokeStyle = token("--grid"); ctx.lineWidth = 1; ctx.strokeRect(x0, padT, tw, H);
    // boxed header (name on top, hi–lo scale below — the petrophysical track header)
    var hy = padT - 30, hh = 26;
    ctx.strokeStyle = token("--border"); ctx.strokeRect(x0 + 1, hy, tw - 2, hh);
    ctx.fillStyle = token("--text-secondary"); ctx.font = "600 9px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(c.mnemonic, (x0 + x1) / 2, hy + 4);
    if (c.kind === "flag") {
      drawFlagStrip(ctx, tk, w, Y);
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      return;
    }
    // continuous: hi–lo scale text in the header (compact; skipped if too narrow)
    var r = curveAutoRange(tk);
    if (tw >= 46) {
      ctx.fillStyle = token("--muted"); ctx.font = "8px system-ui"; ctx.textBaseline = "top";
      ctx.textAlign = "left"; ctx.fillText(fmtScale(r.min), x0 + 3, hy + 16);
      ctx.textAlign = "right"; ctx.fillText(fmtScale(r.max), x1 - 3, hy + 16);
    }
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    // cutoff line + reservoir fill (a curve that declares a cutoff, e.g. PHIE)
    if (c.cutoff != null && isFinite(c.cutoff)) drawCutoffFill(ctx, tk, w, Y, r);
    // the curve polyline
    drawWellCurve(ctx, tk, w, Y, r);
  }
  function trackX(tk, r, v) {
    var t = (v - r.min) / ((r.max - r.min) || 1); if (t < 0) t = 0; else if (t > 1) t = 1;
    return tk.x0 + t * tk.w;
  }
  function drawWellCurve(ctx, tk, w, Y, r) {
    var v = tk.curve.values, tvd = w.tvd; if (!v || !tvd) return;
    ctx.strokeStyle = idColor("curve:" + tk.curve.mnemonic); ctx.lineWidth = 1.4; ctx.lineJoin = "round";
    ctx.beginPath(); var started = false;
    for (var s = 0; s < v.length; s++) {
      var val = v[s];
      if (val !== val) { started = false; continue; }        // NaN gap
      var x = trackX(tk, r, val), y = Y(tvd[s]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // Reservoir shading: fill between the cutoff line and the curve where value ≥
  // cutoff (net), in the track colour at low opacity — the logsuite porosity fill.
  function drawCutoffFill(ctx, tk, w, Y, r) {
    var v = tk.curve.values, tvd = w.tvd; if (!v || !tvd) return;
    var xc = trackX(tk, r, tk.curve.cutoff);
    ctx.save(); ctx.globalAlpha = 0.22; ctx.fillStyle = idColor("curve:" + tk.curve.mnemonic);
    for (var s = 0; s + 1 < v.length; s++) {
      var a = v[s], b = v[s + 1];
      if (a !== a || b !== b) continue;
      if (a < tk.curve.cutoff && b < tk.curve.cutoff) continue;
      var y0 = Y(tvd[s]), y1 = Y(tvd[s + 1]);
      var xa = Math.max(xc, trackX(tk, r, a)), xb = Math.max(xc, trackX(tk, r, b));
      ctx.beginPath(); ctx.moveTo(xc, y0); ctx.lineTo(xa, y0); ctx.lineTo(xb, y1); ctx.lineTo(xc, y1);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    // the cutoff reference line
    ctx.strokeStyle = token("--text-secondary"); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(xc, Y(tvd[0])); ctx.lineTo(xc, Y(tvd[tvd.length - 1])); ctx.stroke(); ctx.setLineDash([]);
  }
  function flagCats(c) {
    if (c.codes) return Object.keys(c.codes).map(function (k) { return { code: +k, label: c.codes[k] }; });
    return [{ code: 0, label: "off" }, { code: 1, label: "on" }];
  }
  // A flag value's colour: the "off"/zero code reads recessive (grid); a non-zero
  // code wears an identity slot (net sand etc.). Text/labels never use series hue.
  function flagColor(c, code) {
    if (!code) return token("--grid");
    if (c.codes && c.codes[String(code)]) return idColor("facies:" + c.codes[String(code)]);
    return idColor("curve:" + c.mnemonic);
  }
  function drawFlagStrip(ctx, tk, w, Y) {
    var v = tk.curve.values, tvd = w.tvd; if (!v || !tvd) return;
    for (var s = 0; s + 1 < v.length; s++) {
      var val = v[s]; if (val !== val) continue;
      var y0 = Y(tvd[s]), y1 = Y(tvd[s + 1]);
      ctx.fillStyle = flagColor(tk.curve, Math.round(val));
      ctx.fillRect(tk.x0 + 1, Math.min(y0, y1), tk.w - 2, Math.max(1, Math.abs(y1 - y0)));
    }
  }

  function wellsHover(cv, ev) {
    var h = S._wellsHit; if (!h) { hideReadout(); return; }
    var px = canvasPx(cv, ev);
    var g = null;
    for (var q = 0; q < h.wells.length; q++) { var e = h.wells[q]; if (px[0] >= e.x0 && px[0] <= e.x1) { g = e; break; } }
    if (!g || px[1] < h.padT || px[1] > h.padT + h.H) { hideReadout(); return; }
    var w = S.wl.wells[g.wi], tvd = w.tvd; if (!tvd || !tvd.length) { hideReadout(); return; }
    // nearest sample by screen depth
    var best = 0, bd = 1e9;
    for (var s = 0; s < tvd.length; s++) { var d = Math.abs(g.Y(tvd[s]) - px[1]); if (d < bd) { bd = d; best = s; } }
    var rows = [["", w.display]];
    rows.push(["TVD-SS", fmt(tvd[best], "m")]);
    if (h.win.flat && !g.parked) rows.push(["Δ pick", fmt(tvd[best] - g.shift, "m")]);
    if (g.parked) rows.push(["", "(no " + pretty(S.wl.pick) + " pick — TVD)"]);
    w.curves.forEach(function (c) {
      var val = c.values ? c.values[best] : NaN;
      if (val !== val) { rows.push([c.mnemonic, "—"]); return; }
      if (c.kind === "flag") { var lab = c.codes && c.codes[String(Math.round(val))]; rows.push([c.mnemonic, lab || String(Math.round(val))]); }
      else rows.push([c.mnemonic, fmt(val, c.unit)]);
    });
    showReadout(ev, rows);
  }

  // Legend for the Wells tab: the curve tracks (identity by track) + the zones.
  function drawWellsLegend() {
    var lg = document.getElementById("legend"); lg.innerHTML = "";
    lg.appendChild(el("h3", null, S.wl.hang === "flatten" ? "flattened on " + pretty(S.wl.pick) : "TVD (absolute)"));
    var keys = el("div", "keys");
    var seen = {};
    S.wl.wells.forEach(function (w) {
      w.curves.forEach(function (c) {
        if (seen["c:" + c.mnemonic]) return; seen["c:" + c.mnemonic] = 1;
        if (c.kind === "flag") {
          flagCats(c).forEach(function (cat) {
            if (!cat.code) return;   // the recessive "off" tier is not a legend identity
            keys.appendChild(keyRow(c.mnemonic + ": " + cat.label, flagColor(c, cat.code), false));
          });
          return;
        }
        keys.appendChild(keyRow(c.display, idColor("curve:" + c.mnemonic), true));
      });
      w.zones.forEach(function (z) { if (seen["z:" + z.name]) return; seen["z:" + z.name] = 1; keys.appendChild(keyRow(z.name, idColor("zone:" + z.name), false)); });
    });
    if (keys.childNodes.length) lg.appendChild(keys);
    lg.style.display = "block";
  }

  function buildWellsPanel(body) {
    if (!S.wl) { body.appendChild(el("div", "hint", "No wells_logs bundle in this payload.")); return; }
    var g = group("Correlation");
    g.appendChild(selectRow("Hang", ["TVD (absolute)", "Flatten on pick"], S.wl.hang === "flatten" ? 1 : 0, function (i) {
      S.wl.hang = i === 1 ? "flatten" : "tvd"; buildPanel(); renderWells();
    }));
    if (S.wl.hang === "flatten" && S.wl.picks.length) {
      g.appendChild(selectRow("Pick", S.wl.picks.map(pretty), Math.max(0, S.wl.picks.indexOf(S.wl.pick)), function (i) {
        S.wl.pick = S.wl.picks[i]; renderWells();
      }));
      g.appendChild(el("div", "hint", "Wells with no pick for this horizon are parked (shown at absolute TVD, dashed frame + tag)."));
    }
    body.appendChild(g);

    var wg = group("Wells (order · show)");
    S.wlOrder.forEach(function (wi, pos) {
      var w = S.wl.wells[wi];
      var row = el("div", "row between");
      var left = el("label", "toggle");
      var cb = el("input"); cb.type = "checkbox"; cb.checked = S.wlVis[wi];
      cb.addEventListener("change", function () { S.wlVis[wi] = cb.checked; renderWells(); });
      left.appendChild(cb); left.appendChild(el("span", null, w.display));
      row.appendChild(left);
      var btns = el("div", "row");
      var up = el("button", "btn secondary", "↑"); up.style.cssText = "width:26px;padding:2px 0";
      up.disabled = pos === 0; up.onclick = function () { var o = S.wlOrder; var t = o[pos - 1]; o[pos - 1] = o[pos]; o[pos] = t; buildPanel(); renderWells(); };
      var dn = el("button", "btn secondary", "↓"); dn.style.cssText = "width:26px;padding:2px 0";
      dn.disabled = pos === S.wlOrder.length - 1; dn.onclick = function () { var o = S.wlOrder; var t = o[pos + 1]; o[pos + 1] = o[pos]; o[pos] = t; buildPanel(); renderWells(); };
      btns.appendChild(up); btns.appendChild(dn);
      row.appendChild(btns);
      wg.appendChild(row);
    });
    body.appendChild(wg);
  }

