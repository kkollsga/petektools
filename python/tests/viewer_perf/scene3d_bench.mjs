/*
 * Playwright Scene3D (view3d) harness — drives the 3D tab a save_view export of
 * a scene3d payload renders: waits on the __PETEK_SCENE3D_STATUS build hook,
 * reads the build/first-render timings + the z-exag badge, harvests the
 * per-layer legend (headers / key rows / type icons / ramp scales / colormap
 * selector), pokes the orbit controls + wheel zoom, exercises click-to-inspect
 * (hover shows nothing; a still click picks via raycaster, shows the readout
 * and re-targets the orbit pivot with the camera unchanged; an empty click
 * dismisses, keeping the pivot — window.__PETEK_SCENE3D_PICK), moves the
 * z-exaggeration slider, flips the colormap and the theme — all under the
 * same zero-console-error watch as render_bench.mjs.
 *
 * Run:  node scene3d_bench.mjs <view.html> [flags]
 *   --build-cap-ms=N    assert status.buildMs < N (exit 3)
 *   --total-cap-ms=N    assert tab-click -> status ok wall time < N (exit 4)
 *   --tri-budget=N      inject window.PETEK_TRI_BUDGET before load (degrade path)
 *   --expect-degraded   assert the decimated-preview banner + 1:stride badge (exit 5)
 *   --screenshot=PATH   full-page PNG at the end (light theme restored)
 *
 * Prints one JSON line. Exit 0 = all assertions passed.
 */
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) { console.error("usage: node scene3d_bench.mjs <view.html> [flags]"); process.exit(2); }
const flag = (name, def) => {
  const hit = args.find((a) => a === "--" + name || a.startsWith("--" + name + "="));
  if (!hit) return def;
  const eq = hit.indexOf("=");
  return eq < 0 ? true : hit.slice(eq + 1);
};
const buildCapMs = flag("build-cap-ms", null);
const totalCapMs = flag("total-cap-ms", null);
const triBudget = flag("tri-budget", null);
const expectDegraded = !!flag("expect-degraded", false);
const screenshot = flag("screenshot", null);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

if (triBudget != null && triBudget !== true) {
  await page.addInitScript((n) => { window.PETEK_TRI_BUDGET = n; }, parseInt(triBudget, 10));
}

await page.goto(pathToFileURL(file).href);

const result = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clickTab = (name) => { const t = document.querySelector(`.tab[data-tab="${name}"]`); if (t) t.click(); };
  const badge = () => { const b = document.querySelector("#scene3d-host div"); return b ? b.textContent : null; };
  const bannerText = () => { const b = document.getElementById("banner"); return b && !b.hidden ? b.textContent : null; };
  const legend = () => ({
    headers: [...document.querySelectorAll("#legend h3")].map((h) => h.textContent),
    keys: [...document.querySelectorAll("#legend .keys .k")].map((k) => k.textContent),
    icons: document.querySelectorAll("#legend canvas.type-icon").length,
    scales: [...document.querySelectorAll("#legend .scale")].map((s) =>
      [...s.querySelectorAll("span")].map((x) => x.textContent)),
  });

  // 1) tab visibility + activation, then wait for the build status hook.
  const tabBtn = document.querySelector('.tab[data-tab="scene3d"]');
  const tabVisible = !!tabBtn && !tabBtn.hidden;
  const t0 = performance.now();
  clickTab("scene3d");
  let waited = 0;
  while (waited < 30000 && !window.__PETEK_SCENE3D_STATUS) { await sleep(16); waited += 16; }
  const totalMs = Math.round(performance.now() - t0);
  const status = window.__PETEK_SCENE3D_STATUS || null;
  const renderMs = +(window.__PETEK_RENDER_MS || 0).toFixed(2);
  const badge0 = badge();
  const degradedBanner = bannerText();
  const lightLegend = legend();

  // 2) colormap selector: read the panel's initial pick, then flip it.
  const selects = [...document.querySelectorAll("#panel-body select")];
  const cmSel = selects.find((s) => [...s.options].some((o) => o.textContent === "viridis"));
  const colormapInitial = cmSel ? cmSel.options[+cmSel.value].textContent : null;
  if (cmSel) {
    cmSel.value = String([...cmSel.options].findIndex((o) => o.textContent === "magma"));
    cmSel.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(40);
  }

  // 3) orbit + wheel on the live canvas (OrbitControls listens for pointer events).
  const cv = document.querySelector("#scene3d-host canvas");
  const rect = cv ? cv.getBoundingClientRect() : null;
  if (cv) {
    const cx = rect.left + rect.width * 0.5, cy = rect.top + rect.height * 0.5;
    cv.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: cx, clientY: cy, button: 0, isPrimary: true }));
    for (let i = 1; i <= 12; i++) {
      cv.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: cx + i * 8, clientY: cy + i * 4, isPrimary: true }));
    }
    cv.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: cx + 96, clientY: cy + 48, isPrimary: true }));
    cv.dispatchEvent(new WheelEvent("wheel", { bubbles: true, clientX: cx, clientY: cy, deltaY: -240 }));
    cv.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: cx, clientY: cy }));
    await sleep(40);
  }
  // click-to-inspect ruling: hover (and an orbit DRAG) must show NOTHING
  const hoverReadout = !document.getElementById("readout").hidden;

  // 3b) click-to-inspect + orbit re-target: a clean click (no movement between
  // pointerdown/up) at the canvas centre picks an object — the readout appears,
  // and the orbit pivot re-targets to the picked point with the camera position
  // unchanged. An empty-space click (canvas corner) dismisses the readout but
  // KEEPS the last pivot.
  const clickPoint = (x, y) => {
    cv.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: x, clientY: y, button: 0, isPrimary: true }));
    cv.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: x, clientY: y, isPrimary: true }));
  };
  let click = null;
  if (cv) {
    clickPoint(rect.left + rect.width * 0.5, rect.top + rect.height * 0.55);
    await sleep(40);
    click = {
      pick: window.__PETEK_SCENE3D_PICK || null,
      readout: !document.getElementById("readout").hidden,
    };
    clickPoint(rect.left + 3, rect.top + 3); // empty sky
    await sleep(40);
    click.dismissPick = window.__PETEK_SCENE3D_PICK || null;
    click.dismissReadout = !document.getElementById("readout").hidden;
  }

  // 4) z-exaggeration slider applies live (badge shows the new z ×N).
  const slider = document.querySelector("#panel-body input[type=range]");
  let badgeAfterExag = null;
  if (slider) {
    slider.value = "12";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(30);
    badgeAfterExag = badge();
  }

  // 5) theme flip re-renders (tokens re-read) with the scene intact; flip back.
  const themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) { themeBtn.click(); await sleep(60); }
  const darkLegend = legend();
  const statusAfter = window.__PETEK_SCENE3D_STATUS || null;
  if (themeBtn) { themeBtn.click(); await sleep(40); }

  return {
    tabVisible, totalMs, status, statusAfter, renderMs,
    badge: badge0, badgeAfterExag, degradedBanner,
    colormapInitial, hoverReadout, click,
    lightLegend, darkLegend,
  };
});

if (screenshot && screenshot !== true) {
  await page.screenshot({ path: screenshot, fullPage: false });
  result.screenshot = screenshot;
}
result.consoleErrors = consoleErrors;
await browser.close();

const fail = (code, msg) => { console.log(JSON.stringify({ ...result, failure: msg })); process.exit(code); };
if (consoleErrors.length) fail(6, "console errors: " + consoleErrors.slice(0, 3).join(" | "));
if (!result.tabVisible) fail(7, "the 3D tab is hidden for a scene3d payload");
if (!result.status || result.status.state !== "ok") fail(8, "scene never built: " + JSON.stringify(result.status));
if (result.statusAfter && result.statusAfter.state !== "ok") fail(8, "scene degraded after interaction: " + JSON.stringify(result.statusAfter));
if (buildCapMs != null && buildCapMs !== true && result.status.buildMs > parseFloat(buildCapMs))
  fail(3, `scene build ${result.status.buildMs} ms > cap ${buildCapMs} ms`);
if (totalCapMs != null && totalCapMs !== true && result.totalMs > parseFloat(totalCapMs))
  fail(4, `tab->ok wall time ${result.totalMs} ms > cap ${totalCapMs} ms`);
if (expectDegraded) {
  if (!(result.degradedBanner && /Decimated preview/i.test(result.degradedBanner)))
    fail(5, "expected a decimated-preview banner, none shown");
  if (!/1:/.test(result.badge || "")) fail(5, "expected a 1:stride badge");
}

console.log(JSON.stringify(result));
