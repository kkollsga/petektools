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
  rampControls: document.querySelectorAll(".inspector-ramp-button").length,
  rampOptions: document.querySelectorAll(".inspector-colormap-option").length,
  entities: document.querySelectorAll('.inspector-layer-row[data-legend-kind="entity"]').length,
  more: document.querySelector(".inspector-more")?.textContent || "",
  gridGroup: [...document.querySelectorAll(".group > h2")].some(h => h.textContent === "Grid"),
  outline: [...document.querySelectorAll(".inspector-layer-label")].some(e => e.textContent === "Outline"),
  labels: [...document.querySelectorAll(".inspector-layer-label")].map(e => e.textContent),
}));

await page.locator(".inspector-ramp-button").first().click();
const picker = await page.evaluate(() => ({
  visible: !document.querySelector(".inspector-colormap-picker").hidden,
  role: document.querySelector(".inspector-colormap-list").getAttribute("role"),
  selected: document.querySelectorAll('.inspector-colormap-option[aria-selected="true"]').length,
}));
await page.locator(".inspector-reverse").first().click();
const reversed = await page.evaluate(() => window.__PETEK_COLORMAP_STATE);

await page.locator(".inspector-continuous .inspector-visible").nth(1).click();
const pointVisibility = await page.evaluate(() => window.__PETEK_COLORMAP_STATE.pointVisibility);

await page.locator(".inspector-scale").first().click();
await page.locator(".inspector-range-edit input").nth(0).fill("");
await page.locator(".inspector-range-edit input").nth(1).press("Enter");
const blankRejected = await page.locator(".inspector-scale").first().allTextContents();

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
  layers: [...document.querySelectorAll(".inspector-layer-label")].map(e => e.textContent),
}));

await page.locator(".group").filter({ hasText: "Section" }).locator("select").first().selectOption("1");
const fallbackSection = await page.evaluate(() => ({
  categorical: document.querySelectorAll('.inspector-categorical[data-legend-kind="categorical"]').length,
  continuous: document.querySelectorAll('.inspector-continuous[data-legend-kind="continuous"]').length,
  units: [...document.querySelectorAll(".inspector-units")].map(e => e.textContent),
  layers: [...document.querySelectorAll(".inspector-layer-label")].map(e => e.textContent),
}));

await browser.close();
const result = { initial, picker, reversed, pointVisibility, blankRejected, committed, cancelled, section, fallbackSection, consoleErrors };
if (consoleErrors.length) throw new Error(JSON.stringify(result));
if (initial.plotLegendChildren || initial.plotLegendDisplay !== "none" || initial.rampControls !== 3 || initial.rampOptions !== 24 || initial.gridGroup || initial.outline) throw new Error(JSON.stringify(result));
if (!initial.labels.includes("Cloud A · z") || !initial.labels.includes("Cloud B · z")
    || !initial.labels.includes("Grid lines · Structural Grid · Survey Grid")
    || !initial.labels.includes("Contours · Iso A")) throw new Error(JSON.stringify(result));
if (!/^\+\d+ more$/.test(initial.more)) throw new Error(JSON.stringify(result));
if (!picker.visible || picker.role !== "listbox" || picker.selected !== 1) throw new Error(JSON.stringify(result));
if (!reversed.reversed || reversed.names.length !== 8) throw new Error(JSON.stringify(result));
if (pointVisibility[0] !== false || pointVisibility[1] !== true) throw new Error(JSON.stringify(result));
if (!blankRejected[0].includes("0") || !blankRejected[0].includes("30")) throw new Error(JSON.stringify(result));
if (!committed[0].includes("0") || !committed[0].includes("30") || cancelled[0] !== committed[0]) throw new Error(JSON.stringify(result));
if (section.categorical !== 1 || section.ramps !== 0 || section.classes !== 2 || section.plotLegendChildren
    || section.layers.filter(label => label === "Horizons").length !== 1
    || section.layers.some(label => label === "Contacts")) throw new Error(JSON.stringify(result));
if (fallbackSection.categorical !== 0 || fallbackSection.continuous !== 1 || fallbackSection.units.length
    || fallbackSection.layers.filter(label => label === "Horizons").length !== 1) throw new Error(JSON.stringify(result));
console.log(JSON.stringify(result));
