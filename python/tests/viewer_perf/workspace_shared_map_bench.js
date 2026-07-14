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
    else if (source[index] === "}" && --depth === 0) {
      return source.slice(start, index + 1);
    }
  }
  throw new Error("unterminated production function " + name);
}

const [helpersPath, workspacePath, mapPath] = process.argv.slice(2);
if (!helpersPath || !workspacePath || !mapPath) {
  throw new Error("usage: workspace_shared_map_bench.js HELPERS WORKSPACE MAP");
}

const helpers = fs.readFileSync(helpersPath, "utf8");
const workspace = fs.readFileSync(workspacePath, "utf8");
const mapSource = fs.readFileSync(mapPath, "utf8");

const frameA = {
  origin_x: 100, origin_y: 200, spacing_x: 10, spacing_y: 20,
  ncol: 2, nrow: 2, rotation_deg: 0, yflip: false, crs: null, units: null,
};
const frameB = {
  origin_x: 500, origin_y: 700, spacing_x: 30, spacing_y: 40,
  ncol: 2, nrow: 2, rotation_deg: 0, yflip: false, crs: null, units: null,
};
const staleLegacyFrame = {
  origin_x: -999, origin_y: -999, spacing_x: 1, spacing_y: 1,
  ncol: 2, nrow: 2, rotation_deg: 0, yflip: false, crs: null, units: null,
};
const faciesCodes = {
  "1": { label: "One", color: "#111111" },
  "3": { label: "Three", color: "#333333" },
};

function spec() {
  return {
    transport: "shared",
    attributes: [
      { id: "depth", label: "Depth", kind: "continuous", units: "m", codes: null },
      { id: "amplitude", label: "Amplitude", kind: "continuous", units: null, codes: null },
      { id: "facies", label: "Facies", kind: "categorical", units: null,
        codes: faciesCodes },
      { id: "facies_alt", label: "Facies alt", kind: "categorical", units: null,
        codes: faciesCodes },
    ],
  };
}

function sharedMap(itemId, frame, values, withLegacyFrame) {
  const result = {
    surface_grid: {
      schema_version: 1, item_id: itemId, frame,
      mask: { length: 4, a: new Uint8Array([1, 1, 1, 1]) },
      attributes: [
        {
          id: "depth", label: "Depth", kind: "continuous", units: "m", codes: null,
          values: { length: 4, a: new Float32Array([10, 11, 12, 13]) }, range: [10, 13],
        },
        {
          id: "amplitude", label: "Amplitude", kind: "continuous", units: null, codes: null,
          values: { length: 4, a: new Float32Array([13, 12, 11, 10]) }, range: [10, 13],
        },
        {
          id: "facies", label: "Facies", kind: "categorical", units: null,
          codes: faciesCodes,
          values: { length: 4, a: new Float32Array(values) }, range: null,
        },
        {
          id: "facies_alt", label: "Facies alt", kind: "categorical", units: null,
          codes: faciesCodes,
          values: { length: 4, a: new Float32Array([3, 1, 3, 1]) }, range: null,
        },
      ],
      triangle_count: 2, positive: "down",
    },
    contacts: [{ kind: "fault", crossing: { length: 4, a: new Uint8Array([1, 0, 0, 0]) } }],
  };
  if (withLegacyFrame) result.frame = staleLegacyFrame;
  return result;
}

let nextDisplayId = 1;
const displayIds = new WeakMap();
let rasterPixel = null, renderedPixel = null;
let activeAttribute = "depth", activeColorBy = "facies", visible = true;
let composeCalls = 0, loadCalls = 0;
const perfCounts = {};
function canvasContext(canvas) {
  return {
    canvas, createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    putImageData(image) { canvas.pixels = Array.from(image.data); rasterPixel = canvas.pixels.slice(); },
    drawImage(image) {
      if (image && image.pixels) canvas.pixels = image.pixels.slice();
    },
    save: () => {}, restore: () => {}, setTransform: () => {}, imageSmoothingEnabled: true,
  };
}
function fakeCanvas() {
  const canvas = { pixels: null };
  let width = 0, height = 0;
  Object.defineProperties(canvas, {
    width: { get: () => width, set: value => { width = value; canvas.pixels = null; } },
    height: { get: () => height, set: value => { height = value; canvas.pixels = null; } },
  });
  const ctx = canvasContext(canvas);
  canvas.getContext = () => ctx;
  return canvas;
}
const context = {
  console, Math, Number, Object, Array, Uint8Array, Float32Array, WeakMap, isFinite,
  App: { payload: {}, tab: "map" },
  mapView: { scale: 1, ox: 0, oy: 0, rotationDeg: 0 },
  S: {
    mapFillIdx: 1, mapLayerIdx: 0, pointLayerVis: [], contactVis: [true, true],
    wellVis: [], showGridLines: false, showContours: false, showOutline: false,
    lodActive: false, mapGridDefaultApplied: true,
  },
  W: {},
  workspaceSpec: () => spec(),
  workspaceLane: (id, view) => context.W.activeAttribute && context.W.activeAttribute[id]
    ? context.W.activeAttribute[id][view] : activeAttribute,
  workspaceColorBy: (id, view) => context.W.activeColorBy && context.W.activeColorBy[id]
    ? context.W.activeColorBy[id][view] : activeColorBy,
  workspaceItemVisible: () => visible,
  workspaceDetail: () => null,
  workspaceResource: () => null,
  composeWorkspaceView: () => { composeCalls++; },
  loadWorkspaceResource: () => { loadCalls++; },
  exposeWorkspaceState: () => {}, buildWorkspaceNavigator: () => {},
  refreshWorkspaceMapState: () => {},
  repaintWorkspaceView: () => {},
  tagLayer: value => value,
  displayId(value) {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return 0;
    if (!displayIds.has(value)) displayIds.set(value, nextDisplayId++);
    return displayIds.get(value);
  },
  document: {
    documentElement: { getAttribute: () => "light" },
    createElement: name => {
      if (name !== "canvas") throw new Error("unexpected element " + name);
      return fakeCanvas();
    },
  },
  lineSetRing: value => value,
  token: () => "#000000",
  vlAt: (values, index) => values.a ? values.a[index] : values[index],
  maskAt: (values, index) => values.a ? values.a[index] : values[index],
  _mapFillWanted: -1,
  valueDigests: () => ({}),
  blockCache: () => ({}),
  fillMap2dValues: () => {},
  decodeMapDigests: (_map, _needs, done) => done(),
  updateBlockStatus: () => {},
  renderMap: () => {},
  buildPanel: () => {},
  perfCount: name => { perfCounts[name] = (perfCounts[name] || 0) + 1; },
  colormapLUT: () => {
    const lut = new Uint8Array(256 * 3);
    for (let index = 0; index < 256; index++) {
      lut[index * 3] = index; lut[index * 3 + 1] = 255 - index; lut[index * 3 + 2] = index;
    }
    return lut;
  },
  paintColormap: () => "viridis",
  paintReversed: () => false,
  idColor: key => { throw new Error("unexpected synthesized category " + key); },
  window: {}, _fillCaches: [], _fillCacheClock: 0, FILL_CACHE_LIMIT: 4,
  PT_MARGIN: 0.2, PT_BAND_LO: 0.75, PT_BAND_HI: 1.5,
  PT_CACHE_MAX_DIM: 8192, PT_CACHE_MAX_PX: 16000000,
  _mapHotFrame: false, scheduleSettle: () => {},
  mapGeometryCacheKey: () => "geometry", fillNodesBBox: () => ({ x0: 0, y0: 0, x1: 2, y1: 2 }),
};
vm.createContext(context);
vm.runInContext(helpers, context);
[
  "virtualConcat", "cloneStamped", "workspaceSharedFill", "composeWorkspaceMapReady",
  "setWorkspaceAttribute", "setWorkspaceColorBy",
].forEach(name => vm.runInContext(extractFunction(workspace, name), context));
[
  "mapFrame", "worldExtent", "selectMapFill", "overlayKey", "drawRegularGridFill",
  "drawTriFill", "fillCacheFor", "fillPaintCacheKey", "drawMapFill", "regularGridValueAt",
].forEach(name => vm.runInContext(extractFunction(mapSource, name), context));

const entries = [
  { id: "surface:a", payload: { map: sharedMap("surface:a", frameA, [1, 1, 3, 3], true), wells: [] } },
  { id: "surface:b", payload: { map: sharedMap("surface:b", frameB, [3, 3, 1, 1], false), wells: [] } },
];
context.composeWorkspaceMapReady(entries);
const composed = context.App.payload.map;

if (composed.frame !== frameB) throw new Error("active shared fill did not select its frame");
if (composed.fills[0].__workspaceFrame !== frameA) throw new Error("shared frame did not beat stale map.frame");
if (composed.contacts[0].__workspaceFrame !== frameA || composed.contacts[1].__workspaceFrame !== frameB) {
  throw new Error("contacts did not retain their producer frames");
}
const key = context.overlayKey("over");
const extent = context.worldExtent();
const cursor = context.regularGridValueAt(composed.fills[1], [frameB.origin_x, frameB.origin_y]);
if (!key || !Object.values(extent).every(Number.isFinite)) throw new Error("shared-only render path is not finite");
if (!cursor || cursor.value !== 3) throw new Error("shared affine cursor lookup used the wrong frame");
const category = composed.fills[0].regular_grid.values.a[0];
if (category !== 1) throw new Error("categorical source node changed before paint");
const targetContext = {
  save: () => {}, restore: () => {}, setTransform: () => {},
  drawImage: image => { renderedPixel = image && image.pixels ? image.pixels.slice() : null; },
  imageSmoothingEnabled: true,
};
context.drawRegularGridFill(targetContext, composed.fills[0], 1, 0, 0);
const expectedPixels = [
  17, 17, 17, 255, 17, 17, 17, 255,
  51, 51, 51, 255, 51, 51, 51, 255,
];
if (JSON.stringify(rasterPixel) !== JSON.stringify(expectedPixels)) {
  throw new Error("categorical draw path did not paint a declared source code: " + rasterPixel);
}
function renderFill(fill) {
  renderedPixel = null;
  context.drawMapFill(targetContext, { width: 2, height: 2 }, fill);
  if (!renderedPixel) throw new Error("drawMapFill did not blit a raster bitmap");
  return renderedPixel.slice();
}

// Colour-only changes must preserve the producing geometry object and its
// affine grid object. Returning to a prior paint may reuse its bitmap; no
// geometry reconstruction or provider call is required.
const sourceA = entries[0].payload.map, geometryFill = composed.fills[0];
const gridIdentity = geometryFill.regular_grid, geometryIdentity = geometryFill.__workspaceGeometry;
activeColorBy = "depth";
const recolored = context.workspaceSharedFill("surface:a", sourceA);
if (recolored !== geometryFill || recolored.regular_grid !== gridIdentity ||
    recolored.__workspaceGeometry !== geometryIdentity || recolored.color_by !== "depth") {
  throw new Error("colour-only selection rebuilt shared geometry");
}
const depthPaintIdentity = recolored.__paintIdentity;
const depthPixels = renderFill(recolored), missesAfterDepth = perfCounts.fillCacheMisses || 0;

// Equal range/colormap is the stale-bitmap regression: only the O(1) paint and
// values identities distinguish these continuous lanes.
activeColorBy = "amplitude";
const amplitude = context.workspaceSharedFill("surface:a", sourceA);
const amplitudePixels = renderFill(amplitude);
if (amplitude !== geometryFill || amplitude.regular_grid !== gridIdentity ||
    amplitude.__paintIdentity === depthPaintIdentity ||
    JSON.stringify(amplitudePixels) === JSON.stringify(depthPixels) ||
    (perfCounts.fillCacheMisses || 0) !== missesAfterDepth + 1) {
  throw new Error("same-style continuous colour lane reused a stale bitmap");
}
activeColorBy = "depth";
const depthAgain = context.workspaceSharedFill("surface:a", sourceA);
const hitsBeforeDepthReturn = perfCounts.fillCacheHits || 0;
const depthPixelsAgain = renderFill(depthAgain);
if (depthAgain.__paintIdentity !== depthPaintIdentity ||
    JSON.stringify(depthPixelsAgain) !== JSON.stringify(depthPixels) ||
    (perfCounts.fillCacheHits || 0) !== hitsBeforeDepthReturn + 1) {
  throw new Error("returning to unchanged paint did not reuse its correct bitmap");
}
const missesBeforeClamp = perfCounts.fillCacheMisses || 0;
depthAgain.range = [11, 12];
const clampedPixels = renderFill(depthAgain);
if ((perfCounts.fillCacheMisses || 0) !== missesBeforeClamp + 1 ||
    JSON.stringify(clampedPixels) === JSON.stringify(depthPixels)) {
  throw new Error("continuous clamp change reused a stale bitmap");
}
depthAgain.range = [10, 13];
if (JSON.stringify(renderFill(depthAgain)) !== JSON.stringify(depthPixels)) {
  throw new Error("restored continuous clamp did not recover correct pixels");
}

// A shared categorical code table must not collapse distinct value lanes.
activeColorBy = "facies";
const facies = context.workspaceSharedFill("surface:a", sourceA);
const faciesPixels = renderFill(facies), sharedCodes = facies.categorical_codes;
const faciesPaintIdentity = facies.__paintIdentity;
activeColorBy = "facies_alt";
const faciesAlt = context.workspaceSharedFill("surface:a", sourceA);
const faciesAltPixels = renderFill(faciesAlt);
if (faciesAlt.categorical_codes !== sharedCodes || faciesAlt.__paintIdentity === faciesPaintIdentity ||
    JSON.stringify(faciesAltPixels) === JSON.stringify(faciesPixels)) {
  throw new Error("same-code-table categorical lane reused a stale bitmap: " + JSON.stringify({
    sameCodes: faciesAlt.categorical_codes === sharedCodes,
    sameIdentity: faciesAlt.__paintIdentity === faciesPaintIdentity,
    samePixels: JSON.stringify(faciesAltPixels) === JSON.stringify(faciesPixels),
    faciesPixels, faciesAltPixels,
  }));
}

// Replacing the shared mask is a paint change even when values/style are not.
activeColorBy = "depth";
const originalMask = sourceA.surface_grid.mask;
sourceA.surface_grid.mask = { length: 4, a: new Uint8Array([1, 0, 1, 1]) };
const maskedDepth = context.workspaceSharedFill("surface:a", sourceA);
const maskedPixels = renderFill(maskedDepth);
if (maskedDepth.__paintIdentity === depthPaintIdentity || maskedPixels[7] !== 0 ||
    JSON.stringify(maskedPixels) === JSON.stringify(depthPixels)) {
  throw new Error("shared mask replacement reused a stale bitmap");
}
sourceA.surface_grid.mask = originalMask;
const restoredDepth = context.workspaceSharedFill("surface:a", sourceA);
if (restoredDepth.__paintIdentity !== depthPaintIdentity ||
    JSON.stringify(renderFill(restoredDepth)) !== JSON.stringify(depthPixels)) {
  throw new Error("restored paint tuple did not recover its correct bitmap");
}

activeAttribute = "facies"; activeColorBy = "facies";
const changedGeometry = context.workspaceSharedFill("surface:a", sourceA);
if (changedGeometry === geometryFill || changedGeometry.__workspaceGeometry === geometryIdentity) {
  throw new Error("geometry attribute selection reused the wrong geometry identity");
}

// The navigator setters reset paint exactly once per real geometry change.
let paintWrites = 0;
const paintState = new Proxy({ map: "depth" }, {
  set(target, key, value) { paintWrites++; target[key] = value; return true; },
});
context.W = {
  activeAttribute: { "surface:a": { map: "depth" } },
  activeColorBy: { "surface:a": paintState },
  activeLane: { "surface:a": { map: "depth" } },
};
visible = true; composeCalls = 0; loadCalls = 0;
context.setWorkspaceAttribute("surface:a", "map", "facies");
context.setWorkspaceAttribute("surface:a", "map", "facies");
if (paintWrites !== 1 || paintState.map !== "facies") throw new Error("geometry change did not reset colour exactly once");
context.setWorkspaceColorBy("surface:a", "map", "depth");
if (paintWrites !== 2 || context.W.activeAttribute["surface:a"].map !== "facies") {
  throw new Error("colour-only selection changed geometry or failed to decouple");
}
context.setWorkspaceAttribute("surface:a", "map", "facies");
if (paintWrites !== 2) throw new Error("same geometry selection reset colour twice");
if (composeCalls !== 2 || loadCalls !== 0) throw new Error("shared selectors fetched instead of composing locally");

context.selectMapFill(0);
if (composed.frame !== frameA) throw new Error("fill selection did not activate its producer frame");

console.log(JSON.stringify({
  overlayKey: key, activeOrigin: composed.frame.origin_x,
  extent, cursorValue: cursor.value, category, rasterPixel,
  stableGeometry: true, paintCacheSeparated: true, categoricalCacheSeparated: true,
  maskCacheSeparated: true, clampCacheSeparated: true, fillCacheHits: perfCounts.fillCacheHits || 0,
  fillCacheMisses: perfCounts.fillCacheMisses || 0,
  paintWrites, composeCalls, loadCalls,
}));
