"use strict";
const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync(process.argv[2], "utf8");
const context = {};
vm.runInNewContext(source, context, { filename: process.argv[2] });
const decide = context.paintCompletionState;
const handleVolume = context.handleVolumeRecolorCompletion;
if (typeof decide !== "function") throw new Error("paintCompletionState was not exported by the fragment");
if (typeof handleVolume !== "function") throw new Error("handleVolumeRecolorCompletion was not exported by the fragment");

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

function volumeHandlerRegression() {
  const state = { _colormapKey: "viridis|false", _pendingPaintKey: "inferno|true", _recolorRequestId: 1 };
  let current = "viridis|false", pixels = "viridis|false", requeues = 0;
  const stale = handleVolume(state, 1, "inferno|true", current,
    () => { pixels = "inferno|true"; }, () => { requeues += 1; });
  if (stale !== "stale-paint" || state._pendingPaintKey !== null || state._recolorRequestId !== 0
      || pixels !== "viridis|false" || requeues !== 0) throw new Error("A→B→A did not clear discarded B");

  // Returning to B must no longer be suppressed by the discarded request.
  current = "inferno|true";
  if (state._colormapKey !== current && state._pendingPaintKey !== current) {
    state._pendingPaintKey = current; state._recolorRequestId = 2;
  } else throw new Error("later B was incorrectly suppressed");
  const accepted = handleVolume(state, 2, current, current,
    () => { pixels = current; }, () => { requeues += 1; });
  if (accepted !== "accept" || state._colormapKey !== pixels || pixels !== current
      || state._pendingPaintKey !== null) throw new Error("A→B→A→B final pixels/key mismatch");
  return { kind: "volume-recolor-handler", materialKey: state._colormapKey, pixelKey: pixels, requeues };
}

const result = { volumeDecode: simulate("volume-decode"), volumeRecolor: volumeHandlerRegression(), sceneRegular: simulate("scene-regular") };
console.log(JSON.stringify(result));
