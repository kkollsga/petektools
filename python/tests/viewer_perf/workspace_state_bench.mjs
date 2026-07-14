/* Localized lazy-view state probe for file and live workspace fixtures. */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const target = process.argv[2];
if (!target) process.exit(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
await page.goto(existsSync(target) ? pathToFileURL(target).href : target);
await page.waitForFunction(() => !!window.__PETEK_WORKSPACE_STATE, null, { timeout: 5000 });
const result = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const read = () => ({
    scene3d: window.__PETEK_SCENE3D_STATUS ? { ...window.__PETEK_SCENE3D_STATUS } : null,
    wells: window.__PETEK_WELLS_STATUS ? { ...window.__PETEK_WELLS_STATUS } : null,
    empty: document.getElementById("empty").textContent,
  });
  const first = read();
  const history = [read()];
  for (let i = 0; i < 100 && window.__PETEK_WORKSPACE_STATE.loading; i++) {
    await sleep(20); history.push(read());
  }
  await sleep(30); history.push(read());
  // Force the redraw paths that historically allowed a late scene success to
  // overwrite the workspace's terminal empty/malformed state.
  for (let i = 0; i < 8; i++) {
    const tab = document.querySelector('.tab[aria-selected="true"]');
    if (tab) tab.click();
    window.dispatchEvent(new Event("resize"));
    await sleep(15); history.push(read());
  }
  return { first, final: read(), history, workspace: { ...window.__PETEK_WORKSPACE_STATE } };
});
result.consoleErrors = errors;
await browser.close();
console.log(JSON.stringify(result));
