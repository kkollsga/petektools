/* Browser acceptance for first-class 2-D/3-D wells. */
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const file = process.argv[2];
if (!file) process.exit(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
const errors = [];
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", e => errors.push(String(e)));
await page.goto(pathToFileURL(file).href);
const result = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const map = document.querySelector('.tab[data-tab="map"]'); map.click(); await sleep(80);
  const mapLayout = window.__PETEK_WELL_LAYOUT || null;
  const mc = document.getElementById("map-canvas"), mr = mc.getBoundingClientRect();
  mc.dispatchEvent(new MouseEvent("mousemove", { bubbles:true, clientX:mr.left+mr.width/2, clientY:mr.top+mr.height/2 }));
  await sleep(20); const mapHover = !document.getElementById("readout").hidden;
  const tab3 = document.querySelector('.tab[data-tab="scene3d"]'); tab3.click();
  let waited=0; while (!window.__PETEK_SCENE3D_STATUS && waited<5000) { await sleep(20); waited+=20; }
  const before = window.__PETEK_SCENE3D_WELL_LABELS || null;
  const cv=document.querySelector("#scene3d-host canvas"), r=cv.getBoundingClientRect();
  cv.dispatchEvent(new PointerEvent("pointerdown", {bubbles:true,pointerId:1,button:0,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));
  cv.dispatchEvent(new PointerEvent("pointermove", {bubbles:true,pointerId:1,clientX:r.left+r.width*.6,clientY:r.top+r.height*.55}));
  cv.dispatchEvent(new PointerEvent("pointerup", {bubbles:true,pointerId:1,clientX:r.left+r.width*.6,clientY:r.top+r.height*.55}));
  await sleep(60);
  return { mapLayout, mapHover, status:window.__PETEK_SCENE3D_STATUS||null,
           labelsBefore:before, labelsAfter:window.__PETEK_SCENE3D_WELL_LABELS||null };
});
result.consoleErrors=errors; await browser.close();
console.log(JSON.stringify(result));
if (errors.length || !result.mapLayout || !result.status || result.status.state!=="ok" || result.mapHover) process.exit(6);
