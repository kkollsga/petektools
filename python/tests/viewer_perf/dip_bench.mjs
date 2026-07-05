/*
 * Playwright harness for the section tab's SUGAR-CUBE ruling (v4-additive).
 *
 * Owner ruling: flat-box section cells are "sugar cube mode" and must not be
 * the default — with per-column edge arrays (layer_tops_l/r, layer_bases_l/r)
 * present and `sugar_cube` false/absent, each cell renders as a TRAPEZOID that
 * follows the zone-edge dip WITHIN the column. This harness drives a real
 * headless browser over a hand-authored dipping fixture and PIXEL-SAMPLES the
 * rendered canvas: it locates the first painted row (the cell top / its trace)
 * at two x positions inside ONE column and reports the y difference — dipping
 * trapezoid => non-horizontal (dy >> 0); sugar-cube / legacy => flat (dy ~ 0).
 * It then flips the theme and re-samples (tokens re-read, dip must survive).
 *
 * Reads window.__PETEK_SECTION_MODE ("trapezoid" | "rect"). Prints one JSON
 * line; exit 0 (assertions live in the pytest caller).
 *
 * Run: node dip_bench.mjs <view.html> --d1=75 --d2=125 --dmax=300
 */
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) { console.error("usage: node dip_bench.mjs <view.html> [flags]"); process.exit(2); }
const flag = (name, def) => {
  const hit = args.find((a) => a === "--" + name || a.startsWith("--" + name + "="));
  if (!hit) return def;
  const eq = hit.indexOf("=");
  return eq < 0 ? true : hit.slice(eq + 1);
};
const d1 = parseFloat(flag("d1", "75"));
const d2 = parseFloat(flag("d2", "125"));
const dmax = parseFloat(flag("dmax", "300"));
// A depth guaranteed INSIDE the probed cell in every mode (the scan starts here
// and walks UP to the fill's top boundary — scanning down from the frame top
// would hit the sloping centroid horizon trace, which crosses above a flat
// sugar-cube rect and is not the cell top).
const zprobe = parseFloat(flag("zprobe", "2060"));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(pathToFileURL(file).href);

const result = await page.evaluate(async (cfg) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clickTab = (name) => { const t = document.querySelector(`.tab[data-tab="${name}"]`); if (t) t.click(); };

  clickTab("section");
  await sleep(60);   // synchronous render; small settle for layout

  // Mirror the section renderer's fixed frame paddings + gridline rows so the
  // scan can skip the axis hairlines (drawn full-width AFTER the fills). The
  // depth->y map is reconstructed from __PETEK_SECTION_FRAME, so the probe
  // depth lands exactly where the renderer put it in every mode/frame.
  const sample = (dA, dB) => {
    const cv = document.getElementById("section-canvas");
    const ctx = cv.getContext("2d");
    const fr = window.__PETEK_SECTION_FRAME;
    const padL = 60, padR = 20, padT = 24, padB = 42;
    const W = cv.width - padL - padR, H = cv.height - padT - padB;
    const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const px = (x, y) => { const o = (y * cv.width + x) * 4; return [img[o], img[o + 1], img[o + 2]]; };
    const gridRows = [0, 1, 2, 3, 4].map((t) => Math.round(padT + (t * H) / 4));
    const isGridRow = (y) => gridRows.some((g) => Math.abs(y - g) <= 2);
    const X = (d) => Math.round(padL + (d / cfg.dmax) * W);
    const Y = (z) => Math.round(padT + ((z - fr.zmin) / (fr.zmax - fr.zmin)) * H);
    // The FILL's top boundary at x: start INSIDE the cell (the probe depth) and
    // walk UP until the colour departs from the fill reference. Gridline rows
    // are skipped; a trace ON the boundary reads as the boundary (same y).
    const topBoundaryY = (x) => {
      let y0 = Y(cfg.zprobe);
      while (isGridRow(y0)) y0 += 3;   // don't reference a hairline row
      const ref = px(x, y0);
      for (let y = y0 - 1; y > padT + 2; y--) {
        if (isGridRow(y)) continue;
        const c = px(x, y);
        if (Math.abs(c[0] - ref[0]) + Math.abs(c[1] - ref[1]) + Math.abs(c[2] - ref[2]) > 60) return y + 1;
      }
      return -1;
    };
    return { y1: topBoundaryY(X(dA)), y2: topBoundaryY(X(dB)), w: cv.width, h: cv.height };
  };

  const before = sample(cfg.d1, cfg.d2);
  const mode = window.__PETEK_SECTION_MODE || null;
  const frame = window.__PETEK_SECTION_FRAME || null;

  // Theme flip: tokens re-read, everything re-renders; the dip must survive.
  const toggle = document.getElementById("theme-toggle");
  if (toggle) toggle.click();
  await sleep(60);
  const after = sample(cfg.d1, cfg.d2);
  const modeAfter = window.__PETEK_SECTION_MODE || null;
  // the viewer keeps its theme attribute on #app (viewer.js `root`)
  const appEl = document.getElementById("app");
  const theme = (appEl && appEl.getAttribute("data-theme")) || "light";

  return { mode, frame, before, after, modeAfter, theme };
}, { d1, d2, dmax, zprobe });

console.log(JSON.stringify({ rc: 0, consoleErrors, ...result }));
await browser.close();
