"use strict";
const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync(process.argv[2], "utf8");
const context = {};
vm.runInNewContext(source, context, { filename: process.argv[2] });
const decide = context.paintCompletionState;
if (typeof decide !== "function") throw new Error("paintCompletionState was not exported by the fragment");

function simulate(kind) {
  let expectedId = 1;
  let currentPaint = "viridis|false";
  let materialKey = null;
  let pixelKey = null;
  let requeues = 0;
  function complete(id, paint) {
    const state = decide(id, expectedId, paint, currentPaint);
    if (state === "stale-paint") { expectedId += 1; requeues += 1; return state; }
    if (state === "accept") { materialKey = paint; pixelKey = paint; }
    return state;
  }

  // Decode/build started in viridis; the user flips paint before completion.
  currentPaint = "inferno|true";
  if (complete(1, "viridis|false") !== "stale-paint") throw new Error(kind + " accepted stale pixels");
  // A late duplicate from the discarded request must not overwrite the retry.
  if (complete(1, "viridis|false") !== "stale-request") throw new Error(kind + " accepted stale request id");
  if (complete(2, "inferno|true") !== "accept") throw new Error(kind + " rejected current completion");
  if (materialKey !== currentPaint || pixelKey !== currentPaint || requeues !== 1) {
    throw new Error(kind + " final material/cache key does not match pixels");
  }
  return { kind, materialKey, pixelKey, requeues };
}

const result = { volumeDecode: simulate("volume-decode"), volumeRecolor: simulate("volume-recolor"), sceneRegular: simulate("scene-regular") };
console.log(JSON.stringify(result));
