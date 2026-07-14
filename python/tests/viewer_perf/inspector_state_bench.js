"use strict";
const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync(process.argv[2], "utf8");
const context = {};
vm.runInNewContext(source, context, { filename: process.argv[2] });

const layers = [
  { kind: "points", name: "near", start: 0, n: 2 },
  { kind: "points", name: "hidden", start: 2, n: 2 },
];
const points = [[0.5, 0], [1, 0], [0, 0], [1000, 1000]];
const slices = context.visiblePointSlicePlan(layers, points.length, [true, false]);
const extent = context.pointSlicesExtent(points, slices, (p, i) => p[i][0], (p, i) => p[i][1]);
if (slices.length !== 1 || extent.x1 !== 1 || extent.y1 !== 0) throw new Error("hidden segment expanded fit extent");

// At the click, hidden index 2 is exact and visible index 0 is nearby. Filtering
// by the production slice helper must leave the visible point as the winner.
const candidates = [0, 2].filter(i => context.pointIndexInVisibleSlices(i, slices));
const winner = candidates.sort((a, b) => Math.hypot(points[a][0], points[a][1]) - Math.hypot(points[b][0], points[b][1]))[0];
if (winner !== 0 || context.pointIndexInVisibleSlices(2, slices)) throw new Error("hidden segment won point pick");

const innerOnly = {
  columns: [{ layer_tops: [null, 1000], layer_bases: [1100, null] }],
  horizon_traces: [],
};
if (context.sectionHasHorizonGeometry(innerOnly)) throw new Error("finite inner layers created a horizon control");
const outer = { columns: [{ layer_tops: [900, null], layer_bases: [null, 1200] }], horizon_traces: [] };
if (!context.sectionHasHorizonGeometry(outer)) throw new Error("rendered outer horizon was missed");

console.log(JSON.stringify({ slices, extent, winner, innerOnly: false, outer: true }));
