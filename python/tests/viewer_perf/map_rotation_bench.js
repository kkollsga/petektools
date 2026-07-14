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

function close(a, b, tolerance = 1e-9) {
  return Math.abs(a - b) <= tolerance;
}

function assertArrayClose(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((value, index) => !close(value, expected[index]))) {
    throw new Error(label + ": " + JSON.stringify(actual) + " != " + JSON.stringify(expected));
  }
}

const [helpersPath, mapPath] = process.argv.slice(2);
if (!helpersPath || !mapPath) throw new Error("usage: map_rotation_bench.js HELPERS MAP");
const helpers = fs.readFileSync(helpersPath, "utf8");
const mapSource = fs.readFileSync(mapPath, "utf8");

const canvases = [];
function offscreenCanvas() {
  const canvas = { width: 0, height: 0, _data: null };
  const ctx = {
    createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: image => { canvas._data = Array.from(image.data); },
  };
  canvas.getContext = () => ctx;
  canvases.push(canvas);
  return canvas;
}
function targetContext() {
  return {
    matrix: null, image: null, imageSmoothingEnabled: true,
    save() {}, restore() {}, clip() {},
    setTransform(...values) { this.matrix = values; },
    drawImage(image) { this.image = image; },
  };
}

let nextDisplayId = 1;
const displayIds = new WeakMap();
const context = {
  console, Math, Number, Object, Array, Float64Array, Uint8Array, Uint8ClampedArray,
  isFinite,
  window: {},
  document: {
    documentElement: { getAttribute: () => "light" },
    getElementById: () => context.canvas,
    createElement: name => {
      if (name !== "canvas") throw new Error("unexpected element " + name);
      return offscreenCanvas();
    },
  },
  mapView: { scale: 1, ox: 0, oy: 0, rotationDeg: 0, fitted: false, fitRequest: null, state: "pending" },
  App: { payload: { map: null, wells: [] } },
  S: {
    mapLayers: [], mapLayerIdx: 0, mapFillIdx: 0, contactVis: [], wellVis: [], pointLayerVis: [],
    showOutline: false, showGridLines: false, showPoints: false, showFills: false,
    showContours: false, clipRaster: false, lodActive: false,
  },
  MAX_RASTER_DIM: 2048,
  _raster: { canvas: null, ctx: null, img: null },
  perfCount: () => {},
  paintColormap: () => "viridis",
  paintReversed: () => false,
  colormapLUT: () => {
    const lut = new Uint8Array(256 * 3);
    for (let index = 0; index < 256; index++) {
      lut[index * 3] = index; lut[index * 3 + 1] = 255 - index; lut[index * 3 + 2] = index % 17;
    }
    return lut;
  },
  outlineWorldPath: () => null,
  fillRingFor: fill => fill,
  resolveMapWellGeometry: () => [],
  computeLodActive: () => false,
  renderMap: () => { context.renderCount++; },
  renderCount: 0,
  lineSetRing: value => value,
  token: () => "#000000",
  displayId(value) {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return 0;
    if (!displayIds.has(value)) displayIds.set(value, nextDisplayId++);
    return displayIds.get(value);
  },
  vlAt: (values, index) => values && values.a ? values.a[index] : values[index],
  maskAt: (values, index) => values && values.a ? values.a[index] : values[index],
  ptN: points => points ? points.length : 0,
  ptX: (points, index) => points[index][0],
  ptY: (points, index) => points[index][1],
  visiblePointSlices: () => [{ start: 0, n: context.App.payload.map.points.length }],
  idColor: () => { throw new Error("unexpected categorical fallback"); },
};
vm.createContext(context);
vm.runInContext(helpers, context);
[
  "markMapCameraAdjusted", "mapFrame", "worldExtent", "contentExtent", "fitMap", "w2s", "s2w",
  "setMapCameraRotation", "drawWindowedRaster", "drawRegularGridFill",
  "regularGridValueAt", "frameValueAt", "overlayKey",
].forEach(name => vm.runInContext(extractFunction(mapSource, name), context));

const values = Array.from({ length: 12 }, (_, index) => index);
function fixtureFrame(rotationDeg, yflip) {
  return {
    origin_x: 1000, origin_y: 2000, spacing_x: 10, spacing_y: 20,
    ncol: 4, nrow: 3, rotation_deg: rotationDeg, yflip,
  };
}
function fillFor(frame) {
  const steps = context.frameStepVectors(frame);
  return {
    name: "depth", range: [0, 11], categorical: false,
    regular_grid: {
      dimensions: [frame.ncol, frame.nrow], origin: [frame.origin_x, frame.origin_y],
      step_i: steps.i, step_j: steps.j,
      values: { length: values.length, a: new Float64Array(values) },
      mask: { length: values.length, a: new Uint8Array(values.map(() => 1)) },
    },
  };
}
const layer = { name: "depth", display: "Depth", units: "m", range: { min: 0, max: 11 }, values };
const canvas = context.canvas = { width: 900, height: 700 };

function setView(frame, cameraRotation, scale = 2) {
  context.mapView.rotationDeg = cameraRotation;
  context.mapView.scale = scale;
  const projected = context.mapCameraProject(cameraRotation, frame.origin_x, frame.origin_y);
  context.mapView.ox = 450 - projected[0] * context.mapView.scale;
  context.mapView.oy = 350 - projected[1] * context.mapView.scale;
}

function rasterParity(frame, cameraRotation, label, scale = 2) {
  const fill = fillFor(frame);
  context.App.payload.map = { frame, contacts: [], fills: [fill], contours: [], outline: [], points: null };
  context.S.mapLayers = [layer];
  setView(frame, cameraRotation, scale);
  const direct = targetContext(), shared = targetContext();
  context.drawWindowedRaster(direct, canvas, frame, layer);
  context.drawRegularGridFill(shared, fill, context.mapView.scale, context.mapView.ox, context.mapView.oy);
  assertArrayClose(direct.matrix, shared.matrix, label + " affine matrix");
  if (!direct.image || !shared.image || JSON.stringify(direct.image._data) !== JSON.stringify(shared.image._data)) {
    throw new Error(label + " direct/shared raster bytes diverged");
  }
  if (direct.image.width !== frame.ncol || direct.image.height !== frame.nrow ||
      shared.image.width !== frame.ncol || shared.image.height !== frame.nrow) {
    throw new Error(label + " clipped an outer node");
  }
  return { matrix: direct.matrix, pixels: direct.image._data.length };
}

const axisResult = rasterParity(fixtureFrame(0, false), 0, "zero rotation");
const frame = fixtureFrame(30, true), fill = fillFor(frame);
const rotatedResults = [0, 37, -91, 180].map(camera => rasterParity(frame, camera, "30° frame / " + camera + "° camera"));
const smallFrame = {
  origin_x: 0, origin_y: 0, spacing_x: 1e-8, spacing_y: 2e-8,
  ncol: 4, nrow: 3, rotation_deg: 30, yflip: true,
};
rasterParity(smallFrame, 37, "small-spacing rotated frame", 1e9);
const smallWorld = context.frameIntrinsicToWorld(smallFrame, 2, 1);
const smallDirect = context.frameValueAt(layer, smallFrame, smallWorld);
const smallShared = context.regularGridValueAt(fillFor(smallFrame), smallWorld);
if (!smallDirect || !smallShared || smallDirect.i !== 2 || smallDirect.j !== 1 ||
    smallShared.i !== 2 || smallShared.j !== 1) {
  throw new Error("small-spacing assembled inverse rejected a valid frame");
}

// Exact inverse cursor inspection at several independent camera rotations.
const nodeWorld = context.frameIntrinsicToWorld(frame, 2, 1);
for (const camera of [0, 37, -91, 180]) {
  setView(frame, camera);
  const screen = context.w2s(nodeWorld[0], nodeWorld[1]);
  const world = context.s2w(screen[0], screen[1]);
  assertArrayClose(world, nodeWorld, "camera inverse " + camera);
  const directHit = context.frameValueAt(layer, frame, world);
  const sharedHit = context.regularGridValueAt(fill, world);
  if (!directHit || !sharedHit || directHit.i !== 2 || directHit.j !== 1 ||
      sharedHit.i !== 2 || sharedHit.j !== 1 || directHit.value !== 6 || sharedHit.value !== 6) {
    throw new Error("cursor indices diverged at camera " + camera);
  }
  // A well head and a workspace overlay point at the same world XY must remain
  // pixel-identical because both consume the assembled production w2s helper.
  assertArrayClose(context.w2s(nodeWorld[0], nodeWorld[1]), screen, "well/overlay co-location " + camera);
}

// Direct and shared null policies must both reject inspection. ScalarLayer has
// no separate mask: non-finite values are its declared transparent/null signal.
const nullWorld = context.frameIntrinsicToWorld(frame, 1, 0);
const nullLayer = { ...layer, values: values.slice() };
nullLayer.values[1] = NaN;
if (context.frameValueAt(nullLayer, frame, nullWorld) !== null) {
  throw new Error("direct ScalarLayer exposed a non-finite click value");
}
const maskedFill = fillFor(frame);
maskedFill.regular_grid.mask.a[1] = 0;
if (context.regularGridValueAt(maskedFill, nullWorld) !== null) {
  throw new Error("shared affine fill exposed a masked click value");
}

// Direct frame and shared affine fill contribute the same half-cell footprint
// to fit. This catches rotated edge clipping and n versus n-1 regressions.
context.App.payload.map = { frame, contacts: [], fills: [], contours: [], outline: [], points: null };
context.S.mapLayers = [layer]; context.S.showFills = false;
context.mapView.rotationDeg = 37;
const directExtent = context.contentExtent();
context.App.payload.map.fills = [fill]; context.S.mapLayers = []; context.S.showFills = true;
const sharedExtent = context.contentExtent();
assertArrayClose(Object.values(directExtent), Object.values(sharedExtent), "direct/shared fit extent");
context.S.mapLayers = [layer]; context.S.showFills = false;
if (!context.fitMap(canvas, "explicit")) throw new Error("rotated fit failed");
const fitted = context.frameCorners(frame, true).map(point => context.w2s(point[0], point[1]));
const xs = fitted.map(point => point[0]), ys = fitted.map(point => point[1]);
if (Math.min(...xs) < -1e-8 || Math.max(...xs) > canvas.width + 1e-8 ||
    Math.min(...ys) < -1e-8 || Math.max(...ys) > canvas.height + 1e-8 ||
    !close((Math.min(...xs) + Math.max(...xs)) / 2, canvas.width / 2) ||
    !close((Math.min(...ys) + Math.max(...ys)) / 2, canvas.height / 2)) {
  throw new Error("rotated fit clipped or miscentred a frame edge");
}

// A point-cloud world AABB must contribute all four corners before camera
// projection. Projecting only its diagonal collapses the 45° fit and clips the
// two anti-diagonal points above and below the viewport.
const edgePoints = [[0, 10000, 0], [10000, 0, 0]];
context.App.payload.map = { frame, contacts: [], fills: [], contours: [], outline: [], points: edgePoints };
context.S.mapLayers = []; context.S.showFills = false; context.S.showPoints = true;
for (const camera of [45, -45, 135]) {
  context.mapView.rotationDeg = camera;
  if (!context.fitMap(canvas, "explicit")) throw new Error("point fit failed at camera " + camera);
  for (const point of edgePoints) {
    const screen = context.w2s(point[0], point[1]);
    if (screen[0] < -1e-8 || screen[0] > canvas.width + 1e-8 ||
        screen[1] < -1e-8 || screen[1] > canvas.height + 1e-8) {
      throw new Error("point fit clipped an edge at camera " + camera + ": " + screen);
    }
  }
}
context.S.showPoints = false;

// Workspace contacts retain their producer frame. Fit must use that distinct
// frame rather than substituting the active fill/direct-raster frame.
const contactFrame = {
  origin_x: 20000, origin_y: -10000, spacing_x: 1200, spacing_y: 800,
  ncol: 3, nrow: 2, rotation_deg: 60, yflip: true,
};
context.App.payload.map = {
  frame, fills: [], contours: [], outline: [], points: null,
  contacts: [{ __workspaceFrame: contactFrame, crossing: [1, 0, 0, 0, 0, 0] }],
};
context.S.contactVis = [true];
for (const camera of [0, 47, -120]) {
  context.mapView.rotationDeg = camera;
  if (!context.fitMap(canvas, "explicit")) throw new Error("contact fit failed at camera " + camera);
  for (const point of context.frameCorners(contactFrame, true)) {
    const screen = context.w2s(point[0], point[1]);
    if (screen[0] < -1e-8 || screen[0] > canvas.width + 1e-8 ||
        screen[1] < -1e-8 || screen[1] > canvas.height + 1e-8) {
      throw new Error("contact producer frame clipped at camera " + camera + ": " + screen);
    }
  }
}
context.S.contactVis = [];

// Camera rotation preserves the viewport-centre world point and does not mutate
// intrinsic frame orientation.
setView(frame, 12);
const centreBefore = context.s2w(canvas.width / 2, canvas.height / 2);
context.setMapCameraRotation(-91, canvas);
const centreAfter = context.s2w(canvas.width / 2, canvas.height / 2);
assertArrayClose(centreAfter, centreBefore, "camera centre preservation");
if (frame.rotation_deg !== 30 || frame.yflip !== true || context.renderCount !== 1) {
  throw new Error("camera rotation mutated the intrinsic frame or failed to repaint");
}

assertArrayClose(context.mapNorthVector(0), [0, -1], "north-up");
assertArrayClose(context.mapNorthVector(90), [1, 0], "rotated north");
const cache0 = context.mapGeometryCacheKey(frame, 0);
const cache30 = context.mapGeometryCacheKey(frame, 30);
const changedFrame = { ...frame, rotation_deg: 31 };
if (cache0 === cache30 || cache0 === context.mapGeometryCacheKey(changedFrame, 0)) {
  throw new Error("geometry cache key ignored camera rotation or full frame signature");
}
context.App.payload.map = { frame, contacts: [], contours: [], outline: [] };
context.S.showGridLines = false; context.S.showContours = false; context.S.showOutline = false;
context.mapView.rotationDeg = 0;
const overlay0 = context.overlayKey("under");
context.mapView.rotationDeg = 30;
const overlay30 = context.overlayKey("under");
if (overlay0 === overlay30) throw new Error("overlay cache survived camera rotation");

console.log(JSON.stringify({
  axisMatrix: axisResult.matrix, rotatedMatrices: rotatedResults.map(result => result.matrix),
  rasterBytes: rotatedResults[0].pixels, extent: directExtent,
  centreWorld: centreAfter, north0: context.mapNorthVector(0), cacheSeparated: true,
}));
