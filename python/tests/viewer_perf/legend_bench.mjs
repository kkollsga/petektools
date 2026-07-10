/*
 * Playwright harness for the map's colour-spec + per-layer legend semantics
 * (view2d color="inferno_-2700_-2500" over named points + a geometry):
 *   - the point cloud RENDERS in the payload-pinned inferno ramp, and values
 *     outside the explicit range CLAMP to the ramp ends (a below-min blob
 *     paints exactly like the min blob, never like the max blob);
 *   - the legend shows one entry per visible layer with a TYPE ICON and the
 *     duck-typed display name (e.g. "Top Agat"), plus the ramp + the CLAMPED
 *     user range for the value-coloured points layer;
 *   - the panel colormap selector initializes from map.colormap ("inferno");
 *   - a theme flip re-renders the same semantics with zero console errors.
 *
 * Prints one JSON line; exit 0 (assertions live in the pytest caller).
 *
 * Run: node legend_bench.mjs <view.html> --p1=x,y --p2=x,y --p3=x,y
 *      [--shot-light=PATH --shot-dark=PATH]
 * The --pN flags are WORLD coordinates of three probe blobs (max / min /
 * below-min z); the harness maps them through window.__PETEK_MAP_VIEW.
 */
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) { console.error("usage: node legend_bench.mjs <view.html> [flags]"); process.exit(2); }
const flag = (name, def) => {
  const hit = args.find((a) => a === "--" + name || a.startsWith("--" + name + "="));
  if (!hit) return def;
  const eq = hit.indexOf("=");
  return eq < 0 ? true : hit.slice(eq + 1);
};
const world = (name) => (flag(name, "0,0") || "0,0").split(",").map(Number);
const p1 = world("p1"), p2 = world("p2"), p3 = world("p3");
const shotLight = flag("shot-light", null);
const shotDark = flag("shot-dark", null);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(pathToFileURL(file).href);
await page.waitForTimeout(250);

const sampleAll = async (cfg) => page.evaluate((c) => {
  const cv = document.getElementById("map-canvas");
  const ctx = cv.getContext("2d");
  const v = window.__PETEK_MAP_VIEW;
  // modal colour of a 9x9 patch centred on a WORLD coordinate — robust
  // against a stray grid-line / antialias pixel inside a dense point blob.
  const patch = (wx, wy) => {
    const px = Math.round(wx * v.scale + v.ox), py = Math.round(wy * v.scale + v.oy);
    const counts = {};
    for (let dx = -4; dx <= 4; dx++) {
      for (let dy = -4; dy <= 4; dy++) {
        const p = ctx.getImageData(px + dx, py + dy, 1, 1).data;
        const key = p[0] + "," + p[1] + "," + p[2];
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    return best.split(",").map(Number);
  };
  // the legend as structured text: h3 headers, ramp scales, key rows, icons
  const headers = [...document.querySelectorAll("#legend h3")].map((h) => h.textContent);
  const scales = [...document.querySelectorAll("#legend .scale")]
    .map((s) => [...s.children].map((c) => c.textContent));
  const keys = [...document.querySelectorAll("#legend .keys .k span:last-child")]
    .map((t) => t.textContent);
  const icons = document.querySelectorAll("#legend canvas.type-icon").length;
  // the panel colormap selector's active option
  let colormap = null;
  [...document.querySelectorAll("#panel-body .row")].forEach((r) => {
    const l = r.querySelector("label");
    if (l && l.textContent === "Colormap") {
      const sel = r.querySelector("select");
      colormap = sel.options[sel.selectedIndex].textContent;
    }
  });
  // background reference (a top-left corner patch, outside the fitted
  // content) — point colours composite over it at the batched-path alpha
  const bgCounts = {};
  for (let dx = 2; dx <= 8; dx++) {
    for (let dy = 2; dy <= 8; dy++) {
      const p = ctx.getImageData(dx, dy, 1, 1).data;
      const key = p[0] + "," + p[1] + "," + p[2];
      bgCounts[key] = (bgCounts[key] || 0) + 1;
    }
  }
  const bg = Object.keys(bgCounts).sort((a, b) => bgCounts[b] - bgCounts[a])[0]
    .split(",").map(Number);
  return {
    mapView: v, headers, scales, keys, icons, colormap, bg,
    blobMax: patch(c.p1[0], c.p1[1]),
    blobMin: patch(c.p2[0], c.p2[1]),
    blobClamped: patch(c.p3[0], c.p3[1]),
    theme: document.getElementById("app").getAttribute("data-theme") || "light",
  };
}, cfg);

const light = await sampleAll({ p1, p2, p3 });
if (shotLight) await page.screenshot({ path: shotLight });

// theme flip: the legend + point ramp must survive the token re-read
await page.evaluate(() => document.getElementById("theme-toggle").click());
await page.waitForTimeout(150);
const dark = await sampleAll({ p1, p2, p3 });
if (shotDark) await page.screenshot({ path: shotDark });

console.log(JSON.stringify({ rc: 0, consoleErrors, light, dark }));
await browser.close();
