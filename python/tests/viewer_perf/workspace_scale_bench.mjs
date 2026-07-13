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
  };
});
result.consoleErrors = errors;
await browser.close();

const fail = (message) => { console.log(JSON.stringify({ ...result, failure: message })); process.exit(7); };
if (errors.length) fail("console errors");
if (result.itemCount !== 2000) fail("expected 2,000 items");
if (!result.allVisible) fail("group toggle did not update all leaves");
if (result.renderedRows > 40) fail("tree DOM was not virtualized");
if (result.treeBuildP95Ms >= 16.7) fail("tree search exceeded one frame");
if (result.groupToggleP95Ms >= 16.7) fail("group toggle exceeded one frame");
console.log(JSON.stringify(result));
