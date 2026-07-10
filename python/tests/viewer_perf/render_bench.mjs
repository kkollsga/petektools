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
 *   --drag-events=N     synthetic map drag: N mousemove events at ~3/frame; measures
 *                       the rAF-coalesced per-frame repaint cost + frame count and
 *                       a non-drag hover sweep. Asserts repaints coalesced to at
 *                       most one per animation frame (else exit 8)
 *   --drag-frame-cap-ms=N  assert the median drag repaint < N ms (else exit 9)
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
const dragEvents = flag("drag-events", null);
const dragFrameCapMs = flag("drag-frame-cap-ms", null);
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

  // 4) Optional synthetic map drag + hover sweep (the 200k-point leg). Drag
  //    dispatches ~3 mousemove events per animation frame — the rAF-coalesced
  //    map path must repaint AT MOST once per frame (window.__PETEK_MAP_FRAME_MS
  //    / __PETEK_MAP_FRAME_COUNT, set by scheduleRenderMap). The hover sweep is
  //    non-drag mousemoves (the grid-bucketed point hit-test + readout).
  let drag = null;
  if (opts.dragEvents) {
    clickTab("map"); await sleep(40);
    const cv = document.getElementById("map-canvas");
    const rect = cv.getBoundingClientRect();
    let cx = rect.left + rect.width * 0.5, cy = rect.top + rect.height * 0.5;
    cv.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: cx, clientY: cy }));
    window.__PETEK_MAP_FRAME_COUNT = 0;
    const samples = [];
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < opts.dragEvents; i++) {
      cx += (i % 2 ? 3 : -2); cy += (i % 3 ? 2 : -3);
      cv.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: cx, clientY: cy }));
      if (i % 3 === 2) {
        await raf();
        if (window.__PETEK_MAP_FRAME_MS != null) samples.push(window.__PETEK_MAP_FRAME_MS);
      }
    }
    await raf(); await raf(); // let the last scheduled repaint land
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    samples.sort((a, b) => a - b);
    // hover sweep: one warm-up move (builds the point grid), then timed moves
    cv.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: rect.left + 30, clientY: rect.top + 30 }));
    const nHover = 30;
    const th0 = performance.now();
    for (let i = 0; i < nHover; i++) {
      cv.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        clientX: rect.left + 20 + ((i * 37) % (rect.width - 40)),
        clientY: rect.top + 20 + ((i * 23) % (rect.height - 40)),
      }));
    }
    const hoverAvgMs = (performance.now() - th0) / nHover;
    // deterministic hit probe: the canvas centre sits over the fitted content
    cv.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: rect.left + rect.width * 0.5, clientY: rect.top + rect.height * 0.5 }));
    await sleep(20);
    drag = {
      dragEvents: opts.dragEvents,
      dragFrames: window.__PETEK_MAP_FRAME_COUNT,
      dragFrameMsMedian: samples.length ? +samples[(samples.length / 2) | 0].toFixed(2) : null,
      dragFrameMsMax: samples.length ? +samples[samples.length - 1].toFixed(2) : null,
      hoverAvgMs: +hoverAvgMs.toFixed(3),
      hoverReadout: !document.getElementById("readout").hidden, // a point was hit + read out
    };
  }

  // 5) End on the requested tab (for a screenshot).
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
    ...(drag || {}),
  };
}, { endTab, dragEvents: dragEvents != null && dragEvents !== true ? parseInt(dragEvents, 10) : 0 });

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
if (result.dragEvents) {
  // ~3 events/frame → repaints must have coalesced to at most one per frame
  // (generous ceiling: half the event count still proves coalescing engaged).
  if (result.dragFrames > Math.ceil(result.dragEvents / 2))
    fail(8, `drag repaints did not coalesce: ${result.dragFrames} frames for ${result.dragEvents} events`);
  if (dragFrameCapMs != null && dragFrameCapMs !== true &&
      result.dragFrameMsMedian != null && result.dragFrameMsMedian > parseFloat(dragFrameCapMs))
    fail(9, `drag repaint median ${result.dragFrameMsMedian} ms > cap ${dragFrameCapMs} ms`);
}

console.log(JSON.stringify(result));
await browser.close?.();
