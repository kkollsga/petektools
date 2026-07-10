  // ---- well-log lanes (Wells tab) ------------------------------------------
  // A lane is a v3-style f32 binary block {dtype, shape, data(base64)}. Decode it
  // with the SAME kernel the volume worker uses (PETEK_DECODE.b64ToBytes +
  // blockToTyped) — no worker (lanes are tiny). NaN (0x7FC00000) reads as null.
  function decodeLane(block) {
    if (!block) return null;
    var D = window.PETEK_DECODE;
    if (D && block.data != null) return D.blockToTyped(D.b64ToBytes(block.data), block.dtype || "f32");
    if (Array.isArray(block)) return Float32Array.from(block);            // defensive
    if (block.values && Array.isArray(block.values)) return Float32Array.from(block.values);
    return null;
  }
  function initWellsState(p) {
    S.wl = null;
    var wlb = p.wells_logs;
    if (!wlb || !wlb.wells || !wlb.wells.length) return;
    var wells = wlb.wells.map(function (w) {
      return {
        id: w.id, display: disp(w, w.id), datum: w.datum_m,
        md: decodeLane(w.md_m), tvd: decodeLane(w.tvd_m),
        curves: (w.curves || []).map(function (c) {
          return {
            mnemonic: c.mnemonic, display: disp(c, c.mnemonic), unit: c.unit || "",
            kind: c.kind || "continuous", cutoff: c.cutoff, range: c.range, codes: c.codes || null,
            values: decodeLane(c.values),
          };
        }),
        tops: (w.tops || []).slice(), zones: (w.zones || []).slice(), ties: (w.ties || []).slice(),
      };
    });
    // union of pick horizons (the flatten dropdown), in payload/top-down order.
    var picks = [];
    wells.forEach(function (w) { w.tops.forEach(function (t) { if (picks.indexOf(t.horizon) < 0) picks.push(t.horizon); }); });
    var pick = wlb.flatten_default && picks.indexOf(wlb.flatten_default) >= 0 ? wlb.flatten_default : (picks[0] || null);
    S.wl = { wells: wells, hang: "tvd", pick: pick, picks: picks };
    S.wlOrder = wells.map(function (_, i) { return i; });   // display order (reorderable)
    S.wlVis = wells.map(function () { return true; });        // per-well visibility
  }
  function visibleWellIdx() {
    if (!S.wl) return [];
    return S.wlOrder.filter(function (i) { return S.wlVis[i]; });
  }
  // The shift (m) that aligns a well's chosen pick to the flatten datum, or null
  // when the well has no such pick (it is "parked" — shown unflattened, tagged).
  function pickShift(w, pick) {
    if (!pick) return 0;
    for (var q = 0; q < w.tops.length; q++) if (w.tops[q].horizon === pick) return w.tops[q].tvd_m;
    return null;
  }

  // ---- chrome (tabs, theme, panel) -----------------------------------------
  function wireChrome() {
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (btn) {
      btn.addEventListener("click", function () { selectTab(btn.getAttribute("data-tab")); });
    });
    document.getElementById("theme-toggle").addEventListener("click", function () {
      var dark = root.getAttribute("data-theme") === "dark";
      root.setAttribute("data-theme", dark ? "light" : "dark");
      this.textContent = dark ? "☾" : "☀";
      renderActive(); // re-read tokens; identities keep their slot, colours restep
    });
  }
  function selectTab(tab) {
    App.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
      b.setAttribute("aria-selected", b.getAttribute("data-tab") === tab ? "true" : "false");
    });
    Array.prototype.forEach.call(document.querySelectorAll(".pane"), function (pane) {
      pane.hidden = pane.getAttribute("data-pane") !== tab;
    });
    hideReadout();
    buildPanel();
    renderActive();
  }
  function renderActive() {
    // Time the active render and stash it on window for the perf harness (a
    // synchronous 2-D tab reports its true repaint cost; the async volume worker
    // reports only its kickoff). Harmless in production.
    var t0 = (typeof performance !== "undefined") ? performance.now() : 0;
    if (App.tab === "map") renderMap();
    else if (App.tab === "section") renderSection();
    else if (App.tab === "charts") renderCharts();
    else if (App.tab === "wells") renderWells();
    else renderVolume();
    if (typeof window !== "undefined" && typeof performance !== "undefined") {
      window.__PETEK_RENDER_MS = performance.now() - t0;
    }
  }

  // ---- shared UI bits ------------------------------------------------------
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function group(title) { var g = el("div", "group"); g.appendChild(el("h2", null, title)); return g; }
  function selectRow(label, options, idx, onChange) {
    var row = el("div", "row between");
    row.appendChild(el("label", null, label));
    var sel = el("select");
    options.forEach(function (o, i) { var op = el("option", null, o); op.value = i; sel.appendChild(op); });
    sel.value = idx;
    sel.addEventListener("change", function () { onChange(parseInt(sel.value, 10)); });
    row.appendChild(sel);
    return row;
  }
  function sliderRow(label, min, max, step, val, onInput) {
    var row = el("div", "row between");
    row.appendChild(el("label", null, label));
    var s = el("input"); s.type = "range"; s.min = min; s.max = max; s.step = step; s.value = val;
    s.addEventListener("input", function () { onInput(parseFloat(s.value)); });
    row.appendChild(s);
    return row;
  }
  function toggleRow(label, checked, swatchCss, isLine, onChange) {
    var lab = el("label", "toggle");
    var cb = el("input"); cb.type = "checkbox"; cb.checked = checked;
    cb.addEventListener("change", function () { onChange(cb.checked); });
    lab.appendChild(cb);
    if (swatchCss) { var sw = el("span", isLine ? "swatch line" : "swatch"); if (isLine) sw.style.borderTopColor = swatchCss; else sw.style.background = swatchCss; lab.appendChild(sw); }
    lab.appendChild(el("span", null, label));
    return lab;
  }
  function colormapRow() {
    return selectRow("Colormap", COLORMAP_NAMES, COLORMAP_NAMES.indexOf(S.colormap), function (i) {
      S.colormap = COLORMAP_NAMES[i]; renderActive();
    });
  }

