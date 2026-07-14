#!/usr/bin/env node
"use strict";

const fs = require("fs");
const vm = require("vm");

function extractFunction(source, name) {
  const marker = "function " + name + "(";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("missing production function " + name);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error("unterminated production function " + name);
}

const mapPath = process.argv[2];
if (!mapPath) throw new Error("usage: map_behavior_bench.js MAP");
const source = fs.readFileSync(mapPath, "utf8");
const status = { textContent: "" };
const context = {
  console, Math, Number, Object, Array, isFinite,
  window: {},
  document: { getElementById: id => id === "map-hud-status" ? status : null },
  App: { payload: { map: null, wells: [] } },
  S: { mapFillIdx: 0, wellVis: [true] },
  _mapWellCycles: {},
  _mapWellCycleVersion: 0,
  _mapWellResolveCache: { map: null, wells: null, context: null, visibility: "", version: -1 },
};
vm.createContext(context);
[
  "activeMapContextItemId", "validOverlayTrajectory", "validOverlayIntersections",
  "overlaySingularRecord", "visibleMapContextOrder", "defaultWellPickIndex",
  "wellPickSignature", "resolveMapWellGeometry", "cycleMapWellPick",
].forEach(name => vm.runInContext(extractFunction(source, name), context));
context.renderMap = () => context.resolveMapWellGeometry();

const base = {
  id: "Alpha", item_id: "well:alpha", display_name: "Alpha well", x: 0, y: 0,
  trajectory: [[0, 0, 0], [1000, 0, -1000]],
};
const overlay = (contextItemId, statusName, intersections, endX, message) => ({
  context_item_id: contextItemId, well_item_id: "well:alpha",
  trajectory: [[0, 0, 0], [endX, 0, -endX]], intersection: intersections.length ? intersections[intersections.length - 1] : null,
  intersections, status: statusName, ...(message ? { message } : {}),
});
const record = (md, x) => ({ md, xyz: [x, 0, -x] });
const a = overlay("surface:a", "ambiguous", [record(100, 10), record(200, 20)], 20, "two A picks");
const b = overlay("surface:b", "hit", [record(300, 30)], 30);
const c = overlay("surface:c", "error", [], 40, "C failed");
const d = overlay("surface:d", "no_hit", [], 50);
const mismatched = overlay("surface:d", "hit", [record(999, 99)], 99);
context.App.payload.map = {
  fills: [{ item_id: "surface:a" }, { item_id: "surface:b" }, { item_id: "surface:c" }, { item_id: "surface:d" }],
  items: [{ id: "surface:a" }, { id: "surface:b" }, { id: "surface:c" }, { id: "surface:d" }],
  well_overlays: [a, b, c, d, mismatched],
  __wellOverlaySources: ["surface:a", "surface:b", "surface:c", "surface:d", "surface:c"],
};
context.App.payload.wells = [base];

let resolved = context.resolveMapWellGeometry();
if (context.resolveMapWellGeometry() !== resolved) throw new Error("unchanged hot-frame overlay state was reallocated");
let state = context.window.__PETEK_MAP_WELL_OVERLAY_STATE;
let well = state.wells[0];
if (resolved[0].trajectory !== a.trajectory) throw new Error("active context did not select trajectory");
if (well.picks.map(pick => pick.md).join(",") !== "100,200,300") throw new Error("all visible picks were not composed");
if (!well.selectedIntersection || well.selectedIntersection.md !== 300 || well.selectedIntersection.context_item_id !== "surface:b") {
  throw new Error("greatest-MD pick was not selected");
}
if (!state.diagnostics.some(entry => entry.code === "ambiguous" && entry.context_item_id === "surface:a") ||
    !state.diagnostics.some(entry => entry.code === "error" && entry.context_item_id === "surface:c")) {
  throw new Error("per-context diagnostics were dropped by a successful hit");
}
if (!state.diagnostics.some(entry => entry.code === "context_identity_mismatch")) {
  throw new Error("source/context mismatch was not localized");
}

const signature = context._mapWellCycles["well:alpha"].signature;
if (!context.cycleMapWellPick("well:alpha", 1)) throw new Error("pointer/keyboard cycle rejected");
state = context.window.__PETEK_MAP_WELL_OVERLAY_STATE; well = state.wells[0];
if (well.selectedIntersection.md !== 100 || context._mapWellCycles["well:alpha"].signature !== signature || !/1 of 3/.test(status.textContent)) {
  throw new Error("stable candidate cycle did not wrap or announce");
}

// Removing one visible context changes the signature and resets to the greatest
// remaining MD. Error/no-hit contexts remain visible and diagnostic.
context.App.payload.map = { ...context.App.payload.map,
  items: [{ id: "surface:a" }, { id: "surface:c" }, { id: "surface:d" }],
  fills: [{ item_id: "surface:a" }, { item_id: "surface:c" }, { item_id: "surface:d" }],
  well_overlays: [a, c, d], __wellOverlaySources: ["surface:a", "surface:c", "surface:d"],
};
context.S.mapFillIdx = 0;
context.resolveMapWellGeometry(); state = context.window.__PETEK_MAP_WELL_OVERLAY_STATE; well = state.wells[0];
if (well.selectedIntersection.md !== 200 || well.picks.length !== 2) throw new Error("visibility change did not reset to greatest remaining MD");
if (!state.diagnostics.some(entry => entry.context_item_id === "surface:c" && entry.code === "error")) {
  throw new Error("error diagnostic disappeared after visibility change");
}

// Old direct/static maps may omit MapBundle.items. Visible fill identities are
// the truthful fallback order; no synthetic context is invented.
context.App.payload.map = { ...context.App.payload.map }; delete context.App.payload.map.items;
context.resolveMapWellGeometry(); state = context.window.__PETEK_MAP_WELL_OVERLAY_STATE;
if (state.wells[0].picks.length !== 2) throw new Error("item-less direct map lost visible picks");
const afterVisibility = state.wells[0].selectedIntersection.md;

// A duplicate active identity invalidates both records and must not leave the
// first trajectory/picks secretly selectable.
context.App.payload.map = { ...context.App.payload.map,
  items: [{ id: "surface:a" }], fills: [{ item_id: "surface:a" }],
  well_overlays: [a, a], __wellOverlaySources: ["surface:a", "surface:a"],
};
context.resolveMapWellGeometry(); state = context.window.__PETEK_MAP_WELL_OVERLAY_STATE;
if (state.wells[0].source !== "base" || state.wells[0].picks.length !== 0 ||
    !state.diagnostics.some(entry => entry.code === "duplicate_identity")) {
  throw new Error("duplicate active overlay remained selectable");
}

const falseNoHit = { ...d, intersection: record(500, 50) };
context.App.payload.map = { ...context.App.payload.map,
  well_overlays: [falseNoHit], __wellOverlaySources: ["surface:d"],
  items: [{ id: "surface:d" }], fills: [{ item_id: "surface:d" }],
};
context.resolveMapWellGeometry(); state = context.window.__PETEK_MAP_WELL_OVERLAY_STATE;
if (state.wells[0].picks.length || !state.diagnostics.some(entry => entry.code === "malformed_intersection")) {
  throw new Error("no-hit overlay exposed an incompatible singular pick");
}

console.log(JSON.stringify({
  initialMds: [100, 200, 300], selected: 300, cycled: 100,
  afterVisibility,
  diagnostics: state.diagnostics.map(entry => entry.code), status: status.textContent,
}));
