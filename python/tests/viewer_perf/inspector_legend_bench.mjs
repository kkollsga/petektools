import { chromium } from "playwright";
import { pathToFileURL } from "url";

const target = process.argv[2];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const consoleErrors = [];
page.on("console", msg => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", error => consoleErrors.push(String(error)));
await page.goto(pathToFileURL(target).href);
await page.waitForSelector('.group h2:text("Layers & legend")');

const initial = await page.evaluate(() => ({
  plotLegendChildren: document.querySelector("#legend").childElementCount,
  plotLegendDisplay: getComputedStyle(document.querySelector("#legend")).display,
  ramps: document.querySelectorAll(".inspector-colormap-option").length,
  entities: document.querySelectorAll('.inspector-layer-row[data-legend-kind="entity"]').length,
  more: document.querySelector(".inspector-more")?.textContent || "",
  gridGroup: [...document.querySelectorAll(".group > h2")].some(h => h.textContent === "Grid"),
}));

await page.locator(".inspector-ramp-button").first().click();
const picker = await page.evaluate(() => ({
  visible: !document.querySelector(".inspector-colormap-picker").hidden,
  role: document.querySelector(".inspector-colormap-list").getAttribute("role"),
  selected: document.querySelectorAll('.inspector-colormap-option[aria-selected="true"]').length,
}));
await page.locator(".inspector-reverse").first().click();
const reversed = await page.evaluate(() => window.__PETEK_COLORMAP_STATE);

await page.locator(".inspector-scale").first().click();
await page.locator(".inspector-range-edit input").nth(0).fill("30");
await page.locator(".inspector-range-edit input").nth(1).fill("0");
await page.locator(".inspector-range-edit input").nth(1).press("Enter");
const committed = await page.locator(".inspector-scale").first().allTextContents();

await page.locator(".inspector-scale").first().click();
await page.locator(".inspector-range-edit input").nth(0).fill("999");
await page.locator("#title").click();
const cancelled = await page.locator(".inspector-scale").first().allTextContents();

await page.locator('.tab[data-tab="section"]').click();
await page.waitForSelector('.inspector-categorical[data-legend-kind="categorical"]');
const section = await page.evaluate(() => ({
  categorical: document.querySelectorAll('.inspector-categorical[data-legend-kind="categorical"]').length,
  ramps: document.querySelectorAll(".inspector-colormap").length,
  classes: document.querySelectorAll(".inspector-class").length,
  plotLegendChildren: document.querySelector("#legend").childElementCount,
}));

await browser.close();
const result = { initial, picker, reversed, committed, cancelled, section, consoleErrors };
if (consoleErrors.length) throw new Error(JSON.stringify(result));
if (initial.plotLegendChildren || initial.plotLegendDisplay !== "none" || initial.ramps !== 8 || initial.gridGroup) throw new Error(JSON.stringify(result));
if (!/^\+\d+ more$/.test(initial.more)) throw new Error(JSON.stringify(result));
if (!picker.visible || picker.role !== "listbox" || picker.selected !== 1) throw new Error(JSON.stringify(result));
if (!reversed.reversed || reversed.names.length !== 8) throw new Error(JSON.stringify(result));
if (!committed[0].includes("0") || !committed[0].includes("30") || cancelled[0] !== committed[0]) throw new Error(JSON.stringify(result));
if (section.categorical !== 1 || section.ramps !== 0 || section.classes !== 2 || section.plotLegendChildren) throw new Error(JSON.stringify(result));
console.log(JSON.stringify(result));
