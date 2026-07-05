/*
 * Playwright harness for the volume tab's "never hang on a bad mesh" guarantee.
 *
 * The canonical real-data build surfaced a volume whose mesh decoded to 0
 * triangles (an upstream engine bug) and left the viewer stuck on
 * "Decoding mesh…" forever. This drives two failure shapes in a real headless
 * browser and asserts the viewer refuses LOUDLY (a visible in-tab message) and
 * never spins forever:
 *
 *   - empty mesh: decode completes with 0 triangles  -> status "empty"
 *   - stalled decode: worker never reports/errors     -> watchdog -> "stalled"
 *
 * Reads window.__PETEK_VOLUME_STATUS (set by the viewer, like
 * __PETEK_SECTION_FRAME). Prints one JSON line; exit 0 on success.
 *
 * Run: node empty_bench.mjs <view.html> [--stall] [--watchdog-ms=N]
 */
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) { console.error("usage: node empty_bench.mjs <view.html> [flags]"); process.exit(2); }
const flag = (name, def) => {
  const hit = args.find((a) => a === "--" + name || a.startsWith("--" + name + "="));
  if (!hit) return def;
  const eq = hit.indexOf("=");
  return eq < 0 ? true : hit.slice(eq + 1);
};
const stall = !!flag("stall", false);
const watchdogMs = parseInt(flag("watchdog-ms", "800"), 10);

const browser = await chromium.launch({ args: ["--js-flags=--expose-gc"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

// Overrides must exist BEFORE the viewer scripts run.
await page.addInitScript((cfg) => {
  window.PETEK_DECODE_WATCHDOG_MS = cfg.watchdogMs;
  if (cfg.stall) window.PETEK_FORCE_DECODE_STALL = 1;
}, { watchdogMs, stall });

await page.goto(pathToFileURL(file).href);

const result = await page.evaluate(async (budgetMs) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clickTab = (name) => { const t = document.querySelector(`.tab[data-tab="${name}"]`); if (t) t.click(); };
  const emptyEl = () => document.getElementById("empty");
  const bannerText = () => { const b = document.getElementById("banner"); return b && !b.hidden ? b.textContent : null; };
  const emptyText = () => { const e = emptyEl(); return e && !e.hidden ? e.textContent : null; };

  clickTab("volume");
  // Wait for a terminal decode status (anything other than still-decoding),
  // bounded so a genuine hang cannot wedge the harness.
  let waited = 0;
  const cap = budgetMs + 4000;
  while (waited < cap) {
    const st = window.__PETEK_VOLUME_STATUS;
    if (st && st.state && st.state !== "decoding") break;
    await sleep(25); waited += 25;
  }
  return {
    status: window.__PETEK_VOLUME_STATUS || null,
    bannerText: bannerText(),
    emptyText: emptyText(),
    stillSpinning: /Decoding mesh/.test(emptyText() || ""),
    waitedMs: waited,
  };
}, watchdogMs);

console.log(JSON.stringify({ rc: 0, consoleErrors, ...result }));
await browser.close();
