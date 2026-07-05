/*
 * Playwright harness for the Intersection tab's COLOR-BY-ZONE mode (v-zone-color).
 *
 * A SectionBundle may carry `zones: [{name, color?}]` and per-column `zone_ids`
 * (per-k, aligned/NaN-gapped like `values`; an index into `zones`). A "Color by:
 * property | zone" select on the section panel flips the cell FILL between the
 * property colormap and the fixed categorical ZONE identity. This harness drives
 * a real headless browser over a hand-authored fixture and asserts (in the pytest
 * caller):
 *   - the select exists with property/zone options; zone mode reports via
 *     window.__PETEK_SECTION_COLORBY;
 *   - a zone cell fills with the zone's IDENTITY colour, and that colour equals
 *     the Volume tab's zone-legend chip for the same name (identity follows the
 *     entity across views — the dataviz rule);
 *   - a user-declared hex on a zone WINS over the categorical slot (override);
 *   - a payload without zone_ids never shows the select (window.__PETEK_SECTION_
 *     HAS_ZONES=false) — graceful fallback;
 *   - both themes, zero console errors.
 *
 * Prints one JSON line; exit 0 (assertions live in the pytest caller).
 *
 * Run: node zone_bench.mjs <view.html> --dmax=300 [--screenshot=PATH]
 */
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) { console.error("usage: node zone_bench.mjs <view.html> [flags]"); process.exit(2); }
const flag = (name, def) => {
  const hit = args.find((a) => a === "--" + name || a.startsWith("--" + name + "="));
  if (!hit) return def;
  const eq = hit.indexOf("=");
  return eq < 0 ? true : hit.slice(eq + 1);
};
const dmax = parseFloat(flag("dmax", "300"));
const shot = flag("screenshot", null);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(pathToFileURL(file).href);

const result = await page.evaluate(async (cfg) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clickTab = (name) => { const t = document.querySelector(`.tab[data-tab="${name}"]`); if (t) t.click(); };
  const parseRGB = (s) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s || ""); return m ? [+m[1], +m[2], +m[3]] : null; };

  // The section renderer's fixed frame paddings (mirror renderSection).
  const PAD = { L: 60, R: 20, T: 24, B: 42 };
  // Modal colour of a small patch centred on (dist, depth) — robust against a
  // stray 1px trace/antialias pixel: bin the patch's colours and return the most
  // common one.
  const cellColorAt = (dist, depth) => {
    const cv = document.getElementById("section-canvas");
    const ctx = cv.getContext("2d");
    const fr = window.__PETEK_SECTION_FRAME;
    const W = cv.width - PAD.L - PAD.R, H = cv.height - PAD.T - PAD.B;
    const cx = Math.round(PAD.L + (dist / cfg.dmax) * W);
    const cy = Math.round(PAD.T + ((depth - fr.zmin) / (fr.zmax - fr.zmin)) * H);
    const counts = {};
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        const p = ctx.getImageData(cx + dx, cy + dy, 1, 1).data;
        const key = p[0] + "," + p[1] + "," + p[2];
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    return best.split(",").map(Number);
  };
  // The "Color by" select (label-matched in the section panel).
  const colorBySelect = () => {
    const rows = [...document.querySelectorAll("#panel-body .row")];
    const row = rows.find((r) => { const l = r.querySelector("label"); return l && l.textContent === "Color by"; });
    return row ? row.querySelector("select") : null;
  };
  const setColorBy = (val) => {
    const sel = colorBySelect();
    if (!sel) return false;
    sel.value = val === "zone" ? "1" : "0";
    sel.dispatchEvent(new Event("change"));
    return true;
  };
  // Volume-tab zone legend: chip name -> swatch background rgb.
  const volumeLegend = async () => {
    clickTab("volume");
    for (let i = 0; i < 60; i++) {
      const st = window.__PETEK_VOLUME_STATUS;
      if (st && (st.state === "ok" || st.state === "empty" || st.state === "error")) break;
      await sleep(50);
    }
    await sleep(40);
    const out = {};
    document.querySelectorAll("#legend .keys .k").forEach((k) => {
      const sw = k.querySelector(".swatch");
      const label = k.querySelector("span:last-child");
      if (sw && label) out[label.textContent] = parseRGB(getComputedStyle(sw).backgroundColor);
    });
    return out;
  };

  // ---- section tab: initial (property) state --------------------------------
  clickTab("section");
  await sleep(80);
  const hasZones = !!window.__PETEK_SECTION_HAS_ZONES;
  const colorByInitial = window.__PETEK_SECTION_COLORBY || null;
  const sel = colorBySelect();
  const selectOptions = sel ? [...sel.options].map((o) => o.textContent) : [];

  if (!hasZones) {
    // Graceful-fallback fixture: no select, stays on property; sample once.
    return { hasZones, colorByInitial, hasSelect: !!sel, selectOptions, consoleErrors: null };
  }

  // ---- switch to zone mode + sample the three stacked bands (light) ---------
  setColorBy("zone");
  await sleep(80);
  const colorByAfter = window.__PETEK_SECTION_COLORBY || null;
  // fixture: 3 bands, centres 2015 / 2045 / 2075; sample at column-1 centre.
  const dsamp = cfg.dmax / 3;
  const zoneLight = {
    band0: cellColorAt(dsamp, cfg.z0),
    band1: cellColorAt(dsamp, cfg.z1),
    band2: cellColorAt(dsamp, cfg.z2),
  };
  const legendZoneChips = [...document.querySelectorAll("#legend .keys .k")].map((k) => {
    const sw = k.querySelector(".swatch");
    return { text: k.querySelector("span:last-child")?.textContent, rgb: sw ? parseRGB(getComputedStyle(sw).backgroundColor) : null, line: sw && sw.classList.contains("line") };
  });

  if (cfg.shot) { /* screenshot handled by the node caller after evaluate */ }

  // volume legend for the identity cross-check
  const volLegend = await volumeLegend();

  // ---- theme flip: zone fill must survive (dark) ----------------------------
  clickTab("section");
  await sleep(40);
  const toggle = document.getElementById("theme-toggle");
  if (toggle) toggle.click();
  await sleep(80);
  const zoneDark = {
    band0: cellColorAt(dsamp, cfg.z0),
    band1: cellColorAt(dsamp, cfg.z1),
    band2: cellColorAt(dsamp, cfg.z2),
  };
  const appEl = document.getElementById("app");
  const theme = (appEl && appEl.getAttribute("data-theme")) || "light";

  return {
    hasZones, colorByInitial, hasSelect: !!sel, selectOptions, colorByAfter,
    zoneLight, zoneDark, legendZoneChips, volLegend, theme,
  };
}, { dmax, z0: 2015, z1: 2045, z2: 2075, shot: !!shot });

// screenshot the zone-mode section (light) — re-enter section tab first.
if (shot && result.hasZones) {
  await page.evaluate(() => { const t = document.querySelector('.tab[data-tab="section"]'); if (t) t.click(); });
  // ensure light theme for the shot
  await page.evaluate(() => {
    const app = document.getElementById("app");
    if (app && app.getAttribute("data-theme") === "dark") document.getElementById("theme-toggle").click();
  });
  await page.waitForTimeout(120);
  await page.screenshot({ path: shot });
}

console.log(JSON.stringify({ rc: 0, consoleErrors, ...result }));
await browser.close();
