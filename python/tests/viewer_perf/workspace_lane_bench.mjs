/* Lazy provider-lane acceptance for live URLs and selected static exports.
 * Run: node workspace_lane_bench.mjs <url-or-html>
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const target = process.argv[2];
const expectOmitted = process.argv.includes("--expect-omitted");
if (!target) process.exit(2);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 880 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(existsSync(target) ? pathToFileURL(target).href : target);
await page.waitForFunction(() => !!window.__PETEK_WORKSPACE_STATE, null, { timeout: 5000 });

const result = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const state = () => JSON.parse(JSON.stringify(window.__PETEK_WORKSPACE_STATE));
  for (let i = 0; i < 50 && state().loading; i++) await sleep(20);
  const initial = state();
  const lane = document.querySelector(".workspace-lane-select");
  const options = lane ? Array.from(lane.options).map((o) => ({ id: o.value, label: o.textContent })) : [];

  const search = document.querySelector(".workspace-search");
  search.value = "unsupported project asset";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(120);
  const disabledRow = Array.from(document.querySelectorAll(".workspace-row")).find((row) => /legacy mystery/i.test(row.textContent));
  const disabled = {
    found: !!disabledRow,
    checkboxDisabled: !!(disabledRow && disabledRow.querySelector('input[type="checkbox"]')?.disabled),
    reason: disabledRow ? (disabledRow.querySelector(".workspace-status")?.title || disabledRow.querySelector("span")?.title || "") : "",
  };
  const clear = document.querySelector(".workspace-search");
  clear.value = ""; clear.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(120);

  const selectLane = async (id) => {
    const current = document.querySelector(".workspace-lane-select");
    current.value = id; current.dispatchEvent(new Event("change", { bubbles: true }));
    for (let i = 0; i < 50 && state().loading; i++) await sleep(20);
    await sleep(40);
    return state();
  };
  const thickness = await selectLane("thickness");
  const thicknessLegend = document.getElementById("legend").textContent;
  const depthAgain = await selectLane("depth");
  return { initial, options, disabled, thickness, thicknessLegend, depthAgain };
});
result.consoleErrors = errors;
await browser.close();

const fail = (message) => { console.log(JSON.stringify({ ...result, failure: message })); process.exit(7); };
if (errors.length) fail("console errors");
if (result.options.map((o) => o.id).join(",") !== "depth,thickness") fail("ordered lanes missing");
if (!result.disabled.found || !result.disabled.checkboxDisabled || !/unsupported/i.test(result.disabled.reason)) fail("disabled leaf missing or unexplained");
if (result.initial.activeLane["surface:top"].map !== "depth") fail("wrong initial lane");
if (expectOmitted) {
  if (result.thickness.activeLane["surface:top"].map !== "depth") fail("omitted lane did not revert");
  if (/thickness/i.test(result.thicknessLegend) || !/depth/i.test(result.thicknessLegend)) fail("omitted lane mislabeled stale data");
} else if (result.thickness.activeLane["surface:top"].map !== "thickness") fail("lane switch failed");
if (result.depthAgain.activeLane["surface:top"].map !== "depth") fail("lane cache return failed");
console.log(JSON.stringify(result));
