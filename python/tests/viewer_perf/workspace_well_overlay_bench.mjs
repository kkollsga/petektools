/* Contextual Map well-overlay selection probe for a static workspace export. */
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const file = process.argv[2];
if (!file) process.exit(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const consoleErrors = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", (error) => consoleErrors.push(String(error)));
await page.goto(pathToFileURL(file).href);
const result = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const state = () => clone(window.__PETEK_MAP_WELL_OVERLAY_STATE || null);
  const camera = () => clone(window.__PETEK_MAP_VIEW || null);
  const fillSelect = () => {
    const group = [...document.querySelectorAll("#panel-body .group")]
      .find((entry) => entry.querySelector("h2")?.textContent === "Fill");
    return group && group.querySelector("select");
  };
  const select = async (index, context) => {
    const input = fillSelect();
    input.selectedIndex = index;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const deadline = Date.now() + 3000;
    while (window.__PETEK_MAP_WELL_OVERLAY_STATE?.contextItemId !== context && Date.now() < deadline) {
      await sleep(10);
    }
    return { overlay: state(), camera: camera(), panelText: document.getElementById("panel-body").textContent };
  };
  const deadline = Date.now() + 5000;
  while (!window.__PETEK_MAP_WELL_OVERLAY_STATE && Date.now() < deadline) await sleep(10);
  const initial = { overlay: state(), camera: camera(), panelText: document.getElementById("panel-body").textContent };
  const hitToggle = [...document.querySelectorAll("#panel-body label.toggle")]
    .find((label) => label.textContent.includes("Hit well"))?.querySelector("input");
  if (!hitToggle) throw new Error("Hit well visibility toggle not found");
  hitToggle.checked = false;
  hitToggle.dispatchEvent(new Event("change", { bubbles: true }));
  const toggleDeadline = Date.now() + 1000;
  while (window.__PETEK_MAP_WELL_OVERLAY_STATE?.wells?.[0]?.visible !== false && Date.now() < toggleDeadline) await sleep(10);
  const toggled = { overlay: state(), camera: camera() };
  hitToggle.checked = true;
  hitToggle.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(20);
  const aAttribute = await select(1, "surface:a");
  const b = await select(2, "surface:b");
  const legacy = await select(3, "surface:legacy");
  return {
    initial, toggled, aAttribute, b, legacy,
    workspace: clone(window.__PETEK_WORKSPACE_STATE),
  };
});
result.consoleErrors = consoleErrors;
await browser.close();
console.log(JSON.stringify(result));
