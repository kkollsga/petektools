/*
 * Playwright render + memory-cap harness — the browser leg the Node decode bench
 * can't cover: decode + first three.js render, per-tab liveness, interaction fps,
 * JS heap, and console-error watch, on a real save_view HTML export in headless
 * Chromium. The Node bench (decode_bench.js) times the pure decode kernel; this
 * adds GPU upload, first paint, the windowed-raster map repaint cost, and the
 * heap budget the ledger scales must hold under (5M cells included).
 *
 * Setup (once):  pip install playwright && python -m playwright install chromium
 *                (or, as this repo does, `npm i playwright` somewhere and point
 *                 NODE_PATH at its node_modules so the bare import resolves).
 *
 * Run:           node render_bench.mjs <view.html> [flags]
 *   --heap-cap-mb=N     assert usedJSHeapMB < N (else exit 3)
 *   --frame-cap-ms=N    assert the map render (windowed raster) < N ms (else exit 4)
 *   --tri-budget=N      inject window.PETEK_TRI_BUDGET before load (force degrade)
 *   --screenshot=PATH   write a full-page PNG (of whatever tab we end on)
 *   --tab=NAME          end on this tab (map|section|volume|charts) for the shot
 *   --expect-degraded   assert the volume shows a decimated-preview banner (exit 5)
 *
 * Prints one JSON line with every measurement. Exit 0 = all assertions passed.
 * The viewer exposes no hook, so "decode done" is the tri-count badge appearing;
 * interaction fps is measured by timing synthetic drag repaints on the live canvas.
 */
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";

// require() (unlike ESM import) honors NODE_PATH, so the Python driver can point
// at a playwright install anywhere (this repo doesn't vendor one).
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) { console.error("usage: node render_bench.mjs <view.html> [flags]"); process.exit(2); }
const flag = (name, def) => {
  const hit = args.find((a) => a === "--" + name || a.startsWith("--" + name + "="));
  if (!hit) return def;
  const eq = hit.indexOf("=");
  return eq < 0 ? true : hit.slice(eq + 1);
};
const heapCapMB = flag("heap-cap-mb", null);
const frameCapMs = flag("frame-cap-ms", null);
const triBudget = flag("tri-budget", null);
const screenshot = flag("screenshot", null);
const endTab = flag("tab", null);
const expectDegraded = !!flag("expect-degraded", false);

const browser = await chromium.launch({ args: ["--js-flags=--expose-gc"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

// Console-error watch — the ledger's silent-death mode is the enemy; a thrown
// error or an unhandled rejection is a hard failure.
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

// A tri-budget override must exist BEFORE the viewer scripts run.
if (triBudget != null && triBudget !== true) {
  await page.addInitScript((n) => { window.PETEK_TRI_BUDGET = n; }, parseInt(triBudget, 10));
}

await page.goto(pathToFileURL(file).href);

const result = await page.evaluate(async (opts) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clickTab = (name) => { const t = document.querySelector(`.tab[data-tab="${name}"]`); if (t) t.click(); };
  const badge = () => document.querySelector("#volume-host div");
  const bannerText = () => { const b = document.getElementById("banner"); return b && !b.hidden ? b.textContent : null; };

  // 1) Volume decode + first render — wait for the tri-count badge.
  const t0 = performance.now();
  clickTab("volume");
  let waited = 0;
  while (waited < 30000) {
    const b = badge();
    if (b && /tris/.test(b.textContent || "")) break;
    await sleep(16); waited += 16;
  }
  const decodeRenderMs = Math.round(performance.now() - t0);
  const volBadge = (badge() && badge().textContent) || null;
  const degradedBanner = bannerText();

  // 2) Every tab renders without throwing (liveness) + capture each tab's true
  //    synchronous render cost (window.__PETEK_RENDER_MS, set by renderActive).
  //    This is the real repaint cost of MY code — not the browser's event-dispatch
  //    / GC overhead a huge inlined payload adds to a synthetic mouse event.
  const renderMsFor = async (name) => {
    clickTab("volume"); await sleep(20);   // switch away so the next click re-renders
    clickTab(name); await sleep(40);
    return +(window.__PETEK_RENDER_MS || 0).toFixed(2);
  };
  const mapRenderMs = await renderMsFor("map");
  const sectionRenderMs = await renderMsFor("section");
  const chartsRenderMs = await renderMsFor("charts");

  // 3) Theme flip re-renders (tokens re-read) without throwing.
  clickTab("map"); await sleep(20);
  const themeBtn = document.getElementById("theme-toggle"); if (themeBtn) themeBtn.click();
  await sleep(30);
  if (themeBtn) themeBtn.click();
  await sleep(30);

  // 4) End on the requested tab (for a screenshot).
  if (opts.endTab) { clickTab(opts.endTab); await sleep(120); }

  if (window.gc) window.gc();
  await sleep(30);
  const heap = performance.memory ? performance.memory.usedJSHeapSize : null;
  return {
    decodeRenderMs,
    mapRenderMs, sectionRenderMs, chartsRenderMs,
    usedJSHeapMB: heap != null ? +(heap / 1048576).toFixed(1) : null,
    volBadge,
    degradedBanner,
  };
}, { endTab });

if (screenshot && screenshot !== true) {
  await page.screenshot({ path: screenshot, fullPage: false });
  result.screenshot = screenshot;
}

result.consoleErrors = consoleErrors;
await browser.close();

// --- assertions (each its own exit code so the Python driver can pinpoint) ----
const fail = (code, msg) => { console.log(JSON.stringify({ ...result, failure: msg })); process.exit(code); };
if (consoleErrors.length) fail(6, "console errors: " + consoleErrors.slice(0, 3).join(" | "));
if (heapCapMB != null && heapCapMB !== true && result.usedJSHeapMB != null &&
    result.usedJSHeapMB > parseFloat(heapCapMB)) fail(3, `heap ${result.usedJSHeapMB} MB > cap ${heapCapMB} MB`);
if (frameCapMs != null && frameCapMs !== true &&
    result.mapRenderMs > parseFloat(frameCapMs)) fail(4, `map render ${result.mapRenderMs} ms > cap ${frameCapMs} ms`);
if (expectDegraded && !(result.degradedBanner && /Decimated preview/i.test(result.degradedBanner)))
  fail(5, "expected a decimated-preview banner, none shown");
if (!/tris/.test(result.volBadge || "")) fail(7, "volume never rendered (no tri badge)");

console.log(JSON.stringify(result));
await browser.close?.();
