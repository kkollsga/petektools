  // ---- legends -------------------------------------------------------------
  // A small canvas TYPE GLYPH for a legend entry — the layer-kind icons: dot
  // cluster = points, lattice lines = geometry/grid lines, filled colormap
  // swatch = value fill, squiggle = contours, marker-with-leader = wells.
  // Drawn from the live tokens/colormap, so a theme flip or colormap change
  // restyles it on the next legend rebuild.
  function typeIcon(kind, color, cmap, reversed) {
    var c = document.createElement("canvas");
    c.width = 18; c.height = 12; c.className = "type-icon";
    var x = c.getContext("2d");
    if (kind === "points") {
      x.fillStyle = color || token("--accent");
      [[4, 6], [9, 3], [13, 8], [8, 9]].forEach(function (p) {
        x.beginPath(); x.arc(p[0], p[1], 1.7, 0, 6.2832); x.fill();
      });
    } else if (kind === "lines") {
      x.strokeStyle = color || token("--muted"); x.lineWidth = 1.2;
      x.beginPath();
      x.moveTo(1, 3.5); x.lineTo(17, 3.5); x.moveTo(1, 8.5); x.lineTo(17, 8.5);
      x.moveTo(6, 1); x.lineTo(6, 11); x.moveTo(12, 1); x.lineTo(12, 11);
      x.stroke();
    } else if (kind === "contours") {
      x.strokeStyle = color || token("--text-secondary"); x.lineWidth = 1.5;
      x.beginPath(); x.moveTo(1, 8); x.bezierCurveTo(5, 1, 8, 12, 12, 5); x.quadraticCurveTo(15, 1, 17, 4); x.stroke();
    } else if (kind === "wells") {
      x.fillStyle = color || token("--text-secondary");
      x.beginPath(); x.arc(7, 6, 3.2, 0, 6.2832); x.fill();
      x.strokeStyle = token("--surface-1"); x.lineWidth = 1.2; x.stroke();
      x.strokeStyle = color || token("--text-secondary"); x.lineWidth = 1;
      x.beginPath(); x.moveTo(11, 6); x.lineTo(16, 6); x.stroke();
    } else { // "fill": a filled swatch carrying the layer's colormap ramp
      var g = x.createLinearGradient(0, 0, 18, 0);
      var stops = colormapStops(cmap || S.colormap, reversed);
      stops.forEach(function (s, i) { g.addColorStop(i / (stops.length - 1), "rgb(" + s[0] + "," + s[1] + "," + s[2] + ")"); });
      x.fillStyle = g;
      x.fillRect(1, 1, 16, 10);
    }
    return c;
  }
  function iconKeyRow(kind, label, color) {
    var k = el("div", "k");
    k.appendChild(typeIcon(kind, color));
    k.appendChild(el("span", null, label));
    return k;
  }
  // One value-coloured legend block: [icon] name header + colormap ramp +
  // min/max scale (the range already reflects any user clamp — out-of-range
  // values render at the ramp ends). `cmap` pins the layer's own ramp
  // (per-object colour); default: the panel colormap.
  function rampBlock(lg, icon, label, lo, hi, cmap, reversed) {
    var h = el("h3");
    if (icon) h.appendChild(icon);
    h.appendChild(el("span", null, label));
    lg.appendChild(h);
    var ramp = el("div", "ramp"); ramp.style.background = rampGradient(cmap || S.colormap, reversed);
    lg.appendChild(ramp);
    var sc = el("div", "scale");
    sc.appendChild(el("span", null, fmt(lo)));
    sc.appendChild(el("span", null, fmt(hi)));
    lg.appendChild(sc);
  }
  // The map's per-layer legend entries. `map.layers` (additive) carries one
  // {kind, name} per emitted layer, `name` duck-typed from the producer object
  // (e.g. "Top Dome"); an older payload without it derives plain kind entries.
  function mapLegendLayers(m) {
    if (m.layers && m.layers.length) return m.layers;
    var out = [];
    if ((m.points || []).length) out.push({ kind: "points", name: null });
    if ((m.grid_lines || []).length) out.push({ kind: "lines", name: null });
    if ((m.contours || []).length) out.push({ kind: "contours", name: null });
    return out;
  }
  function clearInspectorOwnedPlotLegend() {
    var lg = document.getElementById("legend");
    if (!lg) return;
    if (lg.childNodes.length || lg.style.display !== "none") perfCount("legendMutations");
    lg.innerHTML = ""; lg.style.display = "none";
  }
  function drawVolumeLegend() {
    var lg = document.getElementById("legend"); lg.innerHTML = "";
    var v = App.payload.volume;
    lg.appendChild(el("h3", null, v.property + "  (fraction)"));
    var ramp = el("div", "ramp"); ramp.style.background = rampGradient(S.colormap, S.colormapReversed); lg.appendChild(ramp);
    var sc = el("div", "scale"); sc.appendChild(el("span", null, fmt(v.value_range.min))); sc.appendChild(el("span", null, fmt(v.value_range.max))); lg.appendChild(sc);
    var keys = el("div", "keys");
    (v.zone_names || []).forEach(function (z, i) { if (S.zoneVis[i]) keys.appendChild(keyRow(z, idColor("zone:" + z), false)); });
    if (keys.childNodes.length) lg.appendChild(keys);
    lg.style.display = "block";
  }
  function keyRow(label, color, isLine) {
    var k = el("div", "k");
    var sw = el("span", isLine ? "swatch line" : "swatch"); if (isLine) sw.style.borderTopColor = color; else sw.style.background = color;
    k.appendChild(sw); k.appendChild(el("span", null, label)); return k;
  }
  function drawChartLegend(ch) {
    var lg = document.getElementById("legend"); lg.innerHTML = "";
    var keys = el("div", "keys");
    if (ch.mark === "tornado") {
      lg.appendChild(el("h3", null, "swing vs base" + (ch.units ? "  (" + ch.units + ")" : "")));
      keys.appendChild(keyRow("below base (low)", token("--swing-lo"), false));
      keys.appendChild(keyRow("above base (high)", token("--swing-hi"), false));
    } else if (ch.mark === "scatter") {
      var cb = ch.color_by || {};
      if (cb.kind === "continuous") {
        lg.appendChild(el("h3", null, (cb.name || "colour") + (cb.units ? "  (" + cb.units + ")" : "")));
        var ramp = el("div", "ramp"); ramp.style.background = rampGradient(S.colormap, S.colormapReversed); lg.appendChild(ramp);
        var sc = el("div", "scale"); var cr = cb.range || { min: 0, max: 1 };
        sc.appendChild(el("span", null, fmt(cr.min))); sc.appendChild(el("span", null, fmt(cr.max))); lg.appendChild(sc);
      } else if (cb.name) {
        lg.appendChild(el("h3", null, cb.name));
        (ch.groups || []).forEach(function (g) { keys.appendChild(keyRow(pretty(g), idColor("grp:" + g), false)); });
      }
    } else if (ch.mark === "distribution") {
      // A single series is already named by the chart title — drop the legend box.
      if ((ch.series || []).length > 1) {
        lg.appendChild(el("h3", null, "series"));
        (ch.series || []).forEach(function (s) { keys.appendChild(keyRow(disp(s, s.name), idColor("dist:" + s.name), false)); });
      }
    }
    if (keys.childNodes.length) lg.appendChild(keys);
    lg.style.display = lg.childNodes.length ? "block" : "none";
  }

  // ---- readout -------------------------------------------------------------
  function showReadout(ev, rows) {
    var r = document.getElementById("readout");
    r.innerHTML = "";
    rows.forEach(function (row) {
      var d = el("div");
      if (row[0]) { d.appendChild(el("span", "lbl", row[0] + " ")); d.appendChild(el("span", row[0] === "value" ? "val" : null, row[1])); }
      else d.appendChild(el("span", null, row[1]));
      r.appendChild(d);
    });
    var host = document.getElementById("view").getBoundingClientRect();
    r.style.left = Math.min(ev.clientX - host.left + 14, host.width - 240) + "px";
    r.style.top = (ev.clientY - host.top + 14) + "px";
    r.hidden = false;
  }
  function hideReadout() { document.getElementById("readout").hidden = true; }
  function showEmpty(msg) { var e = document.getElementById("empty"); e.textContent = msg; e.hidden = false; document.getElementById("legend").style.display = "none"; }
  function hideEmpty() { document.getElementById("empty").hidden = true; }
  // A loud, dismissible failure/guard surface. `title` bold, `detail` body, and
  // an optional `remedy` hint (the k-slab / LOD / threshold suggestion).
  function showBanner(title, detail, remedy) {
    var b = document.getElementById("banner");
    b.innerHTML = "";
    b.appendChild(el("div", null)).appendChild(el("b", null, title));
    if (detail) b.appendChild(el("div", null, detail));
    if (remedy) b.appendChild(el("div", "hint", remedy));
    b.hidden = false;
  }
  function hideBanner() { var b = document.getElementById("banner"); if (b) b.hidden = true; }

  // ---- section requests (live server or file-mode resolve) -----------------
  function requestSection(req, label) {
    if (App.mode !== "server") {
      showEmpty("Live sectioning needs the server (model.view()). This file export ships only pre-computed sections.");
      return;
    }
    var params = new URLSearchParams();
    if (req.line) params.set("line", JSON.stringify(req.line));
    if (req.well) params.set("well", req.well);
    fetch("./section?" + params.toString())
      .then(function (r) { if (!r.ok) return r.text().then(function (t) { throw new Error(t); }); return r.json(); })
      .then(function (bundle) {
        S.sections.push(bundle); S.sectionLabels.push(label + " " + S.sections.length);
        var sourceRange = bundle.value_range || (App.payload.volume && App.payload.volume.value_range) || { min: 0, max: 1 };
        S.sectionRanges.push({ min: Number(sourceRange.min), max: Number(sourceRange.max) });
        S.sectionIdx = S.sections.length - 1;
        selectTab("section");
      })
      .catch(function (e) { showEmpty("Section request failed: " + e.message); });
  }
  function sectionForWell(well) {
    // file mode: switch to the pre-computed bore section if present
    var idx = S.sectionLabels.indexOf(well.id);
    if (idx >= 0) { S.sectionIdx = idx; selectTab("section"); return; }
    if (App.mode === "server") requestSection({ well: well.id }, well.id);
    else showEmpty("No pre-computed section for well " + well.id + " in this file export.");
  }
