/* Project-tree interaction budget at 2,000 leaves.
 * Run: node workspace_scale_bench.mjs <workspace-scale.html>
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
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(pathToFileURL(file).href);

const inspectBottom = async () => page.evaluate(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const tree = document.querySelector(".workspace-tree");
  tree.scrollTop = tree.scrollHeight;
  tree.dispatchEvent(new Event("scroll"));
  await sleep(40);
  const rows = Array.from(tree.querySelectorAll(".workspace-row"));
  const last = rows.find((row) => /Surface 1999/.test(row.textContent || ""));
  const treeRect = tree.getBoundingClientRect();
  const lastRect = last ? last.getBoundingClientRect() : null;
  const rowHeight = parseFloat(getComputedStyle(tree).getPropertyValue("--row-h"));
  const spacer = tree.querySelector(".workspace-tree-spacer");
  return {
    viewportHeight: tree.clientHeight,
    rowHeight,
    renderedRows: rows.length,
    boundedRows: rows.length <= Math.ceil(tree.clientHeight / rowHeight) + 16,
    uniformRows: rows.every((row) => Math.abs(row.getBoundingClientRect().height - rowHeight) < 0.1),
    spacerHeight: spacer ? spacer.getBoundingClientRect().height : 0,
    expectedSpacerHeight: 2001 * rowHeight, // one group + 2,000 leaves
    scrollTop: tree.scrollTop,
    maxScrollTop: tree.scrollHeight - tree.clientHeight,
    lastRendered: !!last,
    lastVisible: !!(lastRect && lastRect.bottom > treeRect.top && lastRect.top < treeRect.bottom),
    blankTailPx: lastRect ? treeRect.bottom - lastRect.bottom : null,
  };
});

const result = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await sleep(100);
  for (let i = 0; i < 20; i++) {
    const search = document.querySelector(".workspace-search");
    search.value = i % 2 ? `surface ${1900 + i}` : `surface ${i}`;
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(100);
  }
  const search = document.querySelector(".workspace-search");
  search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(100);
  const first = document.querySelector('.workspace-tree [role="treeitem"][tabindex="0"]');
  first.focus();
  first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  await sleep(30);
  const keyboardEnd = {
    id: document.activeElement && document.activeElement.dataset.workspaceId,
    realized: !!document.querySelector('[data-workspace-id="surface:1999"]'),
    tabStops: document.querySelectorAll('.workspace-tree [role="treeitem"][tabindex="0"]').length,
  };
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  await sleep(20);
  keyboardEnd.home = document.activeElement && document.activeElement.dataset.workspaceId;
  const rows = document.querySelectorAll(".workspace-row").length;
  const group = document.querySelector(".workspace-group input[type=checkbox]");
  group.click(); // catalog-only all-hidden -> all-visible; resource work is deferred
  const state = JSON.parse(JSON.stringify(window.__PETEK_WORKSPACE_STATE));
  const p95 = (values) => {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] || 0;
  };
  return {
    itemCount: state.itemCount,
    treeBuildP95Ms: p95(state.treeBuildMs.slice(-21)),
    groupToggleP95Ms: p95(state.groupToggleMs),
    renderedRows: rows,
    allVisible: Object.values(state.visible).every((visible) => visible.map),
    keyboardEnd,
  };
});
result.desktopBottom = await inspectBottom();
await page.setViewportSize({ width: 900, height: 420 });
await page.waitForTimeout(50);
result.narrowBottom = await inspectBottom();
result.consoleErrors = errors;
await browser.close();

const fail = (message) => { console.log(JSON.stringify({ ...result, failure: message })); process.exit(7); };
if (errors.length) fail("console errors");
if (result.itemCount !== 2000) fail("expected 2,000 items");
if (!result.allVisible) fail("group toggle did not update all leaves");
if (result.keyboardEnd.id !== "surface:1999" || !result.keyboardEnd.realized
    || result.keyboardEnd.tabStops !== 1 || result.keyboardEnd.home !== "group:surfaces") fail("virtual roving focus failed");
for (const [name, probe] of Object.entries({ desktop: result.desktopBottom, narrow: result.narrowBottom })) {
  if (probe.rowHeight !== 28) fail(`${name}: CSS row token was not 28px`);
  if (!probe.boundedRows) fail(`${name}: tree DOM exceeded measured viewport + overscan`);
  if (!probe.uniformRows) fail(`${name}: rendered rows drift from the CSS token`);
  if (Math.abs(probe.spacerHeight - probe.expectedSpacerHeight) > 0.1) fail(`${name}: spacer height drift`);
  if (Math.abs(probe.scrollTop - probe.maxScrollTop) > 1) fail(`${name}: tree did not reach max scroll`);
  if (!probe.lastRendered || !probe.lastVisible) fail(`${name}: last row was not reachable`);
  if (Math.abs(probe.blankTailPx) > 2) fail(`${name}: blank tail below final row`);
}
if (result.treeBuildP95Ms >= 16.7) fail("tree search exceeded one frame");
if (result.groupToggleP95Ms >= 16.7) fail("group toggle exceeded one frame");
console.log(JSON.stringify(result));
