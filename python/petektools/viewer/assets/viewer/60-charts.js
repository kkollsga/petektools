  // ======================================================================= CHARTS
  // Analytics marks — all canvas-2D, theme-aware (tokens re-read each render),
  // hover-first. STRICTLY render-only: bins, exceedance points, tornado pivots and
  // regression coefficients are all pre-computed in the payload; nothing is fit or
  // binned here.
  function activeChart() { return S.charts[Math.min(S.chartIdx, S.charts.length - 1)]; }

  function renderCharts() {
    var cv = document.getElementById("charts-canvas");
    if (!S.charts.length) { showEmpty("No chart bundles in this payload."); return; }
    hideEmpty(); sizeCanvas(cv);
    var ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = token("--surface-1"); ctx.fillRect(0, 0, cv.width, cv.height);
    var ch = activeChart();
    S._chartHit = null;
    document.getElementById("legend").innerHTML = "";
    if (ch.mark === "tornado") renderTornado(ctx, cv, ch);
    else if (ch.mark === "scatter") renderScatter(ctx, cv, ch);
    else if (ch.mark === "distribution") renderDistribution(ctx, cv, ch);
    else showEmpty("Unknown chart mark: " + (ch.mark || "?"));
  }

  function chartTitle(ctx, cv, ch) {
    ctx.fillStyle = token("--text-primary");
    ctx.font = "600 13px system-ui"; ctx.textBaseline = "alphabetic";
    ctx.fillText(ch.title || ch.mark, 16, 22);
  }
  // ---- TORNADO: nested bars around a base line, ranked, diverging two-hue -----
  function renderTornado(ctx, cv, ch) {
    chartTitle(ctx, cv, ch);
    var unit = ch.units || "";
    var base = ch.base;
    // Rank largest-swing on top. Fold into "N others": (a) rows whose swing is
    // negligible (< fold_threshold · |base|, default 0.5%) — a flat pivot adds no
    // information — and (b) any rows past fold_count. This keeps the chart to the
    // inputs that actually move the metric.
    var bars = (ch.bars || []).slice().sort(function (a, b) {
      return tSwing(b) - tSwing(a);
    });
    var thr = (ch.fold_threshold != null ? ch.fold_threshold : 0.005) * Math.abs(base);
    var sig = [], neg = [];
    bars.forEach(function (b) { (tSwing(b) >= thr ? sig : neg).push(b); });
    var cap = (ch.fold_count && sig.length > ch.fold_count) ? ch.fold_count : sig.length;
    var rows = sig.slice(0, cap);
    var others = sig.slice(cap).concat(neg);
    if (others.length) {
      // The folded bar's span = the union envelope of the remaining bars.
      var lo = Infinity, hi = -Infinity;
      others.forEach(function (b) {
        [b.out_lo, b.out_hi, b.out_min, b.out_max].forEach(function (v) {
          if (v != null && isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
        });
      });
      rows = rows.concat([{ param: others.length + " others", out_lo: lo, out_hi: hi, folded: others.length }]);
    }
    if (!rows.length) { showEmpty("Tornado has no bars."); return; }

    // Symmetric axis around the base (absolute output units).
    var ext = 0;
    rows.forEach(function (b) {
      [b.out_lo, b.out_hi, b.out_min, b.out_max].forEach(function (v) {
        if (v != null && isFinite(v)) ext = Math.max(ext, Math.abs(v - base));
      });
    });
    ext = (ext || 1) * 1.18;
    var padL = 148, padR = 24, padT = 40, padB = 34;
    var W = cv.width - padL - padR, H = cv.height - padT - padB;
    var xmin = base - ext, xmax = base + ext;
    function X(v) { return padL + ((v - xmin) / (xmax - xmin || 1)) * W; }
    var rowH = H / rows.length, barH = Math.min(26, rowH * 0.6);
    var hit = [];

    rows.forEach(function (b, i) {
      var yc = padT + i * rowH + rowH / 2, y = yc - barH / 2;
      var inLo = Math.min(b.out_lo, b.out_hi), inHi = Math.max(b.out_lo, b.out_hi);
      // outer (full min->max) band first, at low opacity
      if (b.out_min != null && b.out_max != null && isFinite(b.out_min) && isFinite(b.out_max)) {
        drawSwing(ctx, X, base, b.out_min, b.out_max, y, barH, 0.32);
      }
      // inner (P90->P10) band, full opacity
      drawSwing(ctx, X, base, inLo, inHi, y, barH, 1);
      // param name, right-aligned in the gutter
      ctx.fillStyle = token("--text-secondary"); ctx.font = "11px system-ui";
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(disp(b, b.param), padL - 10, yc); ctx.textAlign = "left";
      // muted output values at the inner band ends
      ctx.fillStyle = token("--muted"); ctx.font = "10px system-ui";
      ctx.textBaseline = "middle";
      ctx.fillText(fmt(inLo), Math.min(X(inLo), X(inHi)) - 2 - ctx.measureText(fmt(inLo)).width, yc);
      ctx.fillText(fmt(inHi), Math.max(X(inLo), X(inHi)) + 4, yc);
      hit.push({ y0: padT + i * rowH, y1: padT + (i + 1) * rowH, bar: b });
    });
    ctx.textBaseline = "alphabetic";

    // base line (solid, on top)
    ctx.strokeStyle = token("--text-secondary"); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(X(base), padT - 6); ctx.lineTo(X(base), padT + H); ctx.stroke();
    ctx.fillStyle = token("--muted"); ctx.font = "10px system-ui"; ctx.textAlign = "center";
    ctx.fillText("base " + fmt(base, unit), X(base), padT + H + 14);
    // axis extremes
    ctx.fillText(fmt(xmin, unit), padL + 30, padT + H + 14);
    ctx.fillText(fmt(xmax, unit), padL + W - 30, padT + H + 14);
    ctx.textAlign = "left";

    S._chartHit = { kind: "tornado", rows: hit, base: base, unit: unit };
    drawChartLegend(ch);
  }
  function tSwing(b) {
    if (b.swing != null && isFinite(b.swing)) return Math.abs(b.swing);
    return Math.abs((b.out_hi != null ? b.out_hi : 0) - (b.out_lo != null ? b.out_lo : 0));
  }
  function drawSwing(ctx, X, base, lo, hi, y, h, alpha) {
    ctx.save(); ctx.globalAlpha = alpha;
    if (lo < base) { // below-base swing = the low/pessimistic hue
      var xa = X(lo), xb = X(Math.min(hi, base));
      ctx.fillStyle = token("--swing-lo"); ctx.fillRect(xa, y, Math.max(1, xb - xa), h);
    }
    if (hi > base) { // above-base swing = the high/optimistic hue
      var xc = X(Math.max(lo, base)), xd = X(hi);
      ctx.fillStyle = token("--swing-hi"); ctx.fillRect(xc, y, Math.max(1, xd - xc), h);
    }
    ctx.restore();
  }

  // ---- SCATTER (crossplot): x/y, optional log axes, color-by-third -----------
  function renderScatter(ctx, cv, ch) {
    chartTitle(ctx, cv, ch);
    var ui = S.chartUI[S.chartIdx] || {};
    var pts = ch.points || [];
    if (!pts.length) { showEmpty("Crossplot has no points."); return; }
    var xlog = ui.xlog, ylog = ui.ylog;
    var xd = axisDomain(pts.map(function (p) { return p.x; }), ch.x, xlog);
    var yd = axisDomain(pts.map(function (p) { return p.y; }), ch.y, ylog);
    var padL = 60, padR = 20, padT = 40, padB = 44;
    var W = cv.width - padL - padR, H = cv.height - padT - padB;
    function X(v) { return padL + axisT(v, xd, xlog) * W; }
    function Y(v) { return padT + (1 - axisT(v, yd, ylog)) * H; }

    // frame + gridlines
    ctx.strokeStyle = token("--baseline"); ctx.lineWidth = 1; ctx.strokeRect(padL, padT, W, H);
    axisGrid(ctx, X, Y, xd, yd, xlog, ylog, padL, padT, W, H);
    // axis labels
    ctx.fillStyle = token("--text-secondary"); ctx.font = "11px system-ui"; ctx.textAlign = "center";
    ctx.fillText(axLabel(ch.x, xlog), padL + W / 2, padT + H + 34);
    ctx.save(); ctx.translate(16, padT + H / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText(axLabel(ch.y, ylog), 0, 0); ctx.restore(); ctx.textAlign = "left";

    // points
    var cb = ch.color_by || {}, cont = cb.kind === "continuous";
    var cr = cb.range || { min: 0, max: 1 }, cspan = (cr.max - cr.min) || 1;
    var hit = [];
    pts.forEach(function (p) {
      if ((xlog && p.x <= 0) || (ylog && p.y <= 0)) return;
      var sx = X(p.x), sy = Y(p.y);
      if (sx < padL || sx > padL + W || sy < padT || sy > padT + H) return;
      var col = cont ? rampCss(S.colormap, (p.c - cr.min) / cspan, S.colormapReversed)
        : cb.name ? idColor("grp:" + p.c) : token("--c1");
      ctx.beginPath(); ctx.arc(sx, sy, 4, 0, 6.2832);
      ctx.globalAlpha = 0.72; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
      ctx.lineWidth = 1; ctx.strokeStyle = token("--surface-1"); ctx.stroke();
      hit.push({ sx: sx, sy: sy, p: p });
    });

    // regression overlays (render-only: endpoints + coefficients in the payload)
    if (ui.trends !== false) (ch.trends || []).forEach(function (tr) {
      if (tr.x0 == null) return;
      var col = tr.group ? idColor("grp:" + tr.group) : token("--text-secondary");
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash([6, 3]);
      ctx.beginPath(); ctx.moveTo(X(tr.x0), Y(tr.y0)); ctx.lineTo(X(tr.x1), Y(tr.y1)); ctx.stroke();
      ctx.setLineDash([]);
    });

    S._chartHit = { kind: "scatter", pts: hit, ch: ch, cont: cont };
    drawChartLegend(ch);
  }

  // ---- DISTRIBUTION: histogram + exceedance-CDF, two stacked panels ----------
  function renderDistribution(ctx, cv, ch) {
    chartTitle(ctx, cv, ch);
    var unit = ch.units || "";
    var series = ch.series || [];
    if (!series.length) { showEmpty("Distribution has no series."); return; }
    // shared x domain across every series' bins + cdf points + markers
    var xmin = Infinity, xmax = -Infinity, cmax = 0;
    series.forEach(function (s) {
      (s.bins || []).forEach(function (b) {
        xmin = Math.min(xmin, b.lo); xmax = Math.max(xmax, b.hi); cmax = Math.max(cmax, b.count);
      });
      (s.cdf || []).forEach(function (pt) { xmin = Math.min(xmin, pt.x); xmax = Math.max(xmax, pt.x); });
    });
    if (!isFinite(xmin)) { showEmpty("Distribution has no bins."); return; }
    var padL = 56, padR = 20, padT = 40, padB = 40, gap = 26;
    var W = cv.width - padL - padR, avail = cv.height - padT - padB - gap;
    var Htop = avail * 0.58, Hbot = avail * 0.42;
    var yTop = padT, yBot = padT + Htop + gap;
    function X(v) { return padL + ((v - xmin) / (xmax - xmin || 1)) * W; }
    function Yh(c) { return yTop + (1 - c / (cmax || 1)) * Htop; }        // count
    function Ye(e) { return yBot + (1 - e) * Hbot; }                       // exceedance 0..1

    // panel frames
    ctx.strokeStyle = token("--baseline"); ctx.lineWidth = 1;
    ctx.strokeRect(padL, yTop, W, Htop); ctx.strokeRect(padL, yBot, W, Hbot);
    ctx.fillStyle = token("--muted"); ctx.font = "10px system-ui";
    ctx.fillText("frequency", padL + 2, yTop - 4);
    ctx.fillText("exceedance (% ≥) — P90 low · P10 high", padL + 2, yBot - 4);

    // histogram bars per series (identity colour, 2px surface gap, overlaid)
    series.forEach(function (s) {
      var col = idColor("dist:" + s.name);
      ctx.save(); ctx.globalAlpha = series.length > 1 ? 0.5 : 0.82; ctx.fillStyle = col;
      (s.bins || []).forEach(function (b) {
        var x0 = X(b.lo), x1 = X(b.hi), yv = Yh(b.count);
        ctx.fillRect(x0 + 1, yv, Math.max(1, x1 - x0 - 2), yTop + Htop - yv);
      });
      ctx.restore();
    });
    // exceedance curves per series
    series.forEach(function (s) {
      var col = idColor("dist:" + s.name);
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath();
      (s.cdf || []).forEach(function (pt, i) { var x = X(pt.x), y = Ye(pt.exceedance); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.stroke();
    });
    // P90/P50/P10 markers (reservoir convention) across both panels
    var first = series[0];
    if (first.markers) {
      [["P90", first.markers.p90], ["P50", first.markers.p50], ["P10", first.markers.p10]].forEach(function (mk) {
        if (mk[1] == null || !isFinite(mk[1])) return;
        var x = X(mk[1]);
        ctx.strokeStyle = token("--muted"); ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot + Hbot); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = token("--text-secondary"); ctx.font = "10px system-ui"; ctx.textAlign = "center";
        ctx.fillText(mk[0], x, yTop - 4 + 0); ctx.textAlign = "left";
      });
    }
    // exceedance-panel y-ticks (0/25/50/75/100 %) so the CDF reads quantitatively
    ctx.font = "10px system-ui"; ctx.textBaseline = "middle";
    [0, 0.25, 0.5, 0.75, 1].forEach(function (e) {
      var y = Ye(e);
      ctx.strokeStyle = token("--baseline"); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL - 3, y); ctx.lineTo(padL, y); ctx.stroke();
      ctx.fillStyle = token("--muted"); ctx.textAlign = "right";
      ctx.fillText(Math.round(e * 100) + "%", padL - 5, y);
    });
    ctx.textBaseline = "alphabetic";

    // shared x ticks at the very bottom
    ctx.fillStyle = token("--muted"); ctx.font = "10px system-ui"; ctx.textAlign = "center";
    for (var t = 0; t <= 4; t++) { var xv = xmin + (t / 4) * (xmax - xmin); ctx.fillText(fmt(xv), X(xv), yBot + Hbot + 14); }
    ctx.fillText((ch.title || "value") + (unit ? " (" + unit + ")" : ""), padL + W / 2, cv.height - 6);
    ctx.textAlign = "left";

    S._chartHit = { kind: "distribution", series: series, X: X, xmin: xmin, xmax: xmax, cmax: cmax,
      yTop: yTop, Htop: Htop, yBot: yBot, Hbot: Hbot, unit: unit };
    drawChartLegend(ch);
  }

  // ---- axis helpers (log-aware) ----------------------------------------------
  function axisDomain(vals, meta, log) {
    var r = meta && meta.range;
    var lo = r ? r.min : Math.min.apply(null, vals);
    var hi = r ? r.max : Math.max.apply(null, vals);
    if (log) { lo = vals.filter(function (v) { return v > 0; }).reduce(function (a, b) { return Math.min(a, b); }, Infinity); if (!isFinite(lo)) lo = 1e-6; }
    if (lo === hi) { hi = lo + 1; }
    return { lo: lo, hi: hi };
  }
  function axisT(v, d, log) {
    if (log) { var l0 = Math.log10(d.lo), l1 = Math.log10(d.hi); return (Math.log10(v) - l0) / (l1 - l0 || 1); }
    return (v - d.lo) / (d.hi - d.lo || 1);
  }
  function axisGrid(ctx, X, Y, xd, yd, xlog, ylog, padL, padT, W, H) {
    ctx.strokeStyle = token("--grid"); ctx.lineWidth = 1;
    ctx.fillStyle = token("--muted"); ctx.font = "10px system-ui";
    for (var t = 0; t <= 4; t++) {
      var fx = t / 4, xv = xlog ? Math.pow(10, Math.log10(xd.lo) + fx * (Math.log10(xd.hi) - Math.log10(xd.lo))) : xd.lo + fx * (xd.hi - xd.lo);
      var sx = X(xv); ctx.beginPath(); ctx.moveTo(sx, padT); ctx.lineTo(sx, padT + H); ctx.stroke();
      ctx.textAlign = "center"; ctx.fillText(fmt(xv), sx, padT + H + 14);
      var yv = ylog ? Math.pow(10, Math.log10(yd.lo) + fx * (Math.log10(yd.hi) - Math.log10(yd.lo))) : yd.lo + fx * (yd.hi - yd.lo);
      var sy = Y(yv); ctx.beginPath(); ctx.moveTo(padL, sy); ctx.lineTo(padL + W, sy); ctx.stroke();
      ctx.textAlign = "right"; ctx.fillText(fmt(yv), padL - 4, sy + 3);
    }
    ctx.textAlign = "left";
  }
  function axLabel(meta, log) {
    if (!meta) return "";
    return (meta.name || "") + (meta.units ? " (" + meta.units + ")" : "") + (log ? " · log" : "");
  }

  // ---- chart hover ------------------------------------------------------------
  function chartHover(cv, ev) {
    var h = S._chartHit; if (!h) { hideReadout(); return; }
    var px = canvasPx(cv, ev);
    if (h.kind === "tornado") {
      var row = h.rows.filter(function (r) { return px[1] >= r.y0 && px[1] <= r.y1; })[0];
      if (!row) { hideReadout(); return; }
      var b = row.bar, rows = [["", disp(b, b.param)]];
      if (b.in_lo != null) rows.push(["lo pivot", fmt(b.in_lo)]);
      if (b.in_hi != null) rows.push(["hi pivot", fmt(b.in_hi)]);
      rows.push(["output", fmt(Math.min(b.out_lo, b.out_hi), h.unit) + " – " + fmt(Math.max(b.out_lo, b.out_hi), h.unit)]);
      showReadout(ev, rows);
    } else if (h.kind === "scatter") {
      var best = null, bd = 144;
      h.pts.forEach(function (q) { var d = (q.sx - px[0]) * (q.sx - px[0]) + (q.sy - px[1]) * (q.sy - px[1]); if (d < bd) { bd = d; best = q; } });
      if (!best) { hideReadout(); return; }
      var p = best.p, cb = h.ch.color_by || {}, rows2 = [["", (h.ch.x.name || "x") + " / " + (h.ch.y.name || "y")]];
      rows2.push([h.ch.x.name || "x", fmt(p.x, h.ch.x.units)]);
      rows2.push([h.ch.y.name || "y", fmt(p.y, h.ch.y.units)]);
      if (cb.name) rows2.push([cb.name, h.cont ? fmt(p.c, cb.units) : String(p.c)]);
      showReadout(ev, rows2);
    } else if (h.kind === "distribution") {
      if (px[0] < h.X(h.xmin) || px[0] > h.X(h.xmax)) { hideReadout(); return; }
      // top panel -> bin; bottom -> exceedance value
      var s0 = h.series[0];
      if (px[1] <= h.yTop + h.Htop && s0.bins) {
        var bin = s0.bins.filter(function (b) { return px[0] >= h.X(b.lo) && px[0] <= h.X(b.hi); })[0];
        if (bin) { showReadout(ev, [["", disp(s0, s0.name)], ["bin", fmt(bin.lo, h.unit) + " – " + fmt(bin.hi, h.unit)], ["count", String(bin.count)]]); return; }
      }
      var xw = h.xmin + ((px[0] - h.X(h.xmin)) / (h.X(h.xmax) - h.X(h.xmin) || 1)) * (h.xmax - h.xmin);
      showReadout(ev, [["", disp(s0, s0.name)], ["value", fmt(xw, h.unit)]]);
    }
  }

  // ---- charts control panel ---------------------------------------------------
  function buildChartsPanel(body) {
    if (!S.charts.length) { body.appendChild(el("div", "hint", "No chart bundles in this payload.")); return; }
    var g = group("Chart");
    g.appendChild(selectRow("Show", S.charts.map(function (c, i) { return c.title || (c.mark + " " + (i + 1)); }), S.chartIdx, function (i) { S.chartIdx = i; buildPanel(); renderCharts(); }));
    body.appendChild(g);
    var ch = activeChart(), ui = S.chartUI[S.chartIdx] || {};
    if (ch.mark === "scatter") {
      var o = group("Axes");
      o.appendChild(toggleRow("x log-scale", ui.xlog, null, false, function (v) { ui.xlog = v; renderCharts(); }));
      o.appendChild(toggleRow("y log-scale", ui.ylog, null, false, function (v) { ui.ylog = v; renderCharts(); }));
      if ((ch.trends || []).length) o.appendChild(toggleRow("trend lines", ui.trends !== false, null, false, function (v) { ui.trends = v; renderCharts(); }));
      if ((ch.color_by || {}).kind === "continuous") o.appendChild(colormapRow());
      body.appendChild(o);
    } else if (ch.mark === "distribution") {
      body.appendChild(el("div", "hint", "Top: frequency histogram. Bottom: exceedance curve (% of realizations ≥ x). Markers P90/P50/P10 use the reservoir convention (P90 = low)."));
    } else if (ch.mark === "tornado") {
      body.appendChild(el("div", "hint", "Bars swing around the base value; ranked by leverage (largest on top). Inner band = P90→P10, outer (faint) = min→max. Hover a bar for its pivot inputs + output range."));
    }
  }
