/* Browser acceptance for the optional workspace shell.
 * Run: node workspace_bench.mjs <selected-workspace.html> [--screenshot=PATH]
 */
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const screenshot = (args.find((a) => a.startsWith("--screenshot=")) || "").slice(13);
if (!file) process.exit(2);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 880 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(pathToFileURL(file).href);

const result = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await sleep(120);
  const initial = JSON.parse(JSON.stringify(window.__PETEK_WORKSPACE_STATE));
  const project = document.querySelector(".workspace-tree");
  const group = document.querySelector(".workspace-group input[type=checkbox]");
  const triStateInitial = !!(group && group.indeterminate);
  const shell = {
    enabled: document.getElementById("app").classList.contains("workspace-shell"),
    treeInNavigator: !!(project && project.closest("#navigator")),
    treeInInspector: !!document.querySelector("#panel .workspace-tree"),
    visibleTabs: Array.from(document.querySelectorAll(".tab")).filter((tab) => !tab.hidden).map((tab) => tab.dataset.tab),
    statusVisible: document.getElementById("statusbar").offsetParent !== null,
  };

  // Keyboard access: help traps focus and Escape restores it; / targets search;
  // the separator is keyboard-resizable and panel toggles expose state.
  const helpButton = document.getElementById("help-toggle"); helpButton.focus();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
  await sleep(20);
  const help = {
    open: !document.getElementById("shortcut-help").hidden,
    focusedInside: document.getElementById("shortcut-help").contains(document.activeElement),
  };
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  help.closed = document.getElementById("shortcut-help").hidden;
  help.restored = document.activeElement === helpButton;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
  help.searchFocused = document.activeElement.classList.contains("workspace-search");
  const resize = document.getElementById("navigator-resizer");
  const widthBefore = document.getElementById("navigator").getBoundingClientRect().width;
  resize.focus(); resize.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  const widthAfter = document.getElementById("navigator").getBoundingClientRect().width;
  const inspectorToggle = document.getElementById("inspector-toggle"); inspectorToggle.click();
  const inspectorClosed = document.getElementById("panel").hidden; inspectorToggle.click();
  const inspectorReopened = !document.getElementById("panel").hidden;

  // Search is display-only and must retain the canonical item state.
  const search = document.querySelector(".workspace-search");
  search.focus();
  for (const ch of "cloud b") {
    const current = document.querySelector(".workspace-search");
    current.value += ch; current.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(15);
  }
  await sleep(120);
  const visibleLabels = Array.from(document.querySelectorAll(".workspace-row"))
    .filter((row) => row.offsetParent !== null).map((row) => row.textContent.trim());
  const currentSearch = document.querySelector(".workspace-search");
  currentSearch.value = ""; currentSearch.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(100);

  // Map group goes from one-of-two (indeterminate) to both selected.
  const mapGroup = document.querySelector(".workspace-group input[type=checkbox]");
  mapGroup.click(); await sleep(100);
  const afterMapGroup = JSON.parse(JSON.stringify(window.__PETEK_WORKSPACE_STATE));
  const fillGroup = Array.from(document.querySelectorAll("#panel-body .group")).find((g) => {
    const h = g.querySelector("h2"); return h && h.textContent === "Fill";
  });
  const fillSelect = fillGroup && fillGroup.querySelector("select");
  const fillOptions = fillSelect ? Array.from(fillSelect.options).map((o) => o.textContent) : [];
  if (fillSelect) {
    fillSelect.selectedIndex = 1;
    fillSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(120);
  }
  const activeFillLegend = Array.from(document.querySelectorAll("#legend h3")).map((h) => h.textContent);

  // Scene visibility is independent: the Map group change must not alter it.
  document.querySelector('.tab[data-tab="scene3d"]').click(); await sleep(160);
  const scene = JSON.parse(JSON.stringify(window.__PETEK_WORKSPACE_STATE));
  const sceneChecks = Array.from(document.querySelectorAll(".workspace-row:not(.workspace-group) input[type=checkbox]"));
  if (sceneChecks[0]) sceneChecks[0].click();
  await sleep(80);
  const afterSceneToggle = JSON.parse(JSON.stringify(window.__PETEK_WORKSPACE_STATE));

  // Returning to Map preserves its two selected leaves and performs no fetch.
  document.querySelector('.tab[data-tab="map"]').click(); await sleep(80);
  const returned = JSON.parse(JSON.stringify(window.__PETEK_WORKSPACE_STATE));
  const returnedGroup = document.querySelector(".workspace-group input[type=checkbox]");
  returnedGroup.click(); await sleep(80);
  const hiddenMap = {
    legendHidden: document.getElementById("legend").style.display === "none",
    legendEmpty: document.getElementById("legend").childNodes.length === 0,
    readoutHidden: document.getElementById("readout").hidden,
    canvasClear: (() => {
      const canvas = document.getElementById("map-canvas");
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 0) return false;
      return true;
    })(),
  };
  return { initial, triStateInitial, shell, help, resize: { widthBefore, widthAfter }, inspectorClosed, inspectorReopened,
    visibleLabels, afterMapGroup, fillOptions, activeFillLegend, scene,
    afterSceneToggle, returned, hiddenMap, hasTree: !!project };
});
await page.setViewportSize({ width: 720, height: 760 });
await page.waitForTimeout(40);
result.narrow = await page.evaluate(() => ({
  viewWidth: document.getElementById("view").getBoundingClientRect().width,
  navigatorPosition: getComputedStyle(document.getElementById("navigator")).position,
  inspectorPosition: getComputedStyle(document.getElementById("panel")).position,
  navigatorToggleVisible: document.getElementById("navigator-toggle").offsetParent !== null,
  inspectorToggleVisible: document.getElementById("inspector-toggle").offsetParent !== null,
}));
if (screenshot) await page.screenshot({ path: screenshot, fullPage: false });
result.consoleErrors = errors;
await browser.close();

const ids = Object.keys(result.initial.visible);
const fail = (message) => { console.log(JSON.stringify({ ...result, failure: message })); process.exit(7); };
if (errors.length) fail("console errors");
if (!result.hasTree || !result.triStateInitial) fail("tree/tri-state missing");
if (!result.shell.enabled || !result.shell.treeInNavigator || result.shell.treeInInspector) fail("workspace regions are not separated");
if (result.shell.visibleTabs.join(",") !== "map,scene3d") fail("tabs are not capability-derived");
if (!result.shell.statusVisible) fail("workspace status bar missing");
if (!result.help.open || !result.help.focusedInside || !result.help.closed || !result.help.restored || !result.help.searchFocused) fail("shortcut/focus contract failed");
if (!(result.resize.widthAfter > result.resize.widthBefore) || !result.inspectorClosed || !result.inspectorReopened) fail("panel controls failed");
if (result.narrow.viewWidth < 700 || result.narrow.navigatorPosition !== "absolute" || result.narrow.inspectorPosition !== "absolute"
    || !result.narrow.navigatorToggleVisible || !result.narrow.inspectorToggleVisible) fail("narrow layout is not usable");
if (!result.visibleLabels.some((label) => /cloud b/i.test(label))) fail("search did not retain Cloud B");
if (ids.length !== 2) fail("expected two items");
if (!ids.every((id) => result.afterMapGroup.visible[id].map)) fail("Map group did not select both leaves");
if (result.fillOptions.length !== 4 || !result.fillOptions.some((label) => /thickness/i.test(label))) fail("surface attribute selector missing");
if (!result.activeFillLegend.some((label) => /thickness/i.test(label))) fail("surface attribute did not activate");
if (result.scene.visible[ids[0]].scene3d !== false || result.scene.visible[ids[1]].scene3d !== true) fail("per-view visibility leaked from Map to 3-D");
if (result.afterSceneToggle.visible[ids[0]].scene3d !== true) fail("3-D leaf toggle failed");
if (!ids.every((id) => result.returned.visible[id].map)) fail("Map visibility did not survive tab changes");
if (result.returned.fetches !== 0) fail("static selected snapshot attempted a network fetch");
if (!result.hiddenMap.legendHidden || !result.hiddenMap.legendEmpty || !result.hiddenMap.readoutHidden) fail("null Map left stale inspect UI");
if (!result.hiddenMap.canvasClear) fail("null Map left stale canvas pixels");
console.log(JSON.stringify(result));
