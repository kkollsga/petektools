  // ---- legends -------------------------------------------------------------
  function drawFieldLegend(layer) {
    var lg = document.getElementById("legend"); lg.innerHTML = "";
    if (layer) {
      lg.appendChild(el("h3", null, (layer.display || layer.name) + (layer.units ? "  (" + layer.units + ")" : "")));
      var ramp = el("div", "ramp"); ramp.style.background = rampGradient(S.colormap);
      lg.appendChild(ramp);
      var sc = el("div", "scale");
      sc.appendChild(el("span", null, fmt(layer.range.min)));
      sc.appendChild(el("span", null, fmt(layer.range.max)));
      lg.appendChild(sc);
    }
    // identity keys present in this view
    var keys = el("div", "keys");
    if (App.tab === "map") {
      (App.payload.map.contacts || []).forEach(function (c, i) { if (S.contactVis[i]) keys.appendChild(keyRow(disp(c, c.kind), idColor("ct:" + c.kind), false)); });
      (App.payload.wells || []).forEach(function (w, i) { if (S.wellVis[i]) keys.appendChild(keyRow(disp(w, w.id), idColor("well:" + w.id), false)); });
    } else if (App.tab === "section") {
      var b = S.sections[S.sectionIdx];
      if (b) {
        // zone-colour mode: lead with the ZONE CHIPS (the categorical fill legend)
        // — a declared hex, else the fixed identity slot for the zone name (the
        // same colour the volume/wells zone legend shows for that zone).
        if (S.sectionColorBy === "zone" && b.zones && b.zones.length) {
          lg.appendChild(el("h3", null, "zones"));
          b.zones.forEach(function (z) { keys.appendChild(keyRow(pretty(z.name), z.color || idColor("zone:" + z.name), false)); });
        }
        keys.appendChild(keyRow(pretty(b.top_name), idColor("hz:" + b.top_name), true)); keys.appendChild(keyRow(pretty(b.base_name), idColor("hz:" + b.base_name), true)); (b.contacts || []).forEach(function (c) { keys.appendChild(keyRow(pretty(c.kind), idColor("ct:" + c.kind), true)); });
      }
    }
    if (keys.childNodes.length) lg.appendChild(keys);
    lg.style.display = lg.childNodes.length ? "block" : "none";
  }
  function drawVolumeLegend() {
    var lg = document.getElementById("legend"); lg.innerHTML = "";
    var v = App.payload.volume;
    lg.appendChild(el("h3", null, v.property + "  (fraction)"));
    var ramp = el("div", "ramp"); ramp.style.background = rampGradient(S.colormap); lg.appendChild(ramp);
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
        var ramp = el("div", "ramp"); ramp.style.background = rampGradient(S.colormap); lg.appendChild(ramp);
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

