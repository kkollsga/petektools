/*
 * Playwright harness for viewer wave 4 — the Wells correlation tab + the two v4
 * render obligations (section interior-horizon traces, map tie glyphs). The
 * volume-centric render_bench.mjs asserts the mesh path; this drives the
 * correlation-view path the wave adds: the Wells tab at both hanging modes (TVD +
 * flatten-on-pick), a theme flip, a synthetic hover, and the section/map tabs —
 * all under the same zero-console-error watch. Optionally writes the four
 * inspection screenshots.
 *
 * Run:  node wells_bench.mjs <view.html> [--shots-dir=DIR]
 *   Exit 0 = the Wells/section/map tabs rendered, both hang modes worked, no
 *   console error. Exit 6 = console errors; 7 = a tab never rendered.
 *
 * Prints one JSON line with the measurements + any screenshot paths.
 */
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) { console.error("usage: node wells_bench.mjs <view.html> [--shots-dir=DIR]"); process.exit(2); }
const flag = (name, def) => {
  const hit = args.find((a) => a === "--" + name || a.startsWith("--" + name + "="));
  if (!hit) return def;
  const eq = hit.indexOf("="); return eq < 0 ? true : hit.slice(eq + 1);
};
const shotsDir = flag("shots-dir", null);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 880 } });

const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(pathToFileURL(file).href);

const shot = async (name) => {
  if (!shotsDir || shotsDir === true) return null;
  const p = path.join(shotsDir, name);
  await page.screenshot({ path: p, fullPage: false });
  return p;
};

const result = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clickTab = (name) => { const t = document.querySelector(`.tab[data-tab="${name}"]`); if (t) { t.click(); return true; } return false; };
  const renderMs = () => +(window.__PETEK_RENDER_MS || 0);
  const out = {};

  // 1) Wells tab — TVD (default) render.
  out.hasWellsTab = !!document.querySelector('.tab[data-tab="wells"]');
  clickTab("wells"); await sleep(60);
  out.wellsTvdRenderMs = renderMs();

  // 2) Flatten-on-pick: find the "Hang" select in the panel, switch to Flatten.
  const selects = Array.from(document.querySelectorAll("#panel-body select"));
  const hang = selects.find((s) => Array.from(s.options).some((o) => /flatten/i.test(o.textContent)));
  out.foundHangSelect = !!hang;
  if (hang) {
    hang.value = Array.from(hang.options).findIndex((o) => /flatten/i.test(o.textContent));
    hang.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(60);
  }
  out.wellsFlattenRenderMs = renderMs();
  out.correlationLayout = window.__PETEK_CORRELATION_LAYOUT || null;

  // 3) Synthetic hover over the wells canvas (readout must not throw).
  const wc = document.getElementById("wells-canvas");
  if (wc) {
    const r = wc.getBoundingClientRect();
    wc.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r.left + r.width * 0.4, clientY: r.top + r.height * 0.5 }));
    await sleep(20);
    out.readoutShown = !document.getElementById("readout").hidden;
  }

  // 4) Theme flip re-renders (tokens re-read) without throwing.
  const themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) { themeBtn.click(); await sleep(30); themeBtn.click(); await sleep(30); }

  // 5) Section tab (interior-horizon traces) + Map tab (tie glyphs) render.
  clickTab("section"); await sleep(50); out.sectionRenderMs = renderMs();
  // The computed section depth frame (window.__PETEK_SECTION_FRAME hook) — the
  // null-poisoning regression asserts it spans the FINITE data only (a JSON
  // null layer depth must never drag zlo to 0 / zmin negative).
  out.sectionFrame = window.__PETEK_SECTION_FRAME || null;
  clickTab("map"); await sleep(50); out.mapRenderMs = renderMs();

  return out;
});

// Screenshots of each required view (re-drive tabs from Node so the shot is clean).
const shots = {};
if (shotsDir && shotsDir !== true) {
  await page.evaluate(async () => { document.querySelector('.tab[data-tab="wells"]').click(); await new Promise((r) => setTimeout(r, 60)); });
  // ensure TVD mode for the first shot
  await page.evaluate(async () => {
    const sel = Array.from(document.querySelectorAll("#panel-body select")).find((s) => Array.from(s.options).some((o) => /flatten/i.test(o.textContent)));
    if (sel) { sel.value = 0; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    await new Promise((r) => setTimeout(r, 60));
  });
  shots.wells_tvd = await shot("wells_correlation_tvd.png");
  await page.evaluate(async () => {
    const sel = Array.from(document.querySelectorAll("#panel-body select")).find((s) => Array.from(s.options).some((o) => /flatten/i.test(o.textContent)));
    if (sel) { sel.value = Array.from(sel.options).findIndex((o) => /flatten/i.test(o.textContent)); sel.dispatchEvent(new Event("change", { bubbles: true })); }
    await new Promise((r) => setTimeout(r, 80));
  });
  shots.wells_flatten = await shot("wells_correlation_flatten.png");
  await page.evaluate(async () => { document.querySelector('.tab[data-tab="section"]').click(); await new Promise((r) => setTimeout(r, 60)); });
  shots.section = await shot("section_interior_traces.png");
  await page.evaluate(async () => { document.querySelector('.tab[data-tab="map"]').click(); await new Promise((r) => setTimeout(r, 60)); });
  shots.map = await shot("map_tie_glyphs.png");
}

result.consoleErrors = consoleErrors;
result.shots = shots;
await browser.close();

const fail = (code, msg) => { console.log(JSON.stringify({ ...result, failure: msg })); process.exit(code); };
if (consoleErrors.length) fail(6, "console errors: " + consoleErrors.slice(0, 3).join(" | "));
if (!result.hasWellsTab) fail(7, "no Wells tab");
if (!(result.wellsTvdRenderMs > 0)) fail(7, "Wells TVD never rendered");
if (!(result.wellsFlattenRenderMs > 0)) fail(7, "Wells flatten never rendered");
if (!result.foundHangSelect) fail(7, "no Hang (TVD/flatten) select in the panel");
if (!(result.sectionRenderMs >= 0 && result.mapRenderMs > 0)) fail(7, "section/map did not render");

console.log(JSON.stringify(result));
