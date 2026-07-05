/*
 * Playwright harness for the LONG-FENCE horizon-label polish (v-zone-color).
 *
 * On a ~16 km fence every interior-horizon trace ends against the right edge, so
 * the once-at-the-right labels pile into a single x-column. The slot ledger is
 * extended on two axes — a vertical slot PLUS a horizontal stagger (leader-lined)
 * and a fade for a label dragged far from its own line. renderSection exposes the
 * placed labels as window.__PETEK_SECTION_LABELS ([{name, x, y, alpha}]); this
 * harness reads them (both themes) so the pytest caller can assert no two labels
 * overprint (separated on x OR y) and that the polish engaged (a stagger / fade).
 *
 * Prints one JSON line; exit 0 (assertions in the pytest caller).
 * Run: node label_bench.mjs <view.html>
 */
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!file) { console.error("usage: node label_bench.mjs <view.html>"); process.exit(2); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(pathToFileURL(file).href);

const result = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clickTab = (name) => { const t = document.querySelector(`.tab[data-tab="${name}"]`); if (t) t.click(); };
  clickTab("section");
  await sleep(80);
  const light = window.__PETEK_SECTION_LABELS || [];
  const toggle = document.getElementById("theme-toggle");
  if (toggle) toggle.click();
  await sleep(80);
  const dark = window.__PETEK_SECTION_LABELS || [];
  const appEl = document.getElementById("app");
  const theme = (appEl && appEl.getAttribute("data-theme")) || "light";
  return { light, dark, theme };
});

console.log(JSON.stringify({ rc: 0, consoleErrors, ...result }));
await browser.close();
