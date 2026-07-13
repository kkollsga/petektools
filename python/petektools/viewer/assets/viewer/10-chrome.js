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
        id: w.id, item_id: w.item_id || w.id, display: disp(w, w.id), datum: w.datum_m,
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
    var tpl = wlb.template || null;
    if (tpl && tpl.spec !== "CorrelationTemplate") throw new Error("wells_logs.template is not a CorrelationTemplate");
    var hang = tpl && tpl.default_hang === "flatten" ? "flatten" : "tvd";
    if (tpl && tpl.flatten_pick && picks.indexOf(tpl.flatten_pick) >= 0) pick = tpl.flatten_pick;
    S.wl = { wells: wells, hang: hang, pick: pick, picks: picks, template: tpl };
    S.wlOrder = wells.map(function (_, i) { return i; });   // display order (reorderable)
    S.wlVis = wells.map(function () { return true; });        // per-well visibility
  }
  function visibleWellIdx() {
    if (!S.wl) return [];
    return S.wlOrder.filter(function (i) { return S.wlVis[i]; });
  }
  function wellDisplayDepth(w, tvd, index) {
    var md = S.wl && S.wl.template && S.wl.template.layout
      && S.wl.template.layout.depth_axis === "md";
    if (!md || !w.md || !w.md.length) return tvd;
    if (index != null && index >= 0 && index < w.md.length) return w.md[index];
    var best = 0, bd = Infinity;
    for (var q = 0; q < w.tvd.length; q++) {
      var d = Math.abs(w.tvd[q] - tvd); if (d < bd) { bd = d; best = q; }
    }
    return w.md[best];
  }
  // The shift (m) that aligns a well's chosen pick to the flatten datum, or null
  // when the well has no such pick (it is "parked" — shown unflattened, tagged).
  function pickShift(w, pick) {
    if (!pick) return 0;
    for (var q = 0; q < w.tops.length; q++) if (w.tops[q].horizon === pick) return wellDisplayDepth(w, w.tops[q].tvd_m);
    return null;
  }

  // ---- chrome (tabs, theme, panel) -----------------------------------------
  var UI_PREF_KEY = "petek.viewer.ui.v1";
  var uiPrefs = {};
  var narrowWorkspaceMedia = null;
  function readUiPrefs() {
    if (!W) return {};
    try {
      var parsed = JSON.parse(localStorage.getItem(UI_PREF_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) { return {}; }
  }
  function saveUiPrefs() {
    if (!W) return;
    var narrow = isNarrowWorkspace();
    var navigatorOpen = !document.getElementById("navigator").hidden;
    var inspectorOpen = !document.getElementById("panel").hidden;
    var safe = {
      theme: root.getAttribute("data-theme") === "dark" ? "dark" : "light",
      // Narrow drawers are mutually exclusive presentation state. Preserve the
      // wider desktop choices rather than replacing them when a notebook drawer
      // is opened or closed.
      navigatorOpen: narrow ? uiPrefs.navigatorOpen !== false : navigatorOpen,
      inspectorOpen: narrow ? uiPrefs.inspectorOpen !== false : inspectorOpen,
      narrowPanel: narrow ? (navigatorOpen ? "navigator" : inspectorOpen ? "inspector" : "none") : uiPrefs.narrowPanel,
      navigatorWidth: boundedPanelWidth(parseFloat(getComputedStyle(root).getPropertyValue("--navigator-width")), 264),
      inspectorWidth: boundedPanelWidth(parseFloat(getComputedStyle(root).getPropertyValue("--inspector-width")), 268),
      selectedTab: App.tab,
    };
    uiPrefs = safe;
    try { localStorage.setItem(UI_PREF_KEY, JSON.stringify(safe)); } catch (_) {}
  }
  function boundedPanelWidth(value, fallback) {
    return isFinite(value) ? Math.max(180, Math.min(420, Math.round(value))) : fallback;
  }
  function isNarrowWorkspace() {
    return !!(narrowWorkspaceMedia && narrowWorkspaceMedia.matches);
  }
  function applyResponsivePanelState() {
    var navigatorOpen = uiPrefs.navigatorOpen !== false;
    var inspectorOpen = uiPrefs.inspectorOpen !== false;
    if (isNarrowWorkspace()) {
      if (uiPrefs.narrowPanel === "navigator") { navigatorOpen = true; inspectorOpen = false; }
      else if (uiPrefs.narrowPanel === "inspector") { navigatorOpen = false; inspectorOpen = true; }
      else if (uiPrefs.narrowPanel === "none") { navigatorOpen = false; inspectorOpen = false; }
      else if (navigatorOpen && inspectorOpen) inspectorOpen = false;
    }
    setPanelOpen("navigator", navigatorOpen, false);
    setPanelOpen("panel", inspectorOpen, false);
  }
  function workspaceTabAvailable(tab) {
    var p = App.payload || {};
    if (tab === "map") return !!p.map || workspaceHasView("map");
    if (tab === "section") return !!((p.sections && p.sections.length) || (S.sections && S.sections.length));
    if (tab === "volume") return !!p.volume;
    if (tab === "scene3d") return !!p.scene3d || workspaceHasView("scene3d");
    if (tab === "wells") return !!(p.wells_logs && p.wells_logs.wells && p.wells_logs.wells.length) || workspaceHasView("wells");
    if (tab === "charts") return !!(p.charts && p.charts.length);
    return false;
  }
  function availableWorkspaceTabs() {
    return Array.prototype.filter.call(document.querySelectorAll(".tab"), function (button) {
      return workspaceTabAvailable(button.getAttribute("data-tab"));
    }).map(function (button) { return button.getAttribute("data-tab"); });
  }
  function refreshWorkspaceCapabilities() {
    if (!W) return;
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (button) {
      button.hidden = !workspaceTabAvailable(button.getAttribute("data-tab"));
    });
  }
  function configureWorkspaceShell() {
    if (!W) return;
    root.classList.add("workspace-shell");
    uiPrefs = readUiPrefs();
    if (uiPrefs.theme === "dark" || uiPrefs.theme === "light") root.setAttribute("data-theme", uiPrefs.theme);
    document.getElementById("theme-toggle").textContent = root.getAttribute("data-theme") === "dark" ? "☀" : "☾";
    root.style.setProperty("--navigator-width", boundedPanelWidth(uiPrefs.navigatorWidth, 264) + "px");
    root.style.setProperty("--inspector-width", boundedPanelWidth(uiPrefs.inspectorWidth, 268) + "px");
    narrowWorkspaceMedia = window.matchMedia ? window.matchMedia("(max-width: 780px)") : null;
    applyResponsivePanelState();
    if (narrowWorkspaceMedia) {
      var onResponsiveChange = function () { applyResponsivePanelState(); setTimeout(renderActive, 0); };
      if (narrowWorkspaceMedia.addEventListener) narrowWorkspaceMedia.addEventListener("change", onResponsiveChange);
      else if (narrowWorkspaceMedia.addListener) narrowWorkspaceMedia.addListener(onResponsiveChange);
    }
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (button, index) {
      var tab = button.getAttribute("data-tab");
      button.hidden = !workspaceTabAvailable(tab);
      button.id = "tab-" + tab;
      button.setAttribute("aria-controls", "pane-" + tab);
      var pane = document.querySelector('.pane[data-pane="' + tab + '"]');
      if (pane) { pane.id = "pane-" + tab; pane.setAttribute("aria-labelledby", button.id); }
    });
    if (uiPrefs.selectedTab && workspaceTabAvailable(uiPrefs.selectedTab)) App.tab = uiPrefs.selectedTab;
    wirePanelToggle("navigator-toggle", "navigator");
    wirePanelToggle("inspector-toggle", "panel");
    wirePanelResizer("navigator-resizer", "--navigator-width", 1);
    wirePanelResizer("inspector-resizer", "--inspector-width", -1);
    wireShortcutHelp();
    document.addEventListener("keydown", workspaceShortcut);
    buildWorkspaceNavigator();
    updateWorkspaceChrome();
  }
  function setPanelOpen(id, open, persist) {
    var region = document.getElementById(id);
    var toggle = document.getElementById(id === "panel" ? "inspector-toggle" : "navigator-toggle");
    if (!region) return;
    if (open && isNarrowWorkspace()) {
      var otherId = id === "panel" ? "navigator" : "panel";
      var other = document.getElementById(otherId);
      var otherToggle = document.getElementById(otherId === "panel" ? "inspector-toggle" : "navigator-toggle");
      if (other) other.hidden = true;
      if (otherToggle) otherToggle.setAttribute("aria-expanded", "false");
    }
    region.hidden = !open;
    if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (persist !== false) { saveUiPrefs(); setTimeout(renderActive, 0); }
  }
  function wirePanelToggle(buttonId, regionId) {
    var button = document.getElementById(buttonId);
    if (!button) return;
    button.addEventListener("click", function () {
      var region = document.getElementById(regionId);
      setPanelOpen(regionId, region.hidden);
    });
  }
  function wirePanelResizer(id, property, direction) {
    var handle = document.getElementById(id);
    if (!handle) return;
    function setWidth(value) {
      root.style.setProperty(property, boundedPanelWidth(value, property === "--navigator-width" ? 264 : 268) + "px");
      renderActive();
    }
    handle.addEventListener("pointerdown", function (event) {
      var startX = event.clientX;
      var start = parseFloat(getComputedStyle(root).getPropertyValue(property));
      handle.setPointerCapture(event.pointerId);
      function move(ev) { setWidth(start + (ev.clientX - startX) * direction); }
      function done() {
        handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", done);
        saveUiPrefs();
      }
      handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", done);
    });
    handle.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      var delta = (event.key === "ArrowRight" ? 12 : -12) * direction;
      setWidth(parseFloat(getComputedStyle(root).getPropertyValue(property)) + delta); saveUiPrefs();
    });
  }
  function wireShortcutHelp() {
    var help = document.getElementById("shortcut-help"), toggle = document.getElementById("help-toggle");
    var card = help.querySelector(".shortcut-card"), close = document.getElementById("shortcut-close"), priorFocus = null;
    function setOpen(open) {
      help.hidden = !open; toggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) { priorFocus = document.activeElement; card.focus(); }
      else if (priorFocus && priorFocus.focus) priorFocus.focus();
    }
    toggle.addEventListener("click", function () { setOpen(help.hidden); });
    close.addEventListener("click", function () { setOpen(false); });
    help.addEventListener("click", function (event) { if (event.target === help) setOpen(false); });
    help.addEventListener("keydown", function (event) {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); return; }
      if (event.key !== "Tab") return;
      var focusable = Array.prototype.slice.call(help.querySelectorAll('button:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) { event.preventDefault(); card.focus(); return; }
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      else if (document.activeElement === card) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    });
    help._setOpen = setOpen;
  }
  function fitActiveWorkspaceView() {
    if (App.tab === "map") { requestMapFit("explicit"); renderMap(); }
    else if (App.tab === "scene3d" && s3d) { frameScene3d(); s3d.render(); }
    else if (App.tab === "volume" && three) { three.framed = false; renderVolume(); }
    else renderActive();
  }
  function workspaceShortcut(event) {
    if (!W) return;
    var target = event.target;
    var typing = target && (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable);
    var help = document.getElementById("shortcut-help");
    if (event.key === "Escape" && !help.hidden) { help._setOpen(false); return; }
    if (typing) return;
    if (event.key === "/") {
      event.preventDefault(); setPanelOpen("navigator", true);
      var search = document.querySelector(".workspace-search"); if (search) search.focus();
    } else if (event.key === "?") {
      event.preventDefault(); help._setOpen(help.hidden);
    } else if (/^[123]$/.test(event.key)) {
      var tabs = availableWorkspaceTabs(), tab = tabs[parseInt(event.key, 10) - 1];
      if (tab) { event.preventDefault(); selectTab(tab); }
    } else if (event.key.toLowerCase() === "f") {
      event.preventDefault(); fitActiveWorkspaceView();
    }
  }
  function updateWorkspaceChrome() {
    if (!W) return;
    var view = workspaceViewName(App.tab), selected = 0, loaded = 0, pending = 0, errors = 0;
    W.order.forEach(function (id) {
      if (workspaceItemVisible(id, view) && workspaceItemHasView(id, view)) selected++;
      if (workspaceResource(id, view, workspaceLane(id, view))) loaded++;
    });
    Object.keys(W.loading).forEach(function (key) { if (W.loading[key].view === view) pending++; });
    Object.keys(W.errors).forEach(function (key) { if (key.indexOf("\u0000" + view + "\u0000") >= 0) errors++; });
    var label = (document.querySelector('.tab[data-tab="' + App.tab + '"]') || {}).textContent || App.tab;
    var state = pending ? "Loading " + pending : errors ? errors + " failed" : selected ? "Ready" : "Empty";
    document.getElementById("status-view").textContent = label + " · " + state;
    document.getElementById("status-detail").textContent = selected
      ? selected + " selected · " + loaded + " resources cached" + (App.mode === "file" ? " · offline snapshot" : "")
      : "Select a compatible item in the Project navigator.";
    document.getElementById("mode-badge").textContent = pending ? "loading " + pending
      : App.mode === "server" ? "live" : "offline · static";
  }
  function wireChrome() {
    wireButtonTooltips();
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (btn) {
      btn.addEventListener("click", function () { selectTab(btn.getAttribute("data-tab")); });
      btn.addEventListener("keydown", function (event) {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].indexOf(event.key) < 0) return;
        var tabs = Array.prototype.filter.call(document.querySelectorAll(".tab"), function (candidate) { return !candidate.hidden; });
        var index = tabs.indexOf(btn), next = index;
        if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        else next = (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        if (tabs[next]) { event.preventDefault(); tabs[next].focus(); selectTab(tabs[next].getAttribute("data-tab")); }
      });
    });
    document.getElementById("theme-toggle").addEventListener("click", function () {
      var dark = root.getAttribute("data-theme") === "dark";
      root.setAttribute("data-theme", dark ? "light" : "dark");
      this.textContent = dark ? "☾" : "☀";
      invalidateThemeTokens();
      saveUiPrefs();
      renderActive(); // re-read tokens; identities keep their slot, colours restep
    });
    configureWorkspaceShell();
  }
  function selectTab(tab) {
    refreshWorkspaceCapabilities();
    if (W && !workspaceTabAvailable(tab)) {
      var available = availableWorkspaceTabs(); tab = available[0] || "map";
    }
    App.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
      var selected = b.getAttribute("data-tab") === tab;
      b.setAttribute("aria-selected", selected ? "true" : "false");
      b.tabIndex = selected ? 0 : -1;
    });
    Array.prototype.forEach.call(document.querySelectorAll(".pane"), function (pane) {
      pane.hidden = pane.getAttribute("data-pane") !== tab;
    });
    hideReadout();
    // Start (or synchronously compose embedded) resources before painting so a
    // lazy tab never flashes a generic empty-state ahead of its truthful state.
    ensureWorkspaceTab(tab);
    buildWorkspaceNavigator();
    buildPanel();
    renderActive();
    updateWorkspaceChrome(); saveUiPrefs();
  }
  function renderActive() {
    // Time the active render and stash it on window for the perf harness (a
    // synchronous 2-D tab reports its true repaint cost; the async volume worker
    // reports only its kickoff). Harmless in production.
    var t0 = (typeof performance !== "undefined") ? performance.now() : 0;
    if (App.tab === "map") renderMap();
    else if (App.tab === "section") renderSection();
    else if (App.tab === "scene3d") renderScene3d();
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
