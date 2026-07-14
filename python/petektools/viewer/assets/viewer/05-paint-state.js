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

  // Workspace Map resources may use the v1 map.frame representation or the
  // v2 shared surface_grid.frame representation. Keep that seam in one pure
  // helper so composition and its executable Node proof use the same rule.
  function workspaceMapSourceFrame(map) {
    if (!map) return null;
    return (map.surface_grid && map.surface_grid.frame) || map.frame || null;
  }

  function activateWorkspaceMapFrame(map, fill) {
    if (map && fill && fill.__workspaceFrame) map.frame = fill.__workspaceFrame;
    return map && map.frame || null;
  }

  // Map geometry has two deliberately separate transforms. The intrinsic
  // frame maps lattice (i,j) into world XY (including the producer's azimuth
  // and yflip). The camera then maps world east/north to screen coordinates;
  // camera rotation zero is north-up. Never fold camera state into the frame.
  function normalizeMapRotation(degrees) {
    if (!isFinite(degrees)) return 0;
    var value = Number(degrees) % 360;
    if (value <= -180) value += 360;
    if (value > 180) value -= 360;
    return Math.abs(value) < 1e-12 ? 0 : value;
  }
  function frameStepVectors(frame) {
    if (!frame) return null;
    var angle = normalizeMapRotation(frame.rotation_deg || 0) * Math.PI / 180;
    var c = Math.cos(angle), s = Math.sin(angle), sign = frame.yflip ? -1 : 1;
    return {
      i: [Number(frame.spacing_x) * c, Number(frame.spacing_x) * s],
      j: [-sign * Number(frame.spacing_y) * s, sign * Number(frame.spacing_y) * c],
    };
  }
  function frameIntrinsicToWorld(frame, fi, fj) {
    var steps = frameStepVectors(frame);
    if (!steps) return null;
    return [Number(frame.origin_x) + fi * steps.i[0] + fj * steps.j[0],
      Number(frame.origin_y) + fi * steps.i[1] + fj * steps.j[1]];
  }
  function frameWorldToIntrinsic(frame, x, y) {
    if (!frame) return null;
    var ox = Number(frame.origin_x), oy = Number(frame.origin_y);
    var sx = Number(frame.spacing_x), sy = Number(frame.spacing_y);
    var rotation = frame.rotation_deg == null ? 0 : Number(frame.rotation_deg);
    if (![ox, oy, sx, sy, rotation, x, y].every(isFinite) || sx === 0 || sy === 0) return null;
    var angle = normalizeMapRotation(rotation) * Math.PI / 180;
    var c = Math.cos(angle), s = Math.sin(angle), sign = frame.yflip ? -1 : 1;
    var dx = x - ox, dy = y - oy;
    var fi = (c * dx + s * dy) / sx;
    var fj = sign * (-s * dx + c * dy) / sy;
    return isFinite(fi) && isFinite(fj) ? [fi, fj] : null;
  }
  function frameCorners(frame, halfCell) {
    if (!frame) return [];
    var pad = halfCell ? 0.5 : 0;
    var i0 = -pad, j0 = -pad;
    var i1 = Number(frame.ncol) - 1 + pad, j1 = Number(frame.nrow) - 1 + pad;
    return [frameIntrinsicToWorld(frame, i0, j0), frameIntrinsicToWorld(frame, i1, j0),
      frameIntrinsicToWorld(frame, i1, j1), frameIntrinsicToWorld(frame, i0, j1)];
  }
  function frameSignature(frame) {
    if (!frame) return "-";
    return [frame.origin_x, frame.origin_y, frame.spacing_x, frame.spacing_y,
      frame.ncol, frame.nrow, normalizeMapRotation(frame.rotation_deg || 0), !!frame.yflip].join(",");
  }
  function mapGeometryCacheKey(frame, cameraRotationDeg) {
    return normalizeMapRotation(cameraRotationDeg) + "|" + frameSignature(frame);
  }
  function mapCameraProject(rotationDeg, x, y) {
    var angle = normalizeMapRotation(rotationDeg) * Math.PI / 180;
    var c = Math.cos(angle), s = Math.sin(angle);
    return [c * x + s * y, s * x - c * y];
  }
  // The camera matrix is an orthogonal reflection, hence its own inverse.
  function mapCameraUnproject(rotationDeg, x, y) {
    return mapCameraProject(rotationDeg, x, y);
  }
  function mapWorldToScreen(rotationDeg, x, y, scale, ox, oy) {
    var p = mapCameraProject(rotationDeg, x, y);
    return [p[0] * scale + ox, p[1] * scale + oy];
  }
  function mapScreenToWorld(rotationDeg, px, py, scale, ox, oy) {
    return mapCameraUnproject(rotationDeg, (px - ox) / scale, (py - oy) / scale);
  }
  function mapCameraMatrix(rotationDeg, scale, ox, oy) {
    var angle = normalizeMapRotation(rotationDeg) * Math.PI / 180;
    var c = Math.cos(angle), s = Math.sin(angle);
    return [c * scale, s * scale, s * scale, -c * scale, ox, oy];
  }
  function mapAffineScreenMatrix(rotationDeg, origin, stepI, stepJ, scale, ox, oy) {
    var o = mapWorldToScreen(rotationDeg, origin[0], origin[1], scale, ox, oy);
    var di = mapCameraProject(rotationDeg, stepI[0], stepI[1]);
    var dj = mapCameraProject(rotationDeg, stepJ[0], stepJ[1]);
    return [di[0] * scale, di[1] * scale, dj[0] * scale, dj[1] * scale, o[0], o[1]];
  }
  function mapNorthVector(rotationDeg) {
    return mapCameraProject(rotationDeg, 0, 1);
  }
  // Truthful 2-D scale-bar policy. Perspective/3-D views have no constant
  // screen-to-world scale and therefore get no bar. Unknown units remain
  // unknown: the numeric world distance is still useful, but no suffix is
  // invented. Pick a 1/2/5 decade step near the requested screen width.
  function mapScaleBarPlan(scale, units, perspective, targetPx) {
    scale = Number(scale); targetPx = Number(targetPx) || 96;
    if (perspective || !isFinite(scale) || scale <= 0) return null;
    var raw = targetPx / scale;
    if (!isFinite(raw) || raw <= 0) return null;
    var power = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var ratio = raw / power, step = ratio >= 5 ? 5 : ratio >= 2 ? 2 : 1;
    var distance = step * power, px = distance * scale;
    var suffix = typeof units === "string" && units.trim() ? " " + units.trim() : "";
    return { distance: distance, px: px, label: String(Number(distance.toPrecision(6))) + suffix };
  }
