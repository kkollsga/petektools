"use strict";

const fs = require("fs");
const path = require("path");
const decode = require(path.resolve(__dirname, "../../petektools/viewer/assets/decode.js"));

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const started = performance.now();
const built = decode.buildRegularSurface(
  input.surface,
  input.center,
  input.range,
  input.stops,
);
const elapsed = performance.now() - started;
process.stdout.write(JSON.stringify({
  buildMs: +elapsed.toFixed(3),
  nodes: built.pos.length / 3,
  triangles: built.index.length / 3,
  colors: built.col ? built.col.length / 3 : 0,
}));
