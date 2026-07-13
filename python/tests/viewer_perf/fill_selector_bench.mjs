/*
 * Playwright harness for view2d's selectable TriFill layers. It records the
 * Fill-group options and active legend, selects an attribute on the first
 * source, then the same attribute on a second source, and records each result.
 * Prints one JSON line; assertions live in the pytest caller.
 */
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: node fill_selector_bench.mjs <view.html>");
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(pathToFileURL(file).href);
await page.waitForTimeout(250);

const snapshot = async () => page.evaluate(() => {
  const groups = [...document.querySelectorAll("#panel-body .group")];
  const fillGroup = groups.find((g) => {
    const h = g.querySelector("h2");
    return h && h.textContent === "Fill";
  });
  const select = fillGroup && fillGroup.querySelector("select");
  return {
    options: select ? [...select.options].map((o) => o.textContent) : [],
    selected: select ? select.selectedIndex : -1,
    headers: [...document.querySelectorAll("#legend h3")].map((h) => h.textContent),
    scales: [...document.querySelectorAll("#legend .scale")]
      .map((s) => [...s.children].map((c) => c.textContent)),
  };
});

const selectFill = async (index) => {
  await page.evaluate((i) => {
    const groups = [...document.querySelectorAll("#panel-body .group")];
    const fillGroup = groups.find((g) => {
      const h = g.querySelector("h2");
      return h && h.textContent === "Fill";
    });
    const select = fillGroup.querySelector("select");
    select.selectedIndex = i;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, index);
  await page.waitForTimeout(150);
  return snapshot();
};

const initial = await snapshot();
const firstAttr = await selectFill(1);
const secondSourceAttr = await selectFill(3);

console.log(JSON.stringify({ rc: 0, consoleErrors, initial, firstAttr, secondSourceAttr }));
await browser.close();
