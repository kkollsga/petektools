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

function spec() {
  return {
    transport: "shared",
    attributes: [
      { id: "depth", label: "Depth", kind: "continuous", units: "m", codes: null },
      { id: "facies", label: "Facies", kind: "categorical", units: null,
        codes: { "1": { label: "One", color: "#111111" }, "3": { label: "Three", color: "#333333" } } },
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
          id: "facies", label: "Facies", kind: "categorical", units: null,
          codes: { "1": { label: "One", color: "#111111" }, "3": { label: "Three", color: "#333333" } },
          values: { length: 4, a: new Float32Array(values) }, range: null,
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
let rasterPixel = null;
const context = {
  console, Math, Number, Object, Array, Uint8Array, Float32Array, WeakMap, isFinite,
  App: { payload: {}, tab: "map" },
  S: {
    mapFillIdx: 1, mapLayerIdx: 0, pointLayerVis: [], contactVis: [true, true],
    wellVis: [], showGridLines: false, showContours: false, showOutline: false,
    lodActive: false, mapGridDefaultApplied: true,
  },
  W: {},
  workspaceSpec: () => spec(),
  workspaceLane: () => "depth",
  workspaceColorBy: () => "facies",
  workspaceItemVisible: () => true,
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
      return {
        width: 0, height: 0,
        getContext: () => ({
          createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
          putImageData: image => { rasterPixel = Array.from(image.data); },
        }),
      };
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
  perfCount: () => {},
  colormapLUT: () => new Uint8Array(256 * 3),
  paintColormap: () => "viridis",
  paintReversed: () => false,
  idColor: key => { throw new Error("unexpected synthesized category " + key); },
};
vm.createContext(context);
vm.runInContext(helpers, context);
[
  "virtualConcat", "cloneStamped", "workspaceSharedFill", "composeWorkspaceMapReady",
].forEach(name => vm.runInContext(extractFunction(workspace, name), context));
[
  "mapFrame", "worldExtent", "selectMapFill", "overlayKey", "drawRegularGridFill",
  "regularGridValueAt",
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
const category = context.categoricalCellCode(1, 1, 3, 3);
if (category !== 1 || ![1, 3].includes(category)) throw new Error("categorical raster synthesized a code");
const targetContext = {
  save: () => {}, restore: () => {}, setTransform: () => {}, drawImage: () => {},
  imageSmoothingEnabled: true,
};
context.drawRegularGridFill(targetContext, composed.fills[0], 1, 0, 0);
if (JSON.stringify(rasterPixel) !== JSON.stringify([17, 17, 17, 255])) {
  throw new Error("categorical draw path did not paint a declared source code: " + rasterPixel);
}

context.selectMapFill(0);
if (composed.frame !== frameA) throw new Error("fill selection did not activate its producer frame");

console.log(JSON.stringify({
  overlayKey: key, activeOrigin: composed.frame.origin_x,
  extent, cursorValue: cursor.value, category, rasterPixel,
}));
