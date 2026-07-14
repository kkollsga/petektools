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
 *   --surface-gesture      run the active point+fill navigation contract
 *   --wheel-events=N       wheel ticks in that gesture (default 16; must be >2)
 *   --pan-events=N         long-pan moves in that gesture (default 100)
 *   --gesture-p95-cap-ms=N assert hot-frame p95 below N (default 8)
 *   --gesture-max-cap-ms=N assert hot-frame max below N (default 16.7)
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
const surfaceGesture = !!flag("surface-gesture", false);
const wheelEvents = parseInt(flag("wheel-events", "16"), 10);
const panEvents = parseInt(flag("pan-events", "100"), 10);
const gestureP95CapMs = parseFloat(flag("gesture-p95-cap-ms", "8"));
const gestureMaxCapMs = parseFloat(flag("gesture-max-cap-ms", "16.7"));
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
    await sleep(20);
    // click-to-inspect (owner ruling): hover must show NOTHING — the readout
    // only appears on a still click (mousedown+mouseup within the slop).
    const hoverReadout = !document.getElementById("readout").hidden;
    const cxy = { bubbles: true, clientX: rect.left + rect.width * 0.5, clientY: rect.top + rect.height * 0.5 };
    cv.dispatchEvent(new MouseEvent("mousedown", cxy));
    cv.dispatchEvent(new MouseEvent("mouseup", cxy));
    cv.dispatchEvent(new MouseEvent("click", cxy));
    await sleep(20);
    const clickReadout = !document.getElementById("readout").hidden; // a point was hit + read out
    drag = {
      dragEvents: opts.dragEvents,
      dragFrames: window.__PETEK_MAP_FRAME_COUNT,
      dragFrameMsMedian: samples.length ? +samples[(samples.length / 2) | 0].toFixed(2) : null,
      dragFrameMsMax: samples.length ? +samples[samples.length - 1].toFixed(2) : null,
      hoverAvgMs: +hoverAvgMs.toFixed(3),
      hoverReadout,
      clickReadout,
    };
  }

  // 5) Realistic active surface navigation. The initial non-hot map render has
  // baked both the point cloud and active fill. Sixteen outward wheel ticks
  // drive well outside the historical 0.8..1.25 cache band and cross the
  // scale-derived point-radius threshold; the following 100-event out-and-back
  // pan travels >1000 px and crosses the half-viewport bake margin. Hot frames
  // must only affine-blit the retained bitmaps. One settle paint may rebuild
  // them afterward.
  let gesture = null;
  if (opts.surfaceGesture) {
    clickTab("map"); await sleep(60);
    const cv = document.getElementById("map-canvas");
    const rect = cv.getBoundingClientRect();
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const snap = () => ({ ...(window.__PETEK_MAP_PERF || {}) });
    const delta = (a, b, names) => Object.fromEntries(names.map((n) => [n, (b[n] || 0) - (a[n] || 0)]));
    const counterNames = ["pointPathBuilds", "triFillBuilds", "canvasBackingWrites",
      "legendMutations", "styleReads", "rafRequests", "hotPaints", "settlePaints",
      "fillCacheHits", "fillCacheMisses", "fillCacheEvictions", "gridPathBuilds",
      "contourPathBuilds", "outlinePathBuilds", "contactMaskBuilds",
      "overlayBitmapBuilds", "overlayHotBlits", "blockDecodeRequests",
      "blockDecodeDigests", "lazyFillDecodes"];
    const quantile = (xs, p) => xs.length ? xs[Math.min(xs.length - 1, Math.ceil(xs.length * p) - 1)] : null;
    const fillSnapshot = () => ({
      cache: window.__PETEK_FILL_CACHE_STATUS ? { ...window.__PETEK_FILL_CACHE_STATUS } : null,
      headers: [...document.querySelectorAll("#legend h3")].map((h) => h.textContent),
      scales: [...document.querySelectorAll("#legend .scale")].map((s) =>
        [...s.children].map((c) => c.textContent)),
      lod: !!window.__PETEK_LOD_ACTIVE,
    });
    const fillSelect = () => {
      const groups = [...document.querySelectorAll("#panel-body .group")];
      const group = groups.find((g) => g.querySelector("h2")?.textContent === "Fill");
      return group && group.querySelector("select");
    };
    const selectFill = async (index) => {
      const select = fillSelect();
      if (!select) throw new Error("surface gesture requires at least two selectable fills");
      select.selectedIndex = index;
      const dispatchStarted = performance.now();
      select.dispatchEvent(new Event("change", { bubbles: true }));
      const dispatchMs = performance.now() - dispatchStarted;
      const deadline = Date.now() + 3000;
      while ((window.__PETEK_MAP_BLOCK_STATUS?.activeFill ?? index) !== index && Date.now() < deadline) {
        await raf(); await sleep(10);
      }
      await raf(); await sleep(20);
      return dispatchMs;
    };

    const initialBlocks = window.__PETEK_MAP_BLOCK_STATUS ? { ...window.__PETEK_MAP_BLOCK_STATUS } : null;

    const startScale = window.__PETEK_MAP_VIEW && window.__PETEK_MAP_VIEW.scale;
    const hotBefore = snap();
    const samples = [];
    let rafTurns = 0;
    let lastPaint = hotBefore.hotPaints || 0;
    const captureRaf = async () => {
      await raf(); rafTurns++;
      const now = snap();
      if ((now.hotPaints || 0) > lastPaint && window.__PETEK_MAP_FRAME_MS != null) {
        samples.push(window.__PETEK_MAP_FRAME_MS);
        lastPaint = now.hotPaints || 0;
      }
    };

    const cx0 = rect.left + rect.width * 0.5, cy0 = rect.top + rect.height * 0.5;
    for (let i = 0; i < opts.wheelEvents; i++) {
      cv.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, clientX: cx0, clientY: cy0, deltaY: 120,
      }));
      if (i % 3 === 2) await captureRaf();
    }
    if (opts.wheelEvents % 3) await captureRaf();

    let cx = cx0, cy = cy0;
    cv.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: cx, clientY: cy }));
    for (let i = 0; i < opts.panEvents; i++) {
      cx += i < opts.panEvents / 2 ? 12 : -12;
      cy += (i % 2 ? 1 : -1);
      cv.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: cx, clientY: cy }));
      if (i % 3 === 2) await captureRaf();
    }
    if (opts.panEvents % 3) await captureRaf();
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: cx, clientY: cy }));
    await captureRaf();

    const hotAfter = snap();
    const endCamera = window.__PETEK_MAP_VIEW && { ...window.__PETEK_MAP_VIEW };
    const endScale = endCamera && endCamera.scale;
    const hotDelta = delta(hotBefore, hotAfter, counterNames);
    samples.sort((a, b) => a - b);
    const frameStats = {
      n: samples.length,
      p50: quantile(samples, 0.50),
      p95: quantile(samples, 0.95),
      max: samples.length ? samples[samples.length - 1] : null,
    };

    // The single trailing debounce owns all reconstruction and any LOD flip.
    await sleep(230); await raf(); await raf();
    const settled = snap();
    const settledCamera = window.__PETEK_MAP_VIEW && { ...window.__PETEK_MAP_VIEW };
    const settleDelta = delta(hotAfter, settled, counterNames);

    // Fill A was cached by the settle render; build B, then return to A. The
    // four-entry ring-aware LRU must reuse A with its range/ramp/LOD unchanged.
    const aBefore = fillSnapshot();
    await selectFill(1);
    const bState = fillSnapshot();
    const bBlocks = window.__PETEK_MAP_BLOCK_STATUS ? { ...window.__PETEK_MAP_BLOCK_STATUS } : null;
    const returnBefore = snap();
    const returnDispatchMs = await selectFill(0);
    const returnAfter = snap();
    const aAfter = fillSnapshot();
    const aBlocks = window.__PETEK_MAP_BLOCK_STATUS ? { ...window.__PETEK_MAP_BLOCK_STATUS } : null;
    const returnDelta = delta(returnBefore, returnAfter, counterNames);
    // Start an uncached decode, then immediately re-select the visible A. The
    // pending reply may warm cache but must not activate its stale lane.
    const cancel = fillSelect();
    cancel.selectedIndex = 4; cancel.dispatchEvent(new Event("change", { bubbles: true }));
    cancel.selectedIndex = 0; cancel.dispatchEvent(new Event("change", { bubbles: true }));
    const cancelDeadline = Date.now() + 3000;
    while ((window.__PETEK_MAP_BLOCK_STATUS?.pending ?? 0) > 0 && Date.now() < cancelDeadline) {
      await raf(); await sleep(10);
    }
    await sleep(30);
    const cancelledActive = window.__PETEK_MAP_BLOCK_STATUS?.activeFill;
    // Two changes in the same turn deliberately race worker replies. The latest
    // requested lane must win even if the earlier decode completes afterward.
    const rapid = fillSelect();
    rapid.selectedIndex = 2; rapid.dispatchEvent(new Event("change", { bubbles: true }));
    rapid.selectedIndex = 3; rapid.dispatchEvent(new Event("change", { bubbles: true }));
    const rapidDeadline = Date.now() + 3000;
    while ((window.__PETEK_MAP_BLOCK_STATUS?.activeFill ?? -1) !== 3 && Date.now() < rapidDeadline) {
      await raf(); await sleep(10);
    }
    const rapidActive = window.__PETEK_MAP_BLOCK_STATUS?.activeFill;
    const stableFill = (s) => ({
      key: s.cache && s.cache.key,
      colormap: s.cache && s.cache.colormap,
      range: s.cache && s.cache.range,
      lod: s.lod, headers: s.headers, scales: s.scales,
    });
    const stableA = JSON.stringify(stableFill(aBefore)) === JSON.stringify(stableFill(aAfter));

    gesture = {
      wheelEvents: opts.wheelEvents, panEvents: opts.panEvents,
      startScale, endScale,
      endCamera, settledCamera, returnDispatchMs,
      viewportWidth: rect.width, panPixels: opts.panEvents * 12, rafTurns,
      hotDelta, settleDelta, frameStats,
      aBefore, bState, aAfter, returnDelta, stableA,
      initialBlocks, bBlocks, aBlocks,
      rapidActive, cancelledActive,
    };
  }

  // 6) End on the requested tab (for a screenshot).
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
    ...(gesture ? { surfaceGesture: gesture } : {}),
  };
}, {
  endTab,
  dragEvents: dragEvents != null && dragEvents !== true ? parseInt(dragEvents, 10) : 0,
  surfaceGesture, wheelEvents, panEvents,
});

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
if (result.surfaceGesture) {
  const g = result.surfaceGesture;
  if (g.wheelEvents <= 2) fail(10, "surface gesture must exercise more than two wheel ticks");
  if (!(g.panPixels > g.viewportWidth)) fail(10, "surface gesture must pan more than one viewport");
  if (!(g.startScale >= 0.05 && g.endScale < 0.05))
    fail(10, `surface gesture did not cross point-radius threshold: ${g.startScale} -> ${g.endScale}`);
  const forbidden = ["pointPathBuilds", "triFillBuilds", "canvasBackingWrites",
    "legendMutations", "styleReads", "gridPathBuilds", "contourPathBuilds",
    "outlinePathBuilds", "contactMaskBuilds", "overlayBitmapBuilds"];
  const hotWork = forbidden.filter((n) => (g.hotDelta[n] || 0) !== 0);
  if (hotWork.length) fail(11, "hot gesture performed forbidden work: " + hotWork.join(", "));
  if (g.hotDelta.rafRequests !== g.hotDelta.hotPaints || g.hotDelta.hotPaints > g.rafTurns)
    fail(12, `gesture paint/rAF mismatch: ${g.hotDelta.hotPaints} paints, ${g.hotDelta.rafRequests} requests, ${g.rafTurns} turns`);
  if (!g.frameStats.n || g.frameStats.p95 >= gestureP95CapMs)
    fail(13, `gesture p95 ${g.frameStats.p95} ms >= cap ${gestureP95CapMs} ms`);
  if (g.frameStats.max >= gestureMaxCapMs)
    fail(14, `gesture max ${g.frameStats.max} ms >= cap ${gestureMaxCapMs} ms`);
  if (g.settleDelta.settlePaints !== 1 || g.settleDelta.pointPathBuilds !== 1 ||
      g.settleDelta.triFillBuilds !== 1)
    fail(15, "gesture did not perform exactly one point/fill rebuild on settle");
  if (JSON.stringify(g.endCamera) !== JSON.stringify(g.settledCamera))
    fail(15, "settle paint changed the user-adjusted map camera");
  if (g.returnDelta.pointPathBuilds !== 0 || g.returnDelta.triFillBuilds !== 0 ||
      g.returnDelta.fillCacheHits < 1 || !g.stableA)
    fail(16, "A→B→A did not reuse the stable fill cache");
  if (!(g.returnDispatchMs < 8)) fail(16, `cached A return dispatch ${g.returnDispatchMs} ms >= 8 ms`);
  if (!g.aAfter.cache || g.aAfter.cache.size > g.aAfter.cache.limit)
    fail(17, "fill bitmap cache exceeded its explicit bound");
  if (!g.initialBlocks || !(g.initialBlocks.decoded < g.initialBlocks.total) ||
      !(g.bBlocks.decoded > g.initialBlocks.decoded) ||
      g.aBlocks.decoded !== g.bBlocks.decoded)
    fail(18, "fill values were not lazy-decoded once across A→B→A");
  if (g.rapidActive !== 3) fail(19, `rapid fill selection ended on stale lane ${g.rapidActive}`);
  if (g.cancelledActive !== 0) fail(20, `pending fill selection overrode active A with ${g.cancelledActive}`);
}

console.log(JSON.stringify(result));
await browser.close?.();
