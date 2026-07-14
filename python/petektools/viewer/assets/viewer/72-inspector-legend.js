  // ---- Inspector-owned layer keys -----------------------------------------
  // Map and Intersection have one layer list and one legend truth. Plot legends
  // remain available to the legacy Volume/Charts/3-D renderers only.
  var INSPECTOR_ENTITY_CAP = 6;

  function inspectorSwatch(kind, color) {
    var sw = el("span", "inspector-swatch " + (kind === "line" ? "line" : "dot"));
    if (kind === "line") sw.style.borderTopColor = color;
    else sw.style.backgroundColor = color;
    return sw;
  }
  function inspectorVisibility(row, label, getVisible, setVisible) {
    var cb = el("input", "inspector-visible"); cb.type = "checkbox"; cb.checked = !!getVisible();
    cb.setAttribute("aria-label", "Show " + label);
    row.classList.toggle("inspector-layer-hidden", !cb.checked);
    cb.addEventListener("change", function () {
      setVisible(cb.checked); row.classList.toggle("inspector-layer-hidden", !cb.checked);
    });
    row.appendChild(cb);
  }
  function inspectorSimpleRow(cfg) {
    var row = el("div", "inspector-layer-row"); row.dataset.legendKind = cfg.kind || "entity";
    inspectorVisibility(row, cfg.label, cfg.visible, cfg.setVisible);
    row.appendChild(inspectorSwatch(cfg.swatch || "dot", cfg.color));
    row.appendChild(el("span", "inspector-layer-label", cfg.label));
    return row;
  }
  function effectivePaint(cfg) {
    var item = cfg.item;
    return {
      name: canonicalColormap(item && item.colormap ? item.colormap : S.colormap),
      reversed: item && (item.colormap != null || item.colormap_reversed != null)
        ? !!item.colormap_reversed : !!S.colormapReversed,
    };
  }
  function setEffectivePaint(cfg, name, reversed) {
    if (cfg.item) {
      cfg.item.colormap = name;
      cfg.item.colormap_reversed = !!reversed;
    } else {
      S.colormap = name;
      S.colormapReversed = !!reversed;
    }
    renderActive(); buildPanel(); exposeInspectorLegendState();
  }
  function inspectorColormapPicker(cfg) {
    var paint = effectivePaint(cfg);
    var host = el("div", "inspector-colormap");
    var trigger = el("button", "inspector-ramp-button"); trigger.type = "button";
    trigger.setAttribute("aria-haspopup", "listbox"); trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-label", "Choose colormap for " + cfg.label);
    var fill = el("span", "inspector-ramp-fill"); fill.style.background = rampGradient(paint.name, paint.reversed);
    trigger.appendChild(fill); host.appendChild(trigger);
    var picker = el("div", "inspector-colormap-picker"); picker.hidden = true;
    var header = el("div", "inspector-picker-header");
    header.appendChild(el("span", null, "Colormap"));
    var reverse = el("button", "inspector-reverse", paint.reversed ? "Reverse ✓" : "Reverse"); reverse.type = "button";
    reverse.setAttribute("aria-pressed", String(paint.reversed));
    reverse.addEventListener("click", function (event) {
      event.stopPropagation(); setEffectivePaint(cfg, paint.name, !paint.reversed);
    });
    header.appendChild(reverse); picker.appendChild(header);
    var list = el("div", "inspector-colormap-list"); list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Colormap");
    COLORMAP_NAMES.forEach(function (name) {
      var option = el("button", "inspector-colormap-option"); option.type = "button";
      option.setAttribute("role", "option"); option.setAttribute("aria-selected", String(name === paint.name));
      option.dataset.colormap = name;
      var preview = el("span", "inspector-ramp-preview"); preview.style.background = rampGradient(name, paint.reversed);
      option.appendChild(preview); option.appendChild(el("span", null, name));
      option.addEventListener("click", function (event) {
        event.stopPropagation(); setEffectivePaint(cfg, name, paint.reversed);
      });
      list.appendChild(option);
    });
    picker.appendChild(list); host.appendChild(picker);
    function closePicker(event) {
      if (event && host.contains(event.target)) return;
      picker.hidden = true; trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", closePicker, true);
    }
    trigger.addEventListener("click", function (event) {
      event.stopPropagation(); picker.hidden = !picker.hidden;
      trigger.setAttribute("aria-expanded", String(!picker.hidden));
      if (!picker.hidden) setTimeout(function () { document.addEventListener("pointerdown", closePicker, true); }, 0);
    });
    return host;
  }
  function rangeSnapshot(range) {
    return { min: Number(range && range.min), max: Number(range && range.max) };
  }
  function inspectorRangeControl(cfg) {
    var host = el("div", "inspector-range");
    var scale = el("button", "inspector-scale"); scale.type = "button";
    scale.setAttribute("aria-label", "Edit exact range for " + cfg.label);
    var edit = el("div", "inspector-range-edit"); edit.hidden = true;
    var lo = el("input"); lo.type = "number"; lo.setAttribute("aria-label", cfg.label + " minimum");
    var hi = el("input"); hi.type = "number"; hi.setAttribute("aria-label", cfg.label + " maximum");
    var yes = el("button", "inspector-range-commit", "✓"); yes.type = "button"; yes.setAttribute("aria-label", "Commit range");
    var no = el("button", "inspector-range-cancel", "×"); no.type = "button"; no.setAttribute("aria-label", "Cancel range edit");
    edit.appendChild(lo); edit.appendChild(hi); edit.appendChild(yes); edit.appendChild(no);
    function seed() {
      var r = rangeSnapshot(cfg.range());
      scale.innerHTML = "";
      scale.appendChild(el("span", null, fmt(r.min)));
      scale.appendChild(el("span", null, fmt((r.min + r.max) / 2)));
      scale.appendChild(el("span", null, fmt(r.max)));
      lo.value = isFinite(r.min) ? r.min : ""; hi.value = isFinite(r.max) ? r.max : "";
    }
    function outside(event) { if (!edit.contains(event.target)) cancel(); }
    function open() {
      seed(); scale.hidden = true; edit.hidden = false; lo.focus(); lo.select();
      setTimeout(function () { document.addEventListener("pointerdown", outside, true); }, 0);
    }
    function cancel() {
      document.removeEventListener("pointerdown", outside, true);
      seed(); edit.hidden = true; scale.hidden = false;
    }
    function commit() {
      if (lo.value.trim() === "" || hi.value.trim() === "") { cancel(); return; }
      var a = Number(lo.value), b = Number(hi.value);
      if (!isFinite(a) || !isFinite(b) || a === b) { cancel(); return; }
      if (a > b) { var swap = a; a = b; b = swap; }
      document.removeEventListener("pointerdown", outside, true);
      cfg.setRange(a, b); renderActive(); buildPanel(); exposeInspectorLegendState();
    }
    function keys(event) {
      if (event.key === "Escape") { event.preventDefault(); cancel(); }
      else if (event.key === "Enter") { event.preventDefault(); commit(); }
    }
    scale.addEventListener("click", open); yes.addEventListener("click", commit); no.addEventListener("click", cancel);
    lo.addEventListener("keydown", keys); hi.addEventListener("keydown", keys); seed();
    host.appendChild(scale); host.appendChild(edit); return host;
  }
  function inspectorContinuousRow(cfg) {
    var row = el("div", "inspector-layer inspector-continuous"); row.dataset.legendKind = "continuous";
    var head = el("div", "inspector-layer-row");
    inspectorVisibility(head, cfg.label, cfg.visible, cfg.setVisible);
    var text = el("span", "inspector-layer-label", cfg.label);
    if (cfg.units) text.appendChild(el("span", "inspector-units", " (" + cfg.units + ")"));
    head.appendChild(text); row.appendChild(head);
    row.appendChild(inspectorColormapPicker(cfg)); row.appendChild(inspectorRangeControl(cfg));
    return row;
  }
  function inspectorCategoricalRow(cfg) {
    var row = el("div", "inspector-layer inspector-categorical"); row.dataset.legendKind = "categorical";
    var head = el("div", "inspector-layer-row");
    inspectorVisibility(head, cfg.label, cfg.visible, cfg.setVisible);
    head.appendChild(el("span", "inspector-layer-label", cfg.label)); row.appendChild(head);
    var classes = el("div", "inspector-class-list");
    cfg.classes.forEach(function (entry, i) {
      var key = el("div", "inspector-class"); key.appendChild(el("span", "inspector-class-index", String(entry.index == null ? i : entry.index)));
      key.appendChild(inspectorSwatch("dot", entry.color)); key.appendChild(el("span", null, entry.label)); classes.appendChild(key);
    });
    row.appendChild(classes); return row;
  }
  function appendCappedEntities(groupEl, rows, view) {
    var expanded = !!S.entityKeysExpanded[view], shown = expanded ? rows : rows.slice(0, INSPECTOR_ENTITY_CAP);
    shown.forEach(function (row) { groupEl.appendChild(row); });
    if (rows.length > INSPECTOR_ENTITY_CAP) {
      var more = el("button", "inspector-more", expanded ? "Show fewer" : "+" + (rows.length - INSPECTOR_ENTITY_CAP) + " more");
      more.type = "button"; more.setAttribute("aria-expanded", String(expanded));
      more.addEventListener("click", function () { S.entityKeysExpanded[view] = !expanded; buildPanel(); });
      groupEl.appendChild(more);
    }
  }
  function arrayRangeRef(array, fallback) {
    return function () {
      var source = array && array.length >= 2 ? array : [fallback.min, fallback.max];
      return { min: Number(source[0]), max: Number(source[1]) };
    };
  }
  function setArrayRange(item, key, lo, hi) { item[key] = [lo, hi]; }
  function mapAggregateDescriptorLabel(map, kind, fallback) {
    var names = mapLegendLayers(map).filter(function (entry) { return entry.kind === kind && entry.name; })
      .map(function (entry) { return pretty(entry.name); });
    return names.length ? fallback + " · " + names.join(" · ") : fallback;
  }
  function setPointLayerVisible(index, visible) {
    S.pointLayerVis[index] = visible;
    S.showPoints = S.pointLayerVis.some(function (entry) { return entry; });
    renderMap(); buildPanel();
  }

  function buildMapInspectorLegend(groupEl) {
    var m = App.payload.map, layer = S.mapLayers[S.mapLayerIdx];
    if (layer) groupEl.appendChild(inspectorContinuousRow({
      label: layer.display || layer.name, units: layer.units, item: layer,
      visible: function () { return S.showMapField; },
      setVisible: function (v) { S.showMapField = v; renderMap(); },
      range: function () { return layer.range || { min: 0, max: 1 }; },
      setRange: function (lo, hi) { layer.range = { min: lo, max: hi }; },
    }));
    var fill = (m.fills || [])[S.mapFillIdx];
    if (fill) groupEl.appendChild(inspectorContinuousRow({
      label: fillLabel(fill), units: fill.units, item: fill,
      visible: function () { return S.showFills; }, setVisible: function (v) { S.showFills = v; renderMap(); },
      range: arrayRangeRef(fill.range, { min: 0, max: 1 }),
      setRange: function (lo, hi) { setArrayRange(fill, "range", lo, hi); },
    }));
    var pc = m.point_color;
    var pointLayers = mapLegendLayers(m).filter(function (entry) {
      return entry.kind === "points" && entry.start != null && entry.n != null;
    });
    if (!pointLayers.length && (m.points || []).length) pointLayers = [{ start: 0, n: m.points.length, _legacy: true }];
    pointLayers.forEach(function (pointLayer, i) {
      var pointRange = pointLayer.colored === false ? null : (pointLayer.range || (pc && pc.range));
      var label = (pointLayer.name ? pretty(pointLayer.name) : "Points") + (pointRange ? " · " + ((pc && pc.by) || "z") : "");
      var visible = function () { return S.pointLayerVis[i] !== false; };
      var setVisible = function (value) { setPointLayerVisible(i, value); };
      if (pointRange) groupEl.appendChild(inspectorContinuousRow({
        label: label, item: pointLayer._legacy ? null : pointLayer,
        visible: visible, setVisible: setVisible,
        range: function () {
          var source = pointLayer.range || (pc && pc.range) || pointRange;
          return { min: Number(source[0]), max: Number(source[1]) };
        },
        setRange: function (lo, hi) {
          if (pointLayer._legacy) pc.range = [lo, hi];
          else pointLayer.range = [lo, hi];
        },
      }));
      else groupEl.appendChild(inspectorSimpleRow({ label: label, kind: "points", color: token("--accent"),
        visible: visible, setVisible: setVisible }));
    });
    if ((m.outline || []).length) groupEl.appendChild(inspectorSimpleRow({ label: "Outline", kind: "line", swatch: "line", color: token("--text-secondary"),
      visible: function () { return S.showOutline; }, setVisible: function (v) { S.showOutline = v; renderMap(); } }));
    if ((m.grid_lines || []).length) groupEl.appendChild(inspectorSimpleRow({ label: mapAggregateDescriptorLabel(m, "lines", "Grid lines"), kind: "line", swatch: "line", color: token("--muted"),
      visible: function () { return S.showGridLines; }, setVisible: function (v) { S.showGridLines = v; renderMap(); } }));
    if ((m.contours || []).length) groupEl.appendChild(inspectorSimpleRow({ label: mapAggregateDescriptorLabel(m, "contours", "Contours"), kind: "line", swatch: "line", color: token("--text-secondary"),
      visible: function () { return S.showContours; }, setVisible: function (v) { S.showContours = v; renderMap(); } }));
    var entities = [];
    (m.contacts || []).forEach(function (contact, i) { entities.push(inspectorSimpleRow({
      label: disp(contact, contact.kind), color: idColor("ct:" + contact.kind), visible: function () { return S.contactVis[i]; },
      setVisible: function (v) { S.contactVis[i] = v; renderMap(); },
    })); });
    (App.payload.wells || []).forEach(function (well, i) { entities.push(inspectorSimpleRow({
      label: disp(well, well.id), color: idColor("well:" + well.id), visible: function () { return S.wellVis[i]; },
      setVisible: function (v) { S.wellVis[i] = v; renderMap(); },
    })); });
    appendCappedEntities(groupEl, entities, "map"); exposeInspectorLegendState();
  }
  function buildSectionInspectorLegend(groupEl) {
    var b = S.sections[S.sectionIdx]; if (!b) return;
    var zoneMode = S.sectionColorBy === "zone" && sectionHasZoneData(b);
    if (zoneMode) groupEl.appendChild(inspectorCategoricalRow({
      label: "Zones", visible: function () { return S.showSectionFill; },
      setVisible: function (v) { S.showSectionFill = v; renderSection(); },
      classes: b.zones.map(function (zone, i) { return { index: i, label: pretty(zone.name), color: zone.color || idColor("zone:" + zone.name) }; }),
    }));
    else {
      var range = S.sectionRanges[S.sectionIdx] || { min: 0, max: 1 };
      groupEl.appendChild(inspectorContinuousRow({
        label: pretty(b.property || "value"), units: b.units,
        visible: function () { return S.showSectionFill; }, setVisible: function (v) { S.showSectionFill = v; renderSection(); },
        range: function () { return S.sectionRanges[S.sectionIdx] || range; },
        setRange: function (lo, hi) { S.sectionRanges[S.sectionIdx] = { min: lo, max: hi }; },
      }));
    }
    var entities = [];
    if (sectionHasHorizonGeometry(b)) entities.push(inspectorSimpleRow({ label: "Horizons", swatch: "line", color: token("--text-secondary"), visible: function () { return S.showHorizons; }, setVisible: function (v) { S.showHorizons = v; renderSection(); } }));
    if (sectionHasContactGeometry(b)) entities.push(inspectorSimpleRow({ label: "Contacts", swatch: "line", color: token("--muted"), visible: function () { return S.showContacts; }, setVisible: function (v) { S.showContacts = v; renderSection(); } }));
    if ((b.columns || []).some(function (column) { return column.path_z != null; })) entities.push(inspectorSimpleRow({ label: "Bore path", swatch: "line", color: token("--c1"), visible: function () { return S.showPathZ; }, setVisible: function (v) { S.showPathZ = v; renderSection(); } }));
    appendCappedEntities(groupEl, entities, "section"); exposeInspectorLegendState();
  }
  function exposeInspectorLegendState() {
    if (typeof window === "undefined") return;
    window.__PETEK_COLORMAP_STATE = {
      names: COLORMAP_NAMES.slice(), name: S.colormap, reversed: !!S.colormapReversed,
      lutKeys: Object.keys(_lutCache || {}), entityCap: INSPECTOR_ENTITY_CAP,
      pointVisibility: (S.pointLayerVis || []).slice(),
    };
  }
