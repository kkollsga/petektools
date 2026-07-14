/** DOM contract for the project-tree design refinement.
 * Run: node workspace_tree_design_bench.mjs <workspace-design.html>
 */
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const file = process.argv[2];
if (!file) process.exit(2);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 880 } });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(String(error)));
await page.goto(pathToFileURL(file).href);
await page.waitForFunction(() => !!window.__PETEK_WORKSPACE_STATE, null, { timeout: 5000 });
await page.waitForTimeout(120);

const before = await page.evaluate(() => {
  const row = (id) => document.querySelector(`[data-workspace-id="${id}"]`);
  const icon = (id) => row(id)?.querySelector("[data-workspace-icon]")?.dataset.workspaceIcon;
  const single = row("bore:single");
  const multi = row("well:multi");
  const lastBore = row("bore:multi-b");
  const lane = row("surface:top")?.querySelector(".workspace-lane-select");
  const unavailable = row("unknown:legacy");
  const footer = document.querySelector(".workspace-tree-footer");
  return {
    title: {
      text: document.getElementById("title").textContent,
      classed: document.getElementById("title").classList.contains("workspace-project-title"),
      suffix: document.getElementById("title").dataset.projectSuffix,
    },
    tree: {
      role: document.querySelector(".workspace-tree")?.getAttribute("role"),
      label: document.querySelector(".workspace-tree")?.getAttribute("aria-label"),
      itemsHaveLevels: Array.from(document.querySelectorAll('.workspace-row[role="treeitem"]'))
        .every((item) => Number(item.getAttribute("aria-level")) > 0),
    },
    icons: Array.from(document.querySelectorAll("[data-workspace-icon]"))
      .map((node) => node.dataset.workspaceIcon),
    roleBadges: document.querySelectorAll(".workspace-role").length,
    single: {
      parentAbsent: !row("well:single"),
      id: single?.dataset.workspaceId,
      label: single?.querySelector(".workspace-label")?.textContent,
      collapsed: single?.dataset.collapsedBore,
      icon: icon("bore:single"),
      checkboxId: single?.querySelector("input")?.dataset.workspaceItem,
    },
    multi: {
      explicit: !!multi,
      expanded: multi?.getAttribute("aria-expanded"),
      icon: icon("well:multi"),
      childA: !!row("bore:multi-a"),
      childB: !!lastBore,
      childRails: lastBore?.querySelectorAll(".workspace-rail").length,
      elbow: !!lastBore?.querySelector(".workspace-rail-last"),
    },
    states: {
      selected: row("surface:top")?.classList.contains("workspace-selected"),
      error: row("surface:top")?.classList.contains("workspace-error"),
      offline: row("surface:top")?.querySelector(".workspace-status")?.textContent,
      unavailable: unavailable?.classList.contains("workspace-unavailable"),
      reason: unavailable?.querySelector(".workspace-status")?.textContent,
    },
    meta: {
      laneWidth: lane ? lane.getBoundingClientRect().width : 0,
      laneLabel: lane?.selectedOptions[0]?.textContent,
      paint: row("surface:top")?.querySelector(".workspace-paint")?.title,
      count: row("group:assets")?.querySelector(".workspace-count")?.textContent,
      isolate: !!row("surface:top")?.querySelector(".workspace-isolate"),
    },
    footer: {
      text: footer?.textContent,
      clearDisabled: footer?.querySelector(".workspace-clear")?.disabled,
    },
    stateHooks: {
      activeLane: window.__PETEK_WORKSPACE_STATE.activeLane["surface:top"].map,
      activeColorBy: window.__PETEK_WORKSPACE_STATE.activeColorBy["surface:top"].map,
      fetches: window.__PETEK_WORKSPACE_STATE.fetches,
    },
  };
});

const loading = await page.evaluate(() => {
  const id = "point:one";
  const key = workspaceRequestKey(id, "map", null, null);
  W.loading[key] = { view: "map", lane: null, detail: null, background: false };
  buildWorkspaceNavigator();
  const loadingRow = document.querySelector(`[data-workspace-id="${id}"]`);
  const result = {
    classed: loadingRow?.classList.contains("workspace-loading"),
    spinner: !!loadingRow?.querySelector(".workspace-spinner"),
    status: loadingRow?.querySelector(".workspace-status")?.textContent,
  };
  delete W.loading[key]; buildWorkspaceNavigator();
  return result;
});

await page.locator('[data-workspace-id="surface:top"]').hover();
const hover = await page.evaluate(() => ({
  isolateOpacity: getComputedStyle(document.querySelector('[data-workspace-id="surface:top"] .workspace-isolate')).opacity,
  background: getComputedStyle(document.querySelector('[data-workspace-id="surface:top"]')).backgroundColor,
}));

await page.locator(".workspace-clear").click();
await page.waitForTimeout(30);
const cleared = await page.evaluate(() => ({
  allMapHidden: Object.values(window.__PETEK_WORKSPACE_STATE.visible)
    .every((views) => !views.map),
  fetches: window.__PETEK_WORKSPACE_STATE.fetches,
  disabled: document.querySelector(".workspace-clear")?.disabled,
}));

await browser.close();
const result = { before, loading, hover, cleared, consoleErrors: errors };
const fail = (message) => { console.log(JSON.stringify({ ...result, failure: message })); process.exit(7); };
const expectedIcons = ["surface", "points", "bore", "well", "folder", "tops", "grid", "polygon", "log", "zone", "chart", "unknown"];
if (errors.length) fail("console errors");
if (before.title.text !== "North Sea" || !before.title.classed || before.title.suffix !== ".pproj") fail("project title styling missing");
if (before.tree.role !== "tree" || before.tree.label !== "Project items" || !before.tree.itemsHaveLevels) fail("ARIA tree contract missing");
if (!expectedIcons.every((kind) => before.icons.includes(kind)) || before.roleBadges) fail("icon registry incomplete or text badge retained");
if (!before.single.parentAbsent || before.single.id !== "bore:single" || before.single.label !== "Well One"
    || before.single.collapsed !== "true" || before.single.icon !== "bore" || before.single.checkboxId !== "bore:single") fail("single-bore canonical alias failed");
if (!before.multi.explicit || before.multi.expanded !== "true" || before.multi.icon !== "well"
    || !before.multi.childA || !before.multi.childB || before.multi.childRails < 2 || !before.multi.elbow) fail("multibore hierarchy failed");
if (!before.states.selected || !before.states.error || before.states.offline !== "offline"
    || !before.states.unavailable || before.states.reason !== "Unsupported project asset") fail("row state styling failed");
if (before.meta.laneWidth < 120 || before.meta.laneLabel !== "Depth"
    || !/Thickness, not Depth/.test(before.meta.paint || "") || !before.meta.count || !before.meta.isolate) fail("meta lane contract failed");
if (!/Visibility applies to Map/.test(before.footer.text || "") || before.footer.clearDisabled) fail("view footer missing");
if (before.stateHooks.activeLane !== "depth" || before.stateHooks.activeColorBy !== "thickness" || before.stateHooks.fetches !== 0) fail("state hooks changed");
if (!loading.classed || !loading.spinner || loading.status !== "loading") fail("loading state missing");
if (hover.isolateOpacity !== "1" || hover.background === "rgba(0, 0, 0, 0)") fail("hover state missing");
if (!cleared.allMapHidden || cleared.fetches !== 0 || !cleared.disabled) fail("per-view clear changed fetch/state semantics");
console.log(JSON.stringify(result));
