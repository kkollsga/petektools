  // Pure async paint-completion policy. Kept dependency-free so the same logic
  // is executable in the Node race harness as well as the assembled browser IIFE.
  function paintCompletionState(requestId, expectedRequestId, requestPaintKey, currentPaintKey) {
    if (requestId !== expectedRequestId) return "stale-request";
    if (requestPaintKey !== currentPaintKey) return "stale-paint";
    return "accept";
  }

  function handleVolumeRecolorCompletion(volume, requestId, paintKey, currentPaintKey, accept, requeue) {
    var completion = paintCompletionState(requestId, volume._recolorRequestId, paintKey, currentPaintKey);
    if (completion === "stale-request") return completion;
    if (completion === "stale-paint") {
      volume._pendingPaintKey = null; volume._recolorRequestId = 0;
      if (volume._colormapKey !== currentPaintKey) requeue();
      return completion;
    }
    volume._colormapKey = paintKey; volume._pendingPaintKey = null; volume._recolorRequestId = 0;
    accept(); return completion;
  }

  function visiblePointSlicePlan(layers, pointCount, visibility) {
    var explicit = (layers || []).filter(function (layer) {
      return layer.kind === "points" && layer.start != null && layer.n != null;
    });
    var slices = explicit.length ? explicit.map(function (layer) {
      return { start: layer.start || 0, n: layer.n, layer: layer };
    }) : (pointCount ? [{ start: 0, n: pointCount, layer: null }] : []);
    return slices.filter(function (_, index) { return !visibility || visibility[index] !== false; });
  }

  function pointIndexInVisibleSlices(index, slices) {
    return (slices || []).some(function (slice) { return index >= slice.start && index < slice.start + slice.n; });
  }

  function pointSlicesExtent(points, slices, xAt, yAt) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    (slices || []).forEach(function (slice) {
      var end = Math.min(points ? points.length : 0, slice.start + slice.n);
      for (var index = slice.start; index < end; index++) {
        var x = xAt(points, index), y = yAt(points, index);
        if (!isFinite(x) || !isFinite(y)) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    });
    return isFinite(x0) ? { x0: x0, y0: y0, x1: x1, y1: y1 } : null;
  }

  function sectionHasHorizonGeometry(bundle) {
    if (!bundle) return false;
    var columns = bundle.columns || [], first = columns[0], nk = first && first.layer_tops ? first.layer_tops.length : 0;
    var hasEdges = nk > 0 && !bundle.sugar_cube
      && first.layer_tops_l && first.layer_tops_r && first.layer_bases_l && first.layer_bases_r
      && first.layer_tops_l.length === nk && first.layer_tops_r.length === nk
      && first.layer_bases_l.length === nk && first.layer_bases_r.length === nk;
    var outer = nk > 0 && columns.some(function (column) {
      if (hasEdges) return Number.isFinite(column.layer_tops_l && column.layer_tops_l[0])
        && Number.isFinite(column.layer_tops_r && column.layer_tops_r[0])
        || Number.isFinite(column.layer_bases_l && column.layer_bases_l[nk - 1])
        && Number.isFinite(column.layer_bases_r && column.layer_bases_r[nk - 1]);
      return Number.isFinite(column.layer_tops && column.layer_tops[0])
        || Number.isFinite(column.layer_bases && column.layer_bases[nk - 1]);
    });
    var interior = (bundle.horizon_traces || []).some(function (trace) {
      return (trace.depths || []).some(Number.isFinite);
    });
    return outer || interior;
  }
