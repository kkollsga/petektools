/*
 * Playwright 2-D click-to-inspect harness — drives the owner-ruled interaction
 * semantics on the Map tab: HOVER shows nothing; a still CLICK on/near a point
 * reveals the readout anchored at the clicked location; clicking empty space
 * (or the same target again) dismisses it; a drag (moved press) pans and never
 * inspects. Zero-console-error watch as in render_bench.mjs.
 *
 * Run:  node inspect_bench.mjs <view.html> --blob=WX,WY --empty=WX,WY
 *   --blob   world coords of a dense point blob (a click there must hit)
 *   --empty  world coords of guaranteed-empty space (a click there dismisses)
 *
 * Prints one JSON line. Exit 0 = ran (assertions live in the Python driver).
 */
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) { console.error("usage: node inspect_bench.mjs <view.html> --blob=x,y --empty=x,y"); process.exit(2); }
const flag = (name, def) => {
  const hit = args.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : def;
};
const pair = (s) => s.split(",").map(Number);
const blob = pair(flag("blob", "0,0"));
const empty = pair(flag("empty", "0,0"));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(pathToFileURL(file).href);

const result = await page.evaluate(async (opts) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // wait for the first FULL map render (blocks decoded; __PETEK_MAP_VIEW set)
  let waited = 0;
  while (waited < 10000 && !window.__PETEK_MAP_VIEW) { await sleep(30); waited += 30; }
  await sleep(60);
  const cv = document.getElementById("map-canvas");
  const rect = cv.getBoundingClientRect();
  const view = window.__PETEK_MAP_VIEW;
  // world -> client coords (canvas px are 1:1 with CSS px — sizeCanvas)
  const w2c = (wx, wy) => [
    rect.left + (wx * view.scale + view.ox) * (rect.width / cv.width),
    rect.top + (wy * view.scale + view.oy) * (rect.height / cv.height),
  ];
  const readout = () => document.getElementById("readout");
  const state = () => ({
    hidden: readout().hidden,
    text: readout().hidden ? null : readout().textContent,
    left: parseFloat(readout().style.left || "0"),
    top: parseFloat(readout().style.top || "0"),
  });
  const move = (x, y) => cv.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
  const click = (x, y) => {
    cv.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
    cv.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
    cv.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
  };
  const [bx, by] = w2c(opts.blob[0], opts.blob[1]);
  const [ex, ey] = w2c(opts.empty[0], opts.empty[1]);
  const host = document.getElementById("view").getBoundingClientRect();

  // 1) hover over the blob shows NOTHING
  move(bx, by); move(bx + 3, by + 2);
  await sleep(30);
  const afterHover = state();

  // 2) a still click on the blob reveals the readout anchored at the click
  click(bx, by);
  await sleep(30);
  const afterClick = state();
  const anchor = { left: bx - host.left + 14, top: by - host.top + 14 };

  // 3) the readout PERSISTS through plain mouse movement
  move(bx + 60, by + 40);
  await sleep(30);
  const afterMoveAway = state();

  // 4) clicking empty space dismisses it
  click(ex, ey);
  await sleep(30);
  const afterEmptyClick = state();

  // 5) clicking the same target twice toggles it off (same-spot dismiss)
  click(bx, by);
  await sleep(20);
  const afterReClick = state();
  click(bx, by);
  await sleep(20);
  const afterSameSpot = state();

  // 6) a DRAG (moved press) pans and never inspects
  cv.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: bx, clientY: by }));
  for (let i = 1; i <= 10; i++) move(bx + i * 4, by + i * 3);
  cv.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: bx + 40, clientY: by + 30 }));
  cv.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: bx + 40, clientY: by + 30 }));
  await sleep(30);
  const afterDrag = state();

  return { afterHover, afterClick, anchor, afterMoveAway, afterEmptyClick, afterReClick, afterSameSpot, afterDrag };
}, { blob, empty });

result.consoleErrors = consoleErrors;
await browser.close();
console.log(JSON.stringify(result));
