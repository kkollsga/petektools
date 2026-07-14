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

const [workspacePath, scenePath, decodePath, htmlPath] = process.argv.slice(2);
if (!workspacePath || !scenePath || !decodePath || !htmlPath) {
  throw new Error("usage: workspace_dual_mode_bench.js WORKSPACE SCENE DECODE HTML");
}
const workspace = fs.readFileSync(workspacePath, "utf8");
const sceneSource = fs.readFileSync(scenePath, "utf8");
const html = fs.readFileSync(htmlPath, "utf8");
const decode = require(decodePath);

let nextId = 1;
const ids = new WeakMap();
function displayId(value) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return 0;
  if (!ids.has(value)) ids.set(value, nextId++);
  return ids.get(value);
}
function button(mode) {
  return { dataset: { mapMode: mode }, attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
}
const modeButtons = [button("2d"), button("3d")];
const nodes = {
  "map-canvas": { hidden: false }, "map-scene3d-host": { hidden: true },
  "map-hud": { hidden: false }, "map-marker-controls": { hidden: false },
  "map-mode-control": { hidden: false, querySelectorAll: () => modeButtons },
};

const geometryValues = { length: 4, a: new Float32Array([10, 11, 12, 13]) };
const paintValues = { length: 4, a: new Float32Array([10, 11, 12, 13]) };
const mask = { length: 4, a: new Uint8Array([1, 1, 1, 1]) };
const paintIdentity = {};
const fill = {
  item_id: "surface:a", name: "depth", display_name: "Top",
  geometry_attribute: "depth", __workspaceGeometry: geometryValues,
  __workspaceGeometryRange: [10, 13], __workspacePositive: "down",
  __paintIdentity: paintIdentity, range: [10, 13], colormap: "viridis",
  colormap_reversed: false, categorical: false, categorical_codes: null,
  regular_grid: {
    dimensions: [2, 2], origin: [100, 200], step_i: [10, 0], step_j: [0, -20],
    values: paintValues, mask,
  },
};
const sourceMap = {
  surface_grid: {
    triangle_count: 2, positive: "down", mask,
    attributes: [{ id: "depth", values: geometryValues }, { id: "paint", values: paintValues }],
  },
};
const resource = { detail: "full" };
let renders = 0, mapFallbackRenders = 0, status = null, banner = null;
const retained = {
  visibility: { "surface:a": { map: true } }, attribute: "depth", colorBy: "depth",
  clamp: fill.range, extent: { x0: 100, y0: 160, x1: 120, y1: 200 },
  mapRotation: 37, sceneAzimuth: 0.75, wellCycle: { signature: "a:0:100", index: 0 },
};
const context = {
  console, Math, Number, Object, Array, ArrayBuffer, Float32Array, Uint32Array, Uint8Array,
  WeakMap, isFinite, performance: { now: () => 0 },
  App: { mode: "file", tab: "map", payload: { map: { fills: [fill] }, wells: [] } },
  S: { colormap: "viridis", colormapReversed: false },
  W: {
    order: ["surface:a"], items: { "surface:a": { resources: { map: {
      transport: "shared", modes: ["2d", "3d"], attributes: [{ id: "depth" }],
    } } } },
    visible: retained.visibility, activeMode: { "surface:a": { map: "2d" } },
    activeAttribute: { "surface:a": { map: "depth" } },
    activeColorBy: { "surface:a": { map: "depth" } },
    modeSwitches: 0, fetches: 1, sharedDecodes: 1,
  },
  window: { PETEK_DECODE: decode }, document: {
    getElementById: id => nodes[id] || null,
    createElement: () => ({ getContext: () => null }),
  },
  workspaceSpec: (id, view) => context.W.items[id].resources[view],
  workspaceItemVisible: (id, view) => !!context.W.visible[id][view],
  workspaceLane: () => "depth", workspaceDetail: () => "full",
  workspaceResource: () => resource, displayId,
  exposeWorkspaceState: () => {}, buildWorkspaceNavigator: () => {}, buildPanel: () => {},
  renderActive: () => { renders++; }, renderMap: () => { mapFallbackRenders++; },
  syncWorkspaceMapModeHosts: null,
  canonicalColormap: value => value || "viridis",
  colormapStops: () => [[0, 0, 0], [255, 255, 255]],
  setTimeout: fn => { fn(); return 1; },
  _s3dRegularRequestId: 0, _s3dRegularPending: {}, _s3dSharedDerived: {},
  s3dBuilt: null,
  onRegularSurfaceBuilt(data) {
    const pending = context._s3dRegularPending[data.requestId];
    if (!pending) throw new Error("derived completion lost its pending request");
    delete context._s3dRegularPending[data.requestId]; pending.built._regularPending--;
    context.lastBuilt = data;
  },
  setScene3dStatus: (state, info) => { status = { state, ...info }; },
  showBanner: (title, reason) => { banner = { title, reason }; },
};
vm.createContext(context);
[
  "workspaceMode", "workspaceMapModeItems", "workspaceMapMode", "syncWorkspaceMapModeHosts",
  "setWorkspaceMapMode", "workspaceSharedElevationRange", "workspaceDecodedBytes",
  "workspaceSharedSceneMesh", "composeWorkspaceSharedMapScene",
].forEach(name => vm.runInContext(extractFunction(workspace, name), context));
context.syncWorkspaceMapModeHosts = context.syncWorkspaceMapModeHosts;
[
  "scene3dWorkspaceView", "activeScene3dBundle", "scene3dWebGLAvailable", "sharedScene3dFallback",
  "s3dMeshPaintKey", "scene3dPaintSignature", "runSharedRegularBuild",
  "updateSharedModeLedger", "queueRegularSurface",
].forEach(name => vm.runInContext(extractFunction(sceneSource, name), context));

context.composeWorkspaceSharedMapScene(
  [{ id: "surface:a", payload: { map: sourceMap } }], { fills: [fill] }, []
);
const sharedScene = context.App.payload.__workspaceMapScene3d;
const mesh = sharedScene && sharedScene.meshes[0];
const ledgerBefore = context.window.__PETEK_SHARED_MODE_LEDGER;
if (!mesh || mesh.regular_surface.elevations !== geometryValues ||
    mesh.regular_surface.values !== paintValues || mesh.regular_surface.mask !== mask) {
  throw new Error("shared descriptor copied or lost decoded surface blocks");
}
if (ledgerBefore.fetches !== 1 || ledgerBefore.decodes !== 1 ||
    ledgerBefore.geometry_identities !== 1 || ledgerBefore.descriptor_copy_bytes !== 0 ||
    ledgerBefore.source_transfer_bytes !== 0 || ledgerBefore.derived_transfer_bytes !== 0 ||
    ledgerBefore.source_decoded_bytes !== 36) {
  throw new Error("initial shared memory ledger is not truthful: " + JSON.stringify(ledgerBefore));
}

const stateBefore = JSON.stringify(retained);
for (let iteration = 0; iteration < 3; iteration++) {
  context.setWorkspaceMapMode("3d"); context.setWorkspaceMapMode("2d");
}
if (context.W.fetches !== 1 || context.W.sharedDecodes !== 1 || renders !== 6 ||
    JSON.stringify(retained) !== stateBefore || context.W.activeMode["surface:a"].map !== "2d") {
  throw new Error("mode roundtrip changed resources or retained state");
}

const built = { _detail: "full", _regularPending: 0 };
context.s3dBuilt = built;
context.queueRegularSurface(mesh, built, [0, 0, 0], false, null);
const derived = context._s3dSharedDerived[mesh.__sharedLedgerKey];
const ledgerAfter = context.window.__PETEK_SHARED_MODE_LEDGER;
if (!derived || derived.geometryBuilds !== 1 || derived.paintBuilds !== 1 ||
    ledgerAfter.entries[0].derived_position_bytes !== 48 ||
    ledgerAfter.entries[0].derived_topology_bytes !== 24 ||
    ledgerAfter.entries[0].derived_paint_bytes !== 48 ||
    ledgerAfter.retained_bytes !== 156 || ledgerAfter.geometry_builds !== 1 ||
    ledgerAfter.paint_builds !== 1 || context.lastBuilt.triangleCount !== 2) {
  throw new Error("derived allocation ledger mismatch: " + JSON.stringify(ledgerAfter));
}
const initialAllocation = {
  positionBytes: ledgerAfter.entries[0].derived_position_bytes,
  topologyBytes: ledgerAfter.entries[0].derived_topology_bytes,
  paintBytes: ledgerAfter.entries[0].derived_paint_bytes,
  retainedBytes: ledgerAfter.retained_bytes,
};
const firstPosition = derived.pos, firstIndex = derived.index;
if (Array.from(firstPosition.filter((_, i) => i % 3 === 1)).join(",") !== "-10,-11,-12,-13") {
  throw new Error("positive-down geometry did not become negative elevation");
}
context.queueRegularSurface(mesh, built, [0, 0, 0], false, null);
if (derived.geometryBuilds !== 1 || derived.paintBuilds !== 1 ||
    derived.pos !== firstPosition || derived.index !== firstIndex) {
  throw new Error("repeated mode render rebuilt shared geometry");
}

const categoricalValues = { length: 4, a: new Float32Array([1, 3, 1, 3]) };
mesh.regular_surface.values = categoricalValues; mesh.__sharedPaintIdentity = {};
mesh.categorical = true; mesh.categorical_codes = {
  "1": { color: "#112233" }, "3": { color: "#AABBCC" },
};
mesh.range = null;
context.queueRegularSurface(mesh, built, [0, 0, 0], false, null);
const categoricalKey = context.s3dMeshPaintKey(mesh), categorical = derived.paints[categoricalKey];
if (derived.geometryBuilds !== 1 || derived.paintBuilds !== 2 ||
    derived.pos !== firstPosition || derived.index !== firstIndex ||
    Math.abs(categorical[0] - 0x11 / 255) > 1e-6 || Math.abs(categorical[1] - 0x22 / 255) > 1e-6) {
  throw new Error("categorical paint rebuilt topology or ignored declared colors");
}

const replacementMask = { length: 4, a: new Uint8Array([1, 0, 1, 1]) };
mesh.regular_surface.mask = replacementMask;
mesh.__sharedLedgerKey = mesh.__sharedLedgerPrefix + "|" + displayId(replacementMask);
ledgerAfter.entries[0].key = mesh.__sharedLedgerKey;
context.queueRegularSurface(mesh, built, [0, 0, 0], false, null);
const maskedDerived = context._s3dSharedDerived[mesh.__sharedLedgerKey];
if (maskedDerived === derived || maskedDerived.geometryBuilds !== 1 || maskedDerived.index.length !== 0) {
  throw new Error("mask identity reused stale topology");
}

// A preview and full response are two provider/decode tasks, but each tier has
// only one shared geometry source for both camera modes. Returning to a loaded
// full tier must reuse its exact derived position/index allocation.
let tierFetches = 1, tierDecodes = 1;
resource.detail = "preview";
context.composeWorkspaceSharedMapScene(
  [{ id: "surface:a", payload: { map: sourceMap } }], { fills: [fill] }, []
);
const previewMesh = context.App.payload.__workspaceMapScene3d.meshes[0];
const previewBuilt = { _detail: "preview", _regularPending: 0 };
context.s3dBuilt = previewBuilt;
context.queueRegularSurface(previewMesh, previewBuilt, [0, 0, 0], false, null);
const previewDerived = context._s3dSharedDerived[previewMesh.__sharedLedgerKey];
if (!previewDerived || previewDerived.geometryBuilds !== 1) {
  throw new Error("preview tier did not build exactly one shared geometry");
}
tierFetches++; tierDecodes++; resource.detail = "full";
context.composeWorkspaceSharedMapScene(
  [{ id: "surface:a", payload: { map: sourceMap } }], { fills: [fill] }, []
);
const fullMesh = context.App.payload.__workspaceMapScene3d.meshes[0];
const fullBuilt = { _detail: "full", _regularPending: 0 };
context.s3dBuilt = fullBuilt;
context.queueRegularSurface(fullMesh, fullBuilt, [0, 0, 0], false, null);
const fullDerived = context._s3dSharedDerived[fullMesh.__sharedLedgerKey];
const retainedFull = Object.keys(context._s3dSharedDerived).filter(key =>
  context._s3dSharedDerived[key].cacheGroup === "surface:a|full"
);
if (tierFetches !== 2 || tierDecodes !== 2 ||
    fullDerived.geometryBuilds !== 1 || retainedFull.length !== 1) {
  throw new Error("preview/full retained duplicate full geometry or wrong task counts: " + JSON.stringify({
    tierFetches, tierDecodes, sameFull: fullDerived === derived,
    fullGeometryBuilds: fullDerived && fullDerived.geometryBuilds,
    retainedFull: retainedFull.length,
  }));
}

// Cancellation is checked at every yielded 16,384-cell chunk. A superseded
// request cannot invoke its completion callback or enter the derived cache.
const delayed = [];
context.setTimeout = fn => { delayed.push(fn); return delayed.length; };
const largeCount = 20000, largeElevations = new Float32Array(largeCount);
largeElevations.fill(10);
let currentBuild = true, cancelledBuilds = 0, completedBuilds = 0;
context.runSharedRegularBuild({
  surface: {
    dimensions: [200, 100], origin: [0, 0], step_i: [1, 0], step_j: [0, 1],
    elevations: { a: largeElevations }, mask: null, positive: "down",
  }, center: [0, 0, 0], range: null, stops: [], categories: null,
}, false, () => { completedBuilds++; }, error => { throw error; },
() => currentBuild, () => { cancelledBuilds++; });
const scheduledChunks = delayed.length;
currentBuild = false;
while (delayed.length) delayed.shift()();
if (scheduledChunks !== 1 || cancelledBuilds !== 1 || completedBuilds !== 0) {
  throw new Error("superseded chunk applied a stale result");
}
context.setTimeout = fn => { fn(); return 1; };

context.W.activeMode["surface:a"].map = "3d";
context.App.tab = "map"; context.sharedScene3dFallback("WebGL unavailable");
if (context.scene3dWebGLAvailable() !== false || !status || status.state !== "fallback" || status.rendered !== "2d" ||
    mapFallbackRenders !== 1 || nodes["map-canvas"].hidden || !nodes["map-scene3d-host"].hidden || !banner) {
  throw new Error("no-WebGL path latched an error instead of usable 2-D fallback");
}

const legacyScene = { schema_version: 1, meshes: [{ name: "legacy" }] };
context.App.payload.scene3d = legacyScene; context.App.tab = "scene3d";
if (context.scene3dWorkspaceView() !== "scene3d" || context.activeScene3dBundle() !== legacyScene) {
  throw new Error("legacy separate scene3d routing regressed");
}
if (!html.includes('id="map-mode-control"') || !html.includes('data-map-mode="2d"') ||
    !html.includes('data-map-mode="3d"')) {
  throw new Error("saved viewer shell lacks the offline mode control");
}
if (context.App.mode !== "file" || context.W.fetches !== 1 || context.W.sharedDecodes !== 1) {
  throw new Error("offline mode switch attempted provider access");
}

console.log(JSON.stringify({
  fetches: context.W.fetches, decodes: context.W.sharedDecodes,
  geometryIdentity: ledgerBefore.entries[0].geometry_identity,
  sourceBytes: ledgerBefore.source_decoded_bytes,
  positionBytes: initialAllocation.positionBytes,
  topologyBytes: initialAllocation.topologyBytes,
  paintBytes: initialAllocation.paintBytes,
  retainedBytes: initialAllocation.retainedBytes, modeSwitches: context.W.modeSwitches,
  geometryBuilds: derived.geometryBuilds, paintBuilds: derived.paintBuilds,
  categorical: true, maskSeparated: true, fallback: status.state,
  tierFetches, tierDecodes, previewGeometryBuilds: previewDerived.geometryBuilds,
  fullGeometryBuilds: fullDerived.geometryBuilds, retainedFullGeometries: retainedFull.length,
  scheduledChunks, cancelledBuilds, staleCompletions: completedBuilds,
  legacy: true, offline: true, stateNeutral: JSON.stringify(retained) === stateBefore,
}));
