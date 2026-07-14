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
  workspaceLane: (id, view) => context.W.activeAttribute[id][view],
  workspaceColorBy: (id, view) => context.W.activeColorBy[id][view],
  workspaceDetail: () => "full",
  workspaceResource: id => context.resourceById && context.resourceById[id] || resource, displayId,
  workspaceMapSourceFrame: () => ({}),
  exposeWorkspaceState: () => {}, buildWorkspaceNavigator: () => {}, buildPanel: () => {},
  renderActive: () => { renders++; }, renderMap: () => { mapFallbackRenders++; },
  syncWorkspaceMapModeHosts: null,
  canonicalColormap: value => value || "viridis",
  colormapStops: () => [[0, 0, 0], [255, 255, 255]],
  setTimeout: fn => { fn(); return 1; },
  _s3dRegularRequestId: 0, _s3dRegularPending: {}, _s3dSharedDerived: {},
  _s3dSharedPaintPending: {}, _s3dSharedBuildTotals: {},
  s3dBuilt: null,
  onRegularSurfaceBuilt(data) {
    const pending = context._s3dRegularPending[data.requestId];
    if (!pending) throw new Error("derived completion lost its pending request");
    delete context._s3dRegularPending[data.requestId]; pending.built._regularPending--;
    context.lastBuilt = data;
  },
  setScene3dStatus: (state, info) => { status = { state, ...info }; },
  showBanner: (title, reason) => { banner = { title, reason }; },
  workspaceViewFeedback: () => ({ state: "ready" }), hideEmpty: () => {}, showEmpty: () => {},
  attachScene3dHost: () => {}, resizeScene3d: () => {}, applyScene3dVisibility: () => {},
  restyleScene3dLines: () => {}, updateS3dBadge: () => {}, drawScene3dLegend: () => {},
  hideBanner: () => {}, frameScene3d: () => {},
};
vm.createContext(context);
[
  "workspaceMode", "workspaceMapModeItems", "workspaceMapMode", "syncWorkspaceMapModeHosts",
  "setWorkspaceMapMode", "setWorkspaceColorBy", "workspaceSharedElevationRange", "workspaceDecodedBytes",
  "workspaceSharedFill", "workspaceSharedSceneMesh", "composeWorkspaceSharedMapScene",
].forEach(name => vm.runInContext(extractFunction(workspace, name), context));
context.syncWorkspaceMapModeHosts = context.syncWorkspaceMapModeHosts;
[
  "scene3dWorkspaceView", "activeScene3dBundle", "scene3dHostElement",
  "scene3dWebGLAvailable", "sharedScene3dFallback",
  "s3dMeshPaintKey", "scene3dPaintSignature", "runSharedRegularBuild", "s3dCenterKey",
  "sharedDerivedKey", "sharedRequestSupersedes", "cancelSupersededSharedWork",
  "evictSupersededSharedDerived", "supersedeWorkspaceSharedPreview",
  "updateSharedModeLedger", "queueRegularSurface", "recolorScene3d", "renderScene3d",
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
const modeStateNeutral = JSON.stringify(retained) === stateBefore;

const built = { _detail: "full", _regularPending: 0 };
context.s3dBuilt = built;
context.queueRegularSurface(mesh, built, [0, 0, 0], false, null);
const derived = context._s3dSharedDerived[context.sharedDerivedKey(mesh, [0, 0, 0])];
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
const maskedDerived = context._s3dSharedDerived[context.sharedDerivedKey(mesh, [0, 0, 0])];
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
const previewDerived = context._s3dSharedDerived[context.sharedDerivedKey(previewMesh, [0, 0, 0])];
if (!previewDerived || previewDerived.geometryBuilds !== 1) {
  throw new Error("preview tier did not build exactly one shared geometry");
}
tierFetches++; tierDecodes++; resource.detail = "full";
context.composeWorkspaceSharedMapScene(
  [{ id: "surface:a", payload: { map: sourceMap } }], { fills: [fill] }, []
);
const fullMesh = context.App.payload.__workspaceMapScene3d.meshes[0];
const previewRetainedImmediatelyAfterFull = Object.values(context._s3dSharedDerived)
  .filter(candidate => candidate.evictionGroup === "surface:a|depth" && candidate.detail === "preview").length;
const previewPendingImmediatelyAfterFull = Object.values(context._s3dRegularPending)
  .filter(candidate => candidate.evictionGroup === "surface:a|depth" && candidate.detail === "preview").length;
if (previewRetainedImmediatelyAfterFull || previewPendingImmediatelyAfterFull ||
    previewBuilt._regularPending !== 0 ||
    context.window.__PETEK_SHARED_MODE_LEDGER.entries.some(entry => entry.detail === "preview")) {
  throw new Error("full composition did not immediately supersede preview state");
}
const fullBuilt = { _detail: "full", _regularPending: 0 };
context.s3dBuilt = fullBuilt;
context.queueRegularSurface(fullMesh, fullBuilt, [0, 0, 0], false, null);
const fullDerived = context._s3dSharedDerived[context.sharedDerivedKey(fullMesh, [0, 0, 0])];
const retainedFull = Object.keys(context._s3dSharedDerived).filter(key =>
  context._s3dSharedDerived[key].cacheGroup === "surface:a|depth|full"
);
const retainedPreview = Object.keys(context._s3dSharedDerived).filter(key =>
  context._s3dSharedDerived[key].detail === "preview"
);
const previewPending = Object.values(context._s3dRegularPending).filter(request =>
  request.detail === "preview"
);
if (tierFetches !== 2 || tierDecodes !== 2 ||
    fullDerived.geometryBuilds !== 1 || retainedFull.length !== 1 ||
    retainedPreview.length !== 0 || previewPending.length !== 0 ||
    previewBuilt._regularPending !== 0 ||
    context.window.__PETEK_SHARED_MODE_LEDGER.entries.some(entry => entry.detail === "preview")) {
  throw new Error("preview/full retained duplicate full geometry or wrong task counts: " + JSON.stringify({
    tierFetches, tierDecodes, sameFull: fullDerived === derived,
    fullGeometryBuilds: fullDerived && fullDerived.geometryBuilds,
    retainedFull: retainedFull.length, retainedPreview: retainedPreview.length,
    previewPending: previewPending.length, previewBuiltPending: previewBuilt._regularPending,
  }));
}

// Recomposition with a second visible surface changes the shared scene center.
// Every derived position must use that center, remain co-located with wells,
// and a later item-local center rebuild must not evict the other item.
const geometryValuesB = { length: 4, a: new Float32Array([20, 21, 22, 23]) };
const sourceMapB = { surface_grid: {
  triangle_count: 2, positive: "down", mask: null,
  frame: { ncol: 2, nrow: 2, origin_x: 1000, origin_y: 1200,
    spacing_x: 10, spacing_y: 20, rotation_deg: 0, yflip: true },
  attributes: [{ id: "depth", values: geometryValuesB, range: [20, 23],
    kind: "continuous", codes: null }],
} };
context.W.order.push("surface:b");
context.W.items["surface:b"] = { resources: { map: {
  transport: "shared", modes: ["2d", "3d"], attributes: [{ id: "depth" }],
} } };
context.W.visible["surface:b"] = { map: true };
context.W.activeMode["surface:b"] = { map: "2d" };
context.W.activeAttribute["surface:b"] = { map: "depth" };
context.W.activeColorBy["surface:b"] = { map: "depth" };
const fillB = context.workspaceSharedFill("surface:b", sourceMapB);
const wellAtA = { id: "well:a", trajectory: [[100, 200, -10]] };
resource.detail = "full";
context.composeWorkspaceSharedMapScene([
  { id: "surface:a", payload: { map: sourceMap } },
  { id: "surface:b", payload: { map: sourceMapB } },
], { fills: [fill, fillB] }, [wellAtA]);
const bothScene = context.App.payload.__workspaceMapScene3d;
const centerBoth = [555, 690, -16.5];
const bothBuilt = { _detail: "full", _regularPending: 0 };
context.s3dBuilt = bothBuilt;
bothScene.meshes.forEach(candidate =>
  context.queueRegularSurface(candidate, bothBuilt, centerBoth, false, null)
);
const meshA = bothScene.meshes.find(candidate => candidate.item_id === "surface:a");
const meshB = bothScene.meshes.find(candidate => candidate.item_id === "surface:b");
const derivedAAtBoth = context._s3dSharedDerived[context.sharedDerivedKey(meshA, centerBoth)];
const derivedBAtBoth = context._s3dSharedDerived[context.sharedDerivedKey(meshB, centerBoth)];
function recoveredFirst(candidate, center) {
  return [candidate.pos[0] + center[0], candidate.pos[1] + center[2], candidate.pos[2] + center[1]];
}
const recoveredA = recoveredFirst(derivedAAtBoth, centerBoth);
const recoveredB = recoveredFirst(derivedBAtBoth, centerBoth);
const renderedWell = [wellAtA.trajectory[0][0] - centerBoth[0],
  wellAtA.trajectory[0][2] - centerBoth[2], wellAtA.trajectory[0][1] - centerBoth[1]];
if (recoveredA.join(",") !== "100,-10,200" || recoveredB.join(",") !== "1000,-20,1200" ||
    renderedWell.join(",") !== Array.from(derivedAAtBoth.pos.slice(0, 3)).join(",")) {
  throw new Error("center-aware surfaces/well lost world co-location");
}
const positionBuildBeforeCenterChange = derivedAAtBoth.positionBuildOrdinal;
context.W.visible["surface:b"].map = false;
context.composeWorkspaceSharedMapScene(
  [{ id: "surface:a", payload: { map: sourceMap } }], { fills: [fill] }, [wellAtA]
);
const centerAOnly = [105, 190, -11.5];
const centerBuilt = { _detail: "full", _regularPending: 0 };
context.s3dBuilt = centerBuilt;
const centerMeshA = context.App.payload.__workspaceMapScene3d.meshes[0];
context.queueRegularSurface(centerMeshA, centerBuilt, centerAOnly, false, null);
const derivedAOnly = context._s3dSharedDerived[context.sharedDerivedKey(centerMeshA, centerAOnly)];
const retainedA = Object.values(context._s3dSharedDerived).filter(candidate =>
  candidate.evictionGroup === "surface:a|depth"
);
if (retainedA.length !== 1 || !derivedBAtBoth ||
    derivedAOnly.positionBuildOrdinal !== positionBuildBeforeCenterChange + 1 ||
    recoveredFirst(derivedAOnly, centerAOnly).join(",") !== "100,-10,200") {
  throw new Error("center change reused stale positions or evicted an unrelated item");
}

// A queued build under an obsolete center is cancelled before allocation or
// attach when a newer recomposition for the same item/geometry arrives.
const centerTasks = [];
context.setTimeout = fn => { centerTasks.push(fn); return centerTasks.length; };
const staleCenter = [0, 0, 0], currentCenter = [110, 195, -12];
const staleCenterBuilt = { _detail: "full", _regularPending: 0 };
context.s3dBuilt = staleCenterBuilt;
context.queueRegularSurface(centerMeshA, staleCenterBuilt, staleCenter, false, null);
const currentCenterBuilt = { _detail: "full", _regularPending: 0 };
context.s3dBuilt = currentCenterBuilt;
context.queueRegularSurface(centerMeshA, currentCenterBuilt, currentCenter, false, null);
while (centerTasks.length) centerTasks.shift()();
const retainedCurrentCenter = context._s3dSharedDerived[context.sharedDerivedKey(centerMeshA, currentCenter)];
if (staleCenterBuilt._regularPending !== 0 || currentCenterBuilt._regularPending !== 0 ||
    context._s3dSharedDerived[context.sharedDerivedKey(centerMeshA, staleCenter)] ||
    !retainedCurrentCenter || recoveredFirst(retainedCurrentCenter, currentCenter).join(",") !== "100,-10,200") {
  throw new Error("stale center request allocated or applied after recomposition");
}
context.setTimeout = fn => { fn(); return 1; };

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

// Two tiered visible items refine independently inside one stable scene. The
// completed item atomically replaces only its preview mesh/cache; the other
// preview stays interactive until its own full resource arrives.
context.W.visible["surface:b"].map = true;
context.resourceById = {
  "surface:a": { detail: "preview" }, "surface:b": { detail: "preview" },
};
context.composeWorkspaceSharedMapScene([
  { id: "surface:a", payload: { map: sourceMap, wells: [] } },
  { id: "surface:b", payload: { map: sourceMapB, wells: [] } },
], { fills: [fill, fillB] }, [wellAtA]);
const refinementScene = context.App.payload.__workspaceMapScene3d;
const refinementCenter = centerBoth;
const previewBuild = { _detail: "preview", _regularPending: 0 };
context.s3dBuilt = previewBuild;
refinementScene.meshes.forEach(candidate =>
  context.queueRegularSurface(candidate, previewBuild, refinementCenter, false, null)
);
const previewKeys = Object.fromEntries(refinementScene.meshes.map(candidate =>
  [candidate.item_id, candidate.__sharedLedgerKey]
));
function oldGpuEntry(candidate) {
  return { m: candidate, sourceKey: previewKeys[candidate.item_id], triangleCount: 2,
    mesh: { material: { disposed: false, dispose() { this.disposed = true; } } },
    geo: { disposed: false, dispose() { this.disposed = true; } } };
}
const oldA = oldGpuEntry(refinementScene.meshes.find(candidate => candidate.item_id === "surface:a"));
const oldB = oldGpuEntry(refinementScene.meshes.find(candidate => candidate.item_id === "surface:b"));
class RefinementBufferAttribute { constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; } }
class RefinementGeometry {
  constructor() { this.attributes = {}; this.disposed = false; }
  setAttribute(name, value) { this.attributes[name] = value; }
  setIndex(value) { this.index = value; }
  dispose() { this.disposed = true; }
}
class RefinementMaterial {
  constructor(options) { this.options = options; this.disposed = false; }
  dispose() { this.disposed = true; }
}
class RefinementMesh { constructor(geo, material) { this.geometry = geo; this.material = material; this.userData = {}; } }
let refinementRenders = 0;
const refinementCamera = { identity: "refinement-camera" };
context.S3D_MESH_NEUTRAL = 0x8f9aa5;
context.s3d = { THREE: { BufferGeometry: RefinementGeometry,
    BufferAttribute: RefinementBufferAttribute, MeshBasicMaterial: RefinementMaterial,
    Mesh: RefinementMesh, DoubleSide: "double" },
  camera: refinementCamera, framed: true,
  group: { added: [], removed: [], add(value) { this.added.push(value); },
    remove(value) { this.removed.push(value); }, scale: { set: () => {} } },
  render: () => { refinementRenders++; },
};
context.s3dBuilt = {
  _for: refinementScene, _detail: "preview", _regularPending: 0,
  _workspaceGeometryRevision: refinementScene.__workspaceGeometryRevision || 0,
  _colormapKey: context.scene3dPaintSignature(refinementScene),
  _center: { cx: refinementCenter[0], cy: refinementCenter[1], cz: refinementCenter[2] },
  meshObjs: [oldA, oldB], pointObjs: [], triangleCount: 4, _maxAttachMs: 0,
};
context.paintCompletionState = (actualRequest, expectedRequest, actualPaint, expectedPaint) =>
  actualRequest !== expectedRequest ? "stale-request" :
    actualPaint !== expectedPaint ? "stale-paint" : "current";
["regularSurfaceObject", "onRegularSurfaceBuilt",
  "reconcileSharedRegularScene"].forEach(name =>
  vm.runInContext(extractFunction(sceneSource, name), context)
);
context.resourceById["surface:a"].detail = "full";
context.composeWorkspaceSharedMapScene([
  { id: "surface:a", payload: { map: sourceMap, wells: [] } },
  { id: "surface:b", payload: { map: sourceMapB, wells: [] } },
], { fills: [fill, fillB] }, [wellAtA]);
if (context.App.payload.__workspaceMapScene3d !== refinementScene || refinementScene.detail !== "preview") {
  throw new Error("first item full replaced the mixed-detail scene");
}
context.reconcileSharedRegularScene(refinementScene);
let aPreviewRetained = Object.values(context._s3dSharedDerived).filter(candidate =>
  candidate.evictionGroup === "surface:a|depth" && candidate.detail === "preview").length;
let bPreviewRetained = Object.values(context._s3dSharedDerived).filter(candidate =>
  candidate.evictionGroup === "surface:b|depth" && candidate.detail === "preview").length;
if (!oldA.geo.disposed || oldB.geo.disposed || aPreviewRetained !== 0 || bPreviewRetained !== 1 ||
    context.s3d.camera !== refinementCamera || !context.s3d.framed || context.s3dBuilt._regularPending !== 0) {
  throw new Error("staggered first refinement reset camera or replaced/retained the wrong item");
}
context.resourceById["surface:b"].detail = "full";
context.composeWorkspaceSharedMapScene([
  { id: "surface:a", payload: { map: sourceMap, wells: [] } },
  { id: "surface:b", payload: { map: sourceMapB, wells: [] } },
], { fills: [fill, fillB] }, [wellAtA]);
context.reconcileSharedRegularScene(refinementScene);
const finalByItem = ["surface:a", "surface:b"].map(id => Object.values(context._s3dSharedDerived)
  .filter(candidate => candidate.evictionGroup === id + "|depth"));
if (refinementScene.detail !== "full" || !oldB.geo.disposed ||
    finalByItem.some(entries => entries.length !== 1 || entries[0].detail !== "full") ||
    context.s3d.camera !== refinementCamera || !context.s3d.framed) {
  throw new Error("final staggered refinement retained preview or reset scene/camera");
}
context.resourceById = null;
context.W.visible["surface:b"].map = false;

// Exercise the production color selector -> composition -> render path. The
// shared scene and GPU topology attributes survive paint-only composition. A
// slow A paint may finish into cache after cached B is selected, but cannot
// overwrite B; returning to A then cache-hits its completed colors.
const slowValues = { length: 20000, a: new Float32Array(20000) };
for (let i = 0; i < slowValues.a.length; i++) slowValues.a[i] = i / slowValues.a.length;
const fastValues = { length: 20000, a: new Float32Array(20000) };
fastValues.a.fill(0.75);
sourceMap.surface_grid.attributes.push(
  { id: "slow", values: slowValues, range: [0, 1], kind: "continuous", codes: null },
  { id: "fast", values: fastValues, range: [0, 1], kind: "continuous", codes: null }
);
context.W.items["surface:a"].resources.map.attributes.push({ id: "slow" }, { id: "fast" });
context.W.activeColorBy["surface:a"].map = "depth";
context.W.activeMode["surface:a"].map = "3d";
context.composeWorkspaceView = () => {
  const activeFill = context.workspaceSharedFill("surface:a", sourceMap);
  context.App.payload.map = { fills: [activeFill] };
  context.composeWorkspaceSharedMapScene(
    [{ id: "surface:a", payload: { map: sourceMap, wells: [] } }],
    context.App.payload.map, []
  );
};
context.composeWorkspaceView("map");
const paintScene = context.App.payload.__workspaceMapScene3d;
const paintMesh = paintScene.meshes[0], paintCenter = [110, 195, -12];
const paintBuiltSeed = { _detail: "full", _regularPending: 0 };
context.s3dBuilt = paintBuiltSeed;
context.queueRegularSurface(paintMesh, paintBuiltSeed, paintCenter, false, null);
const paintDerived = context._s3dSharedDerived[context.sharedDerivedKey(paintMesh, paintCenter)];
class BufferAttribute {
  constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; }
}
const positionAttribute = { identity: "position" }, indexAttribute = { identity: "index" };
const gpuObject = { m: paintMesh, hasValues: true, paintKey: context.s3dMeshPaintKey(paintMesh),
  geo: { attributes: { position: positionAttribute, color: null },
    index: indexAttribute, setAttribute(name, value) { this.attributes[name] = value; } } };
// Avoid self-reference in the compact literal above.
gpuObject.geo.attributes.color = new BufferAttribute(
  paintDerived.paints[context.s3dMeshPaintKey(paintMesh)], 3
);
const orbitCamera = { identity: "camera" };
let sceneRenders = 0;
context.window.THREE = true;
context.scene3dWebGLAvailable = () => true;
context.s3d = { THREE: { BufferAttribute }, camera: orbitCamera, framed: true,
  group: { scale: { set: () => {} } }, render: () => { sceneRenders++; } };
context.s3dBuilt = {
  _for: paintScene, _detail: "full", _regularPending: 0,
  _workspaceGeometryRevision: paintScene.__workspaceGeometryRevision || 0,
  _colormapKey: context.scene3dPaintSignature(paintScene),
  _center: { cx: paintCenter[0], cy: paintCenter[1], cz: paintCenter[2] },
  meshObjs: [gpuObject], pointObjs: [], _degraded: null,
};
const paintTasks = [];
context.setTimeout = fn => { paintTasks.push(fn); return paintTasks.length; };
context.setWorkspaceColorBy("surface:a", "map", "slow");
if (context.App.payload.__workspaceMapScene3d !== paintScene) {
  throw new Error("paint-only composition replaced the shared scene");
}
context.renderScene3d();
const slowKey = context.s3dMeshPaintKey(paintMesh);
if (!context._s3dSharedPaintPending[context.sharedDerivedKey(paintMesh, paintCenter) + "|paint:" + slowKey]) {
  throw new Error("slow paint did not enter the chunked production path");
}
context.setWorkspaceColorBy("surface:a", "map", "fast");
const fastKey = context.s3dMeshPaintKey(paintMesh), fastColors = new Float32Array(60000);
fastColors.fill(0.25); paintDerived.paints[fastKey] = fastColors; paintDerived.paintOrder.push(fastKey);
context.renderScene3d();
while (paintTasks.length) paintTasks.shift()();
const stalePaintSuppressed = gpuObject.paintKey === fastKey && gpuObject.geo.attributes.color.array === fastColors;
if (!stalePaintSuppressed ||
    positionAttribute !== gpuObject.geo.attributes.position || indexAttribute !== gpuObject.geo.index) {
  throw new Error("stale A paint overwrote B or paint-only render reuploaded topology");
}
const cachedSlow = paintDerived.paints[slowKey];
context.setWorkspaceColorBy("surface:a", "map", "slow");
context.renderScene3d();
if (!cachedSlow || gpuObject.paintKey !== slowKey || gpuObject.geo.attributes.color.array !== cachedSlow ||
    context.App.payload.__workspaceMapScene3d !== paintScene || context.s3d.camera !== orbitCamera ||
    context.s3d.framed !== true || positionAttribute !== gpuObject.geo.attributes.position ||
    indexAttribute !== gpuObject.geo.index || Object.keys(context._s3dSharedPaintPending).length) {
  throw new Error("return-to-A missed cache or changed scene/camera/GPU topology identity");
}
const stablePaintScene = context.App.payload.__workspaceMapScene3d === paintScene;
context.setTimeout = fn => { fn(); return 1; };

// A null mask is implicit all-valid. No hidden ncol*nrow byte array may be
// synthesized, and its zero identity stays stable across modes/detail tiers.
const masklessMap = { surface_grid: {
  frame: { ncol: 2, nrow: 2, origin_x: 100, origin_y: 200,
    spacing_x: 10, spacing_y: 20, rotation_deg: 0, yflip: true },
  positive: "down", mask: null, triangle_count: 2,
  attributes: [{ id: "depth", values: geometryValues, range: [10, 13],
    kind: "continuous", codes: null }],
} };
context.W.activeColorBy["surface:a"].map = "depth";
const masklessFill = context.workspaceSharedFill("surface:a", masklessMap);
if (!masklessFill || masklessFill.regular_grid.mask !== null ||
    Object.prototype.hasOwnProperty.call(masklessMap.surface_grid, "__workspaceAllValidMask")) {
  throw new Error("maskless grid synthesized an unreported retained mask");
}
resource.detail = "preview";
context.composeWorkspaceSharedMapScene(
  [{ id: "surface:a", payload: { map: masklessMap } }], { fills: [masklessFill] }, []
);
const masklessPreviewKey = context.App.payload.__workspaceMapScene3d.meshes[0].__sharedLedgerKey;
resource.detail = "full";
context.composeWorkspaceSharedMapScene(
  [{ id: "surface:a", payload: { map: masklessMap } }], { fills: [masklessFill] }, []
);
const masklessLedger = context.window.__PETEK_SHARED_MODE_LEDGER;
const masklessFullKey = context.App.payload.__workspaceMapScene3d.meshes[0].__sharedLedgerKey;
if (masklessLedger.source_decoded_bytes !== 16 ||
    !masklessPreviewKey.endsWith("|0") || !masklessFullKey.endsWith("|0")) {
  throw new Error("maskless retained-byte or identity accounting mismatch");
}

context.W.activeMode["surface:a"].map = "3d";
context.App.tab = "map"; context.sharedScene3dFallback("WebGL unavailable");
context.scene3dWebGLAvailable = () => false;
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
  centerPositionBuilds: retainedCurrentCenter.positionBuildOrdinal,
  retainedCenterItemA: retainedA.length, unrelatedItemBRetained: !!derivedBAtBoth,
  staleCenterAbsent: !context._s3dSharedDerived[context.sharedDerivedKey(centerMeshA, staleCenter)],
  stableScene: stablePaintScene, stalePaintSuppressed,
  staggeredFirst: { aPreview: aPreviewRetained, bPreview: bPreviewRetained },
  staggeredFinalPerItem: finalByItem.map(entries => entries.length),
  refinementRenders, paintRenders: sceneRenders,
  masklessSourceBytes: masklessLedger.source_decoded_bytes, implicitMask: true,
  legacy: true, offline: true, stateNeutral: modeStateNeutral,
}));
