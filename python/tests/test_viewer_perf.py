#!/usr/bin/env python3
"""Viewer v3 decode perf — budget-asserts the shell decode at 100k / 1M cells.

The old JSON-soup volume died at V8's ~537 MB string wall at ~1M cells (the
bottleneck ledger). The v3 exterior-shell + binary-block payload is ~8-9 B/cell,
and its decode (base64 -> ArrayBuffer -> typed arrays -> expand -> flat colour
bake) is the exact kernel the browser worker runs. This test:

- asserts the WIRE SIZE budget in pure Python (bytes/cell, no browser), and
- drives the REAL decode kernel (assets/decode.js) under Node and asserts the
  decode-time budget at 1M cells.

The Node leg skips cleanly when node is unavailable. The 5M-cell scale (slower to
generate) runs only when ``PETEK_PERF_5M=1``. Full browser render timing lives in
the Playwright spec under ``viewer_perf/`` (see its README).

    PYTHONPATH=python pytest python/tests/test_viewer_perf.py -q -s
"""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from petektools.viewer import _v3, save_view

_BENCH_JS = Path(__file__).parent / "viewer_perf" / "decode_bench.js"
_RENDER_JS = Path(__file__).parent / "viewer_perf" / "render_bench.mjs"
_WELLS_JS = Path(__file__).parent / "viewer_perf" / "wells_bench.mjs"
_NODE = shutil.which("node")


def _playwright_available() -> bool:
    """True when node can resolve `playwright` (NODE_PATH or a local/global install)
    AND a chromium build is present. Lets the browser leg skip cleanly in CI."""
    if _NODE is None:
        return False
    try:
        out = subprocess.run(
            [_NODE, "-e", "const {chromium}=require('playwright'); "
                          "if(!require('fs').existsSync(chromium.executablePath())) process.exit(3);"],
            capture_output=True, text=True, timeout=30,
        )
        return out.returncode == 0
    except Exception:
        return False


_HAVE_PW = _playwright_available()

# grid shapes per scale (cell-major i,j,k); flat-ish reservoirs (low relief).
SCALES = {
    "100k": (100, 100, 10),
    "1M": (200, 200, 25),
    "5M": (500, 500, 20),
}
# Wire budget: the shell payload must be a tiny fraction of the ~557 B/cell JSON
# soup it replaces — well under this cap proves the string wall is gone.
WIRE_BPC_MAX = 25.0
# Decode budget at 1M cells (best of N under Node). Actual is ~15 ms; the cap is
# loose to catch a real regression without CI flakiness.
DECODE_MS_MAX_1M = 250.0


def _make_env(scale: str, tmp_path: Path) -> tuple[dict, Path, int]:
    ni, nj, nk = SCALES[scale]
    env, _bin = _v3.build_v3_volume(ni, nj, nk)
    path = tmp_path / f"env_{scale}.json"
    text = json.dumps(env)
    path.write_text(text)
    return env, path, ni * nj * nk


def _run_bench(path: Path, iters: int = 3) -> dict:
    out = subprocess.run(
        [_NODE, "--expose-gc", str(_BENCH_JS), str(path), str(iters)],
        capture_output=True, text=True, timeout=120,
    )
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


@pytest.mark.parametrize("scale", ["100k", "1M"])
def test_wire_size_budget(scale, tmp_path):
    env, path, cells = _make_env(scale, tmp_path)
    bpc = path.stat().st_size / cells
    print(f"\n[wire] {scale}: {cells} cells, {env['triangle_count']} tris, "
          f"{path.stat().st_size / 1e6:.1f} MB = {bpc:.2f} B/cell")
    assert bpc < WIRE_BPC_MAX, f"{scale}: {bpc:.1f} B/cell exceeds {WIRE_BPC_MAX}"


@pytest.mark.skipif(_NODE is None, reason="node not available")
@pytest.mark.parametrize("scale", ["100k", "1M"])
def test_decode_kernel_under_node(scale, tmp_path):
    _env, path, cells = _make_env(scale, tmp_path)
    r = _run_bench(path)
    print(f"\n[decode] {scale}: {r['triangles']} tris | decode {r['decodeMs']} ms | "
          f"heapUsed {r['heapUsedMB']} MB | rss {r['rssMB']} MB | pos+col {r['posMB'] + r['colMB']:.1f} MB")
    assert r["triangles"] > 0 and r["decodeMs"] >= 0
    if scale == "1M":
        assert r["decodeMs"] < DECODE_MS_MAX_1M, r


@pytest.mark.skipif(_NODE is None, reason="node not available")
@pytest.mark.skipif(os.environ.get("PETEK_PERF_5M") != "1", reason="set PETEK_PERF_5M=1 to run the 5M-cell scale")
def test_decode_kernel_5m(tmp_path):
    _env, path, cells = _make_env("5M", tmp_path)
    r = _run_bench(path, iters=2)
    print(f"\n[decode] 5M: {r['triangles']} tris | decode {r['decodeMs']} ms | "
          f"heapUsed {r['heapUsedMB']} MB | rss {r['rssMB']} MB | pos+col {r['posMB'] + r['colMB']:.1f} MB")
    # UI-thread budget is 100 ms; the worker does this off-thread anyway.
    assert r["decodeMs"] < 400.0, r


# --- browser render + memory-cap leg (Playwright) ----------------------------
# JS-heap caps per ledger scale (MB) — measured this machine (headless Chromium,
# self-contained base64 export): 100k ~15, 1M ~45, 5M ~242. Caps leave healthy
# margin but catch a real regression (e.g. a JS-array materialization creeping
# back onto the hot path). The 5M cap proves the never-OOM guarantee holds to the
# ledger's top scale. FRAME_CAP is the map render (windowed raster) budget: a
# regression to a full ncol×nrow repaint blows straight past it.
HEAP_CAP_MB = {"100k": 200.0, "1M": 350.0, "5M": 900.0}
FRAME_CAP_MS = 50.0


def _build_scale_view(scale: str, tmp_path: Path) -> Path:
    """A self-contained save_view HTML at `scale`: a v3 volume + an areal map (so
    the harness exercises the windowed raster, the worker decode, and every tab)."""
    ni, nj, nk = SCALES[scale]
    env, _bin = _v3.build_v3_volume(ni, nj, nk)
    ncol, nrow = ni, nj
    vals = [0.1 + 0.1 * math.sin(i / max(8, ncol / 30)) * math.cos(j / max(8, nrow / 30))
            for j in range(nrow) for i in range(ncol)]
    rng = {"min": min(vals), "max": max(vals)}
    payload = {
        "schema_version": 3, "kind": "perf", "property": "PORO", "properties": ["PORO"],
        "summary": {"cells": ni * nj * nk}, "volume": env,
        "map": {"schema_version": 1,
                "frame": {"origin_x": 0, "origin_y": 0, "spacing_x": 25, "spacing_y": 25,
                          "ncol": ncol, "nrow": nrow},
                "outline": [[[0, 0], [(ncol - 1) * 25, 0], [(ncol - 1) * 25, (nrow - 1) * 25],
                             [0, (nrow - 1) * 25], [0, 0]]],
                "horizons": [{"name": "Top", "units": "m", "values": vals, "range": rng}],
                "zone_averages": [], "k_slices": [], "contacts": [], "grid_lines": [], "points": [], "wells": []},
        "sections": [], "section_labels": [], "wells": [], "charts": [],
    }
    out = tmp_path / f"view_{scale}.html"
    save_view(payload, out)
    return out


def _run_render(view: Path, *extra: str, timeout: int = 180) -> dict:
    out = subprocess.run(
        [_NODE, str(_RENDER_JS), str(view), *extra],
        capture_output=True, text=True, timeout=timeout,
    )
    line = (out.stdout.strip().splitlines() or ["{}"])[-1]
    data = json.loads(line) if line.startswith("{") else {}
    return {"rc": out.returncode, "stderr": out.stderr, **data}


@pytest.mark.skipif(not _HAVE_PW, reason="playwright + chromium not available (browser leg)")
@pytest.mark.parametrize("scale", ["100k", "1M"])
def test_render_heap_and_fps_budget(scale, tmp_path):
    view = _build_scale_view(scale, tmp_path)
    r = _run_render(view, f"--heap-cap-mb={HEAP_CAP_MB[scale]}", f"--frame-cap-ms={FRAME_CAP_MS}")
    print(f"\n[render] {scale}: decode+render {r.get('decodeRenderMs')} ms | "
          f"map {r.get('mapRenderMs')} ms | heap {r.get('usedJSHeapMB')} MB | {r.get('volBadge')}")
    assert r["rc"] == 0, r.get("failure") or r.get("stderr")
    assert not r.get("consoleErrors"), r["consoleErrors"]
    assert r["usedJSHeapMB"] < HEAP_CAP_MB[scale]
    assert r["mapRenderMs"] < FRAME_CAP_MS


@pytest.mark.skipif(not _HAVE_PW, reason="playwright + chromium not available (browser leg)")
@pytest.mark.skipif(os.environ.get("PETEK_PERF_5M") != "1", reason="set PETEK_PERF_5M=1 to run the 5M-cell scale")
def test_render_5m_never_ooms(tmp_path):
    view = _build_scale_view("5M", tmp_path)
    r = _run_render(view, f"--heap-cap-mb={HEAP_CAP_MB['5M']}", "--frame-cap-ms=100", timeout=300)
    print(f"\n[render] 5M: decode+render {r.get('decodeRenderMs')} ms | "
          f"heap {r.get('usedJSHeapMB')} MB | {r.get('volBadge')}")
    assert r["rc"] == 0, r.get("failure") or r.get("stderr")
    assert not r.get("consoleErrors"), r["consoleErrors"]
    assert r["usedJSHeapMB"] < HEAP_CAP_MB["5M"]


@pytest.mark.skipif(not _HAVE_PW, reason="playwright + chromium not available (browser leg)")
def test_render_auto_degrades_over_budget(tmp_path):
    # Lower the triangle budget below the 1M-cell shell so the guard MUST engage:
    # the viewer degrades to a decimated preview + a loud banner, never crashes.
    view = _build_scale_view("1M", tmp_path)
    r = _run_render(view, "--tri-budget=20000", "--expect-degraded", "--tab=volume",
                    f"--heap-cap-mb={HEAP_CAP_MB['1M']}")
    print(f"\n[degrade] 1M @ budget 20k: {r.get('volBadge')} | banner={r.get('degradedBanner') is not None}")
    assert r["rc"] == 0, r.get("failure") or r.get("stderr")
    assert r["degradedBanner"] and "Decimated preview" in r["degradedBanner"]
    assert "1:" in (r["volBadge"] or "")  # stride shown on the badge
    assert not r.get("consoleErrors"), r["consoleErrors"]


# --- 200k-point map overlay: batched/baked/rAF-coalesced point path ------------
# The worst case that made view2d unusable: a 200k-point cloud with point_color
# set (per-point colormap lookup) plus an inferred-geometry grid-line overlay.
# The old per-point beginPath/arc/fill path cost ~145 ms/frame and re-rendered
# synchronously per wheel/drag DOM event (~139 ms/event → a 90-event drag took
# 12.5 s). Budgets: the full map render (includes the offscreen point bake) and
# the median rAF-coalesced drag repaint must land well under a 60 Hz frame; the
# drag must coalesce to at most one repaint per animation frame; the grid-bucket
# hover sweep must stay cheap (the old O(n) scan cost ~2.6 ms/event).
POINTS_N = 200_000
POINTS_FRAME_CAP_MS = 16.0       # full map render incl. point bake (was ~145 ms)
POINTS_DRAG_CAP_MS = 8.0         # median coalesced drag repaint (was ~139 ms/event)
POINTS_HOVER_CAP_MS = 5.0        # avg non-drag hover event (was ~2.6 ms of scan alone)


def _build_points_view(tmp_path: Path, npts: int = POINTS_N) -> Path:
    """A save_view HTML with a `npts` colored point cloud + a grid-line geometry
    overlay (and a tiny v3 volume so the harness's volume leg still passes)."""
    import random

    rng = random.Random(7)
    ncol = nrow = 241
    sp = 25.0
    w = (ncol - 1) * sp
    pts = []
    for _ in range(npts):
        x, y = rng.uniform(0, w), rng.uniform(0, w)
        z = -2600.0 + 60.0 * (x / w) - 40.0 * (y / w) ** 2 + rng.uniform(-5, 5)
        if rng.random() < 0.01:
            z = None  # non-finite z → the accent-fallback bin
        pts.append([round(x, 2), round(y, 2), None if z is None else round(z, 2)])
    zs = [p[2] for p in pts if p[2] is not None]
    grid_lines = []
    for k in range(0, ncol, 3):  # inferred-geometry overlay: ~160 lattice lines
        c = k * sp
        grid_lines.append([[0.0, c], [w, c]])
        grid_lines.append([[c, 0.0], [c, w]])
    env, _bin = _v3.build_v3_volume(50, 50, 4)
    payload = {
        "schema_version": 3, "kind": "points-perf", "property": "z", "properties": ["z"],
        "summary": {"cells": 50 * 50 * 4}, "volume": env,
        "map": {"schema_version": 1,
                "frame": {"origin_x": 0, "origin_y": 0, "spacing_x": sp, "spacing_y": sp,
                          "ncol": ncol, "nrow": nrow},
                "outline": [[[0, 0], [w, 0], [w, w], [0, w], [0, 0]]],
                "horizons": [], "zone_averages": [], "k_slices": [], "contacts": [],
                "grid_lines": grid_lines, "points": pts, "wells": [],
                "point_color": {"by": "z", "range": [min(zs), max(zs)]}},
        "sections": [], "section_labels": [], "wells": [], "charts": [],
    }
    out = tmp_path / "points_200k.html"
    save_view(payload, out)
    return out


@pytest.mark.skipif(not _HAVE_PW, reason="playwright + chromium not available (browser leg)")
def test_render_200k_points_pan_hover_budget(tmp_path):
    view = _build_points_view(tmp_path)
    r = _run_render(view, f"--frame-cap-ms={POINTS_FRAME_CAP_MS}", "--drag-events=90",
                    f"--drag-frame-cap-ms={POINTS_DRAG_CAP_MS}", timeout=240)
    print(f"\n[points] 200k: map render {r.get('mapRenderMs')} ms | "
          f"drag {r.get('dragFrames')} frames / {r.get('dragEvents')} events, "
          f"median {r.get('dragFrameMsMedian')} ms (max {r.get('dragFrameMsMax')}) | "
          f"hover {r.get('hoverAvgMs')} ms/event | heap {r.get('usedJSHeapMB')} MB")
    assert r["rc"] == 0, r.get("failure") or r.get("stderr")
    assert not r.get("consoleErrors"), r["consoleErrors"]
    # full map render (incl. the offscreen point bake) inside a 60 Hz frame
    assert r["mapRenderMs"] < POINTS_FRAME_CAP_MS
    # pan/zoom: at most one repaint per animation frame (~3 events dispatched/frame)
    assert r["dragFrames"] <= (r["dragEvents"] // 2), r
    assert r["dragFrameMsMedian"] < POINTS_DRAG_CAP_MS, r
    # hover: shows NOTHING (click-to-inspect ruling) and stays cheap; a still
    # CLICK at the canvas centre hits a point (the grid-bucket hit-test) and
    # reveals the readout anchored there
    assert r["hoverAvgMs"] < POINTS_HOVER_CAP_MS, r
    assert r["hoverReadout"] is False, r
    assert r["clickReadout"] is True, r


# --- the Wells correlation tab + v4 obligations (Playwright) ------------------
# Drives the correlation-view path render_bench can't (it is volume-centric): the
# Wells tab at both hanging modes (TVD + flatten-on-pick, incl. a missing-pick /
# parked well), a synthetic hover, a theme flip, and the section (interior-horizon
# traces) + map (tie glyphs) tabs — under the same zero-console-error watch.
def _run_wells(view: Path, *extra: str, timeout: int = 120) -> dict:
    out = subprocess.run(
        [_NODE, str(_WELLS_JS), str(view), *extra],
        capture_output=True, text=True, timeout=timeout,
    )
    line = (out.stdout.strip().splitlines() or ["{}"])[-1]
    data = json.loads(line) if line.startswith("{") else {}
    return {"rc": out.returncode, "stderr": out.stderr, **data}


@pytest.mark.skipif(not _HAVE_PW, reason="playwright + chromium not available (browser leg)")
@pytest.mark.parametrize("nwells", [1, 4, 8])
def test_wells_correlation_render(nwells, tmp_path):
    from petektools.viewer import demo
    from petektools.viewer._wells import build_well_log_bundle

    payload = demo.build_correlation_demo_payload()
    # scale the well count: 1 (edge), 4 (fixture), 8 (dense) — reuse the bundle's
    # wells, cloning with fresh ids so identity slots stay distinct.
    base = build_well_log_bundle()["wells"]
    wells = []
    for k in range(nwells):
        src = dict(base[k % len(base)])
        src["id"] = src["display_name"] = f"99/{k + 1}-x"
        wells.append(src)
    payload["wells_logs"] = {"kind": "wells_logs", "schema_version": 4,
                             "flatten_default": "TopShale", "wells": wells}
    view = tmp_path / f"wells_{nwells}.html"
    save_view(payload, view)
    r = _run_wells(view)
    print(f"\n[wells] n={nwells}: tvd {r.get('wellsTvdRenderMs')} ms | "
          f"flatten {r.get('wellsFlattenRenderMs')} ms | hover={r.get('readoutShown')}")
    assert r["rc"] == 0, r.get("failure") or r.get("stderr")
    assert not r.get("consoleErrors"), r["consoleErrors"]
    assert r["wellsTvdRenderMs"] > 0 and r["wellsFlattenRenderMs"] > 0
    assert r["foundHangSelect"] and r["mapRenderMs"] > 0


# --- regression: JSON null layer depths must not poison the section frame ------
# petekStatic emits f64::NAN for an inactive/truncated layer (follow-conformity
# pinch); serde serializes NaN -> JSON null. The global isFinite() coerces
# (isFinite(null) === true because Number(null) === 0), so an unguarded viewer
# counted null depths as depth 0 -> zlo=0 -> margin ~0.12*zhi -> the frame
# stretched to a rogue negative top with a flat 1px trace at Y(0). The fix guards
# every section depth read with Number.isFinite. This test feeds a section whose
# layer depths contain null RUNS and asserts the computed frame (the
# __PETEK_SECTION_FRAME hook) spans the finite data only.
@pytest.mark.skipif(not _HAVE_PW, reason="playwright + chromium not available (browser leg)")
def test_section_null_depths_frame_finite_extent(tmp_path):
    from petektools.viewer import demo

    payload = demo.build_correlation_demo_payload()
    sec = payload["sections"][0]
    # Poison the section the way the engine wire does: null runs in layer depths
    # (an entire pinched-out layer over a run of columns, plus a fully-inactive
    # column), and a null contact depth for good measure.
    for ci, col in enumerate(sec["columns"]):
        if 5 <= ci <= 9:      # layer 1 pinched out over a run of columns
            col["layer_tops"][1] = None
            col["layer_bases"][1] = None
            col["values"][1] = None
        if ci == 15:          # one fully-inactive column
            col["layer_tops"] = [None] * len(col["layer_tops"])
            col["layer_bases"] = [None] * len(col["layer_bases"])
            col["values"] = [None] * len(col["values"])
    sec["contacts"].append({"kind": "GOC", "depth_m": None})

    # the finite extent the frame must stay inside (margin = max(25, 12%) per side)
    finite = [
        d
        for col in sec["columns"]
        for d in (col["layer_tops"] + col["layer_bases"])
        if d is not None
    ] + [c["depth_m"] for c in sec["contacts"] if c["depth_m"] is not None]
    zlo, zhi = min(finite), max(finite)
    margin = max(25.0, 0.12 * (zhi - zlo))

    view = tmp_path / "null_section.html"
    save_view(payload, view)
    r = _run_wells(view)
    frame = r.get("sectionFrame")
    print(f"\n[null-frame] finite {zlo:.0f}..{zhi:.0f} | frame {frame}")
    assert r["rc"] == 0, r.get("failure") or r.get("stderr")
    assert not r.get("consoleErrors"), r["consoleErrors"]
    assert frame, "viewer did not expose __PETEK_SECTION_FRAME"
    # the frame's data extent is exactly the finite extent — null never counted
    assert abs(frame["zlo"] - zlo) < 1e-6 and abs(frame["zhi"] - zhi) < 1e-6
    # and the framed window is that extent plus the margin — NOT dragged to 0 /
    # negative by null-as-0 (the bug framed zmin ~ -254 m)
    assert abs(frame["zmin"] - (zlo - margin)) < 1e-6
    assert abs(frame["zmax"] - (zhi + margin)) < 1e-6
    assert frame["zmin"] > 0, "frame top dragged toward/below 0 — null poisoned it"


# --- rider: the volume tab must never hang on a bad mesh (Playwright) ---------
# A real build surfaced a volume whose mesh decoded to 0 triangles (an upstream
# engine bug): the viewer stuck on "Decoding mesh…" forever with no error. The
# viewer must refuse LOUDLY (a visible in-tab message + status hook) and never
# spin: (1) a zero-triangle decode -> "mesh is empty" message; (2) a decode that
# never reports back -> a watchdog surfaces a visible failure.
_EMPTY_JS = Path(__file__).parent / "viewer_perf" / "empty_bench.mjs"


def _save_volume_view(env: dict, tmp_path: Path, name: str) -> Path:
    payload = {
        "schema_version": 3, "kind": "volume", "property": "PORO", "properties": ["PORO"],
        "summary": {"cells": env.get("cell_count", 0)}, "volume": env,
        "sections": [], "section_labels": [], "wells": [], "charts": [],
    }
    out = tmp_path / name
    save_view(payload, out)
    return out


def _run_empty(view: Path, *extra: str, timeout: int = 60) -> dict:
    out = subprocess.run(
        [_NODE, str(_EMPTY_JS), str(view), *extra],
        capture_output=True, text=True, timeout=timeout,
    )
    line = (out.stdout.strip().splitlines() or ["{}"])[-1]
    data = json.loads(line) if line.startswith("{") else {}
    return {"rc": out.returncode, "stderr": out.stderr, **data}


@pytest.mark.skipif(not _HAVE_PW, reason="playwright + chromium not available (browser leg)")
def test_volume_empty_mesh_refuses_loudly(tmp_path):
    from petektools.viewer._v3 import encode_volume_bundle

    # A volume that DECLARES cells but whose mesh has zero triangles (the exact
    # producer-bug shape). Every geometry block is empty.
    env, _bin = encode_volume_bundle(
        property="PORO", cell_count=4096,
        positions=[], indices=[], tri_cell=[], cell_values=[], zone_ids=[],
        zone_names=[], value_range={"min": 0.0, "max": 1.0},
    )
    view = _save_volume_view(env, tmp_path, "empty_vol.html")
    r = _run_empty(view)
    print(f"\n[empty] status={r.get('status')} | empty={r.get('emptyText')!r}")
    assert r["rc"] == 0, r.get("stderr")
    assert not r.get("consoleErrors"), r["consoleErrors"]
    st = r.get("status") or {}
    assert st.get("state") == "empty", r
    assert st.get("triangles") == 0 and st.get("cells") == 4096
    assert not r.get("stillSpinning"), "viewer stayed on the decoding spinner"
    et = r.get("emptyText") or ""
    assert "0 triangles" in et and "producer bug" in et


@pytest.mark.skipif(not _HAVE_PW, reason="playwright + chromium not available (browser leg)")
def test_volume_decode_watchdog_never_hangs(tmp_path):
    # A normal (non-empty) volume, but force the decode to stall so ONLY the
    # watchdog can rescue the UI — proves the no-hang guarantee end to end.
    env, _bin = _v3.build_v3_volume(20, 20, 5)
    view = _save_volume_view(env, tmp_path, "stall_vol.html")
    r = _run_empty(view, "--stall", "--watchdog-ms=500")
    print(f"\n[stall] status={r.get('status')} | waited={r.get('waitedMs')} ms")
    assert r["rc"] == 0, r.get("stderr")
    assert not r.get("consoleErrors"), r["consoleErrors"]
    st = r.get("status") or {}
    assert st.get("state") == "stalled", r
    assert not r.get("stillSpinning")
    assert "timed out" in (r.get("emptyText") or "")


# --- sugar-cube ruling: section cells follow zone edges by default ------------
# v4-additive FROZEN schema: IntersectionBundle root gains `sugar_cube: bool`;
# each column gains per-k edge arrays layer_tops_l/r + layer_bases_l/r (the cell
# interval at the column's left/right fence edges, NaN-gapped like layer_tops;
# centroid layer_tops/layer_bases stay for hover). Edge arrays present AND
# sugar_cube false/absent -> TRAPEZOID cells (dip within each column); sugar_cube
# true OR edge arrays absent (older payloads) -> the flat-rect path, gracefully.
# The fixture below is hand-authored per that schema (petekStatic's producer half
# lands separately; round-trip happens at the next validation pass).
_DIP_JS = Path(__file__).parent / "viewer_perf" / "dip_bench.mjs"


def _dip_section(*, sugar: bool = False, edges: bool = True) -> dict:
    """4 columns at 100 m spacing, nk=1, a continuous 0.3 m/m dip: column i's
    cell top runs 2000+30i (left edge) -> 2030+30i (right edge), 40 m thick.
    Includes a same-depth GOC/OWC pair + two close interior horizons so the
    label collision paths (combine + stagger) are exercised under the
    zero-console-error watch. Geometry is tuned for the pixel probe: the
    interior traces sit near the cell BASE (below the z=2060 probe) and the
    samples (d=60/95) sit on the LEFT half of column 1, where the sloping
    centroid top-trace stays above the flat rect top — so in sugar/legacy mode
    the only paint at the probe column-top is the flat fill edge."""
    cols = []
    for i in range(4):
        tl = 2000.0 + i * 30.0
        tr = tl + 30.0
        top_c = (tl + tr) / 2.0
        col = {
            "distance_m": i * 100.0, "i": i, "j": 0, "x": i * 100.0, "y": 0.0,
            "layer_tops": [top_c], "layer_bases": [top_c + 40.0],
            "values": [0.5], "path_z": None,
        }
        if edges:
            col["layer_tops_l"] = [tl]
            col["layer_tops_r"] = [tr]
            col["layer_bases_l"] = [tl + 40.0]
            col["layer_bases_r"] = [tr + 40.0]
        cols.append(col)
    sec = {
        "schema_version": 1, "property": "PORO",
        "top_name": "TopRes", "base_name": "BaseRes",
        "columns": cols,
        "contacts": [{"kind": "GOC", "depth_m": 2100.0},
                     {"kind": "OWC", "depth_m": 2100.0}],
        "horizon_traces": [
            {"name": "MidA", "depths": [c["layer_tops"][0] + 34.0 for c in cols]},
            {"name": "MidB", "depths": [c["layer_tops"][0] + 38.0 for c in cols]},
        ],
    }
    if sugar:
        sec["sugar_cube"] = True
    return sec


def _save_dip_view(tmp_path: Path, name: str, **kw) -> Path:
    from petektools.viewer import demo

    payload = demo.build_correlation_demo_payload()   # bootable shell
    payload["sections"] = [_dip_section(**kw)]
    payload["section_labels"] = ["dip-fixture"]
    out = tmp_path / name
    save_view(payload, out)
    return out


def _run_dip(view: Path, timeout: int = 60) -> dict:
    out = subprocess.run(
        [_NODE, str(_DIP_JS), str(view), "--d1=60", "--d2=95", "--dmax=300", "--zprobe=2060"],
        capture_output=True, text=True, timeout=timeout,
    )
    line = (out.stdout.strip().splitlines() or ["{}"])[-1]
    data = json.loads(line) if line.startswith("{") else {}
    return {"rc": out.returncode, "stderr": out.stderr, **data}


@pytest.mark.skipif(not _HAVE_PW, reason="playwright + chromium not available (browser leg)")
def test_section_trapezoid_follows_dip_both_themes(tmp_path):
    view = _save_dip_view(tmp_path, "dip.html")
    r = _run_dip(view)
    assert r["rc"] == 0, r.get("stderr")
    assert not r.get("consoleErrors"), r["consoleErrors"]
    assert r["mode"] == "trapezoid", r
    b, a = r["before"], r["after"]
    dy0, dy1 = abs(b["y2"] - b["y1"]), abs(a["y2"] - a["y1"])
    print(f"\n[dip] mode={r['mode']} | top y @d=60/95: {b['y1']}/{b['y2']} "
          f"(dy={dy0}px) | after theme flip ({r['theme']}): dy={dy1}px")
    assert b["y1"] > 0 and b["y2"] > 0, "top boundary not found on canvas"
    # 10.5 m of within-column dip across a ~210 m frame — decisively non-horizontal.
    assert dy0 >= 8, f"cell top rendered flat (dy={dy0}px) — trapezoid path not active"
    # theme flip re-renders through the same path; the dip must survive
    assert r["modeAfter"] == "trapezoid" and a["y1"] > 0 and dy1 >= 8, r
    # the frame includes the dipping edge extremes (zlo=2000 left edge of col 0)
    assert abs(r["frame"]["zlo"] - 2000.0) < 1e-6 and abs(r["frame"]["zhi"] - 2160.0) < 1e-6


@pytest.mark.skipif(not _HAVE_PW, reason="playwright + chromium not available (browser leg)")
@pytest.mark.parametrize("case", ["sugar_cube", "no_edges"])
def test_section_sugar_cube_and_legacy_fall_back_flat(case, tmp_path):
    kw = {"sugar": True} if case == "sugar_cube" else {"edges": False}
    view = _save_dip_view(tmp_path, f"{case}.html", **kw)
    r = _run_dip(view)
    assert r["rc"] == 0, r.get("stderr")
    assert not r.get("consoleErrors"), r["consoleErrors"]
    assert r["mode"] == "rect", r
    b = r["before"]
    dy = abs(b["y2"] - b["y1"])
    print(f"\n[{case}] mode={r['mode']} | top y @d=60/95: {b['y1']}/{b['y2']} (dy={dy}px)")
    assert b["y1"] > 0 and b["y2"] > 0, "top boundary not found on canvas"
    # flat rect: the two samples inside one column sit on the same horizontal top
    assert dy <= 2, f"sugar-cube/legacy cell top is not flat (dy={dy}px)"
    assert r["modeAfter"] == "rect"


# --- color-by-zone: section fill swaps to the categorical zone identity --------
# v-zone-color FROZEN schema (petekStatic producer half lands separately; the
# round-trip closes at the next validation pass): a SectionBundle gains
# `zones: [{name, color?}]` and each Column gains `zone_ids` (per-k, aligned/
# NaN-gapped like `values`; an index into `zones`). A "Color by: property | zone"
# select flips the cell FILL between the property colormap and the fixed
# categorical zone identity — the trapezoid/sugar-cube geometry path is unchanged.
# A user-declared hex WINS over the categorical slot; a zone with no colour takes
# the same identity slot the Volume/Wells zone legend uses for that name.
_ZONE_JS = Path(__file__).parent / "viewer_perf" / "zone_bench.mjs"
_LABEL_JS = Path(__file__).parent / "viewer_perf" / "label_bench.mjs"

# A distinctive user hex (magenta) that collides with neither the categorical
# slots nor the viridis ramp — an unambiguous override probe.
_ZONE1_HEX = "#ff00ff"


def _zone_section(*, zones: bool = True) -> dict:
    """4 columns @100 m, nk=3 flat bands (2000-2030 / 2030-2060 / 2060-2090), each
    band a distinct zone. Zone 1 carries a user hex (override), Zones 2/3 take the
    categorical identity slot. `zones=False` drops the zones + zone_ids entirely
    (the graceful-fallback fixture — the select must not appear)."""
    tops = [2000.0, 2030.0, 2060.0]
    bases = [2030.0, 2060.0, 2090.0]
    cols = []
    for i in range(4):
        col = {
            "distance_m": i * 100.0, "i": i, "j": 0, "x": i * 100.0, "y": 0.0,
            "layer_tops": list(tops), "layer_bases": list(bases),
            "values": [0.5, 0.5, 0.5], "path_z": None,
        }
        if zones:
            col["zone_ids"] = [0, 1, 2]
        cols.append(col)
    sec = {
        "schema_version": 1, "property": "PORO",
        "top_name": "TopRes", "base_name": "BaseRes",
        "columns": cols,
        # no contacts / interior traces — the bands stay clean fills for the pixel
        # probe (contact/trace overlays are covered by the dip + label harnesses).
        "contacts": [],
    }
    if zones:
        # names match the volume's build_v3_volume zone_names ("Zone 1/2/3") so the
        # identity cross-check against the Volume legend is meaningful.
        sec["zones"] = [
            {"name": "Zone 1", "color": _ZONE1_HEX},
            {"name": "Zone 2", "color": None},
            {"name": "Zone 3"},
        ]
    return sec


def _save_zone_view(tmp_path: Path, name: str, *, zones: bool = True) -> Path:
    from petektools.viewer import demo
    # build_demo_payload carries a v3 volume with zone_names Zone 1/2/3 — the
    # Volume-legend identity source the section fill is checked against.
    payload = demo.build_demo_payload()
    payload["sections"] = [_zone_section(zones=zones)]
    payload["section_labels"] = ["zone-fixture"]
    out = tmp_path / name
    save_view(payload, out)
    return out


def _run_zone(view: Path, screenshot: Path | None = None, timeout: int = 90) -> dict:
    cmd = [_NODE, str(_ZONE_JS), str(view), "--dmax=300"]
    if screenshot is not None:
        cmd.append(f"--screenshot={screenshot}")
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    line = (out.stdout.strip().splitlines() or ["{}"])[-1]
    data = json.loads(line) if line.startswith("{") else {}
    return {"rc": out.returncode, "stderr": out.stderr, **data}


def _rgb_close(a, b, tol: int = 6) -> bool:
    return a is not None and b is not None and all(abs(x - y) <= tol for x, y in zip(a, b))


@pytest.mark.skipif(not _HAVE_PW, reason="playwright + chromium not available (browser leg)")
def test_section_color_by_zone_identity_and_override(tmp_path):
    """Zone mode fills by zone identity; the identity matches the Volume legend
    (identity follows the entity across views), a user hex WINS, both themes render
    with zero console errors."""
    shots = Path(os.environ.get("PETEK_SHOTS_DIR", str(tmp_path)))
    shots.mkdir(parents=True, exist_ok=True)
    view = _save_zone_view(tmp_path, "zone.html")
    r = _run_zone(view, screenshot=shots / "section-zone-mode.png")
    assert r["rc"] == 0, r.get("stderr")
    assert not r.get("consoleErrors"), r["consoleErrors"]
    # the select exists with property/zone; initial fill is property
    assert r["hasZones"] is True and r["hasSelect"] is True, r
    assert r["selectOptions"] == ["property", "zone"], r
    assert r["colorByInitial"] == "property" and r["colorByAfter"] == "zone", r

    zl = r["zoneLight"]
    # Zone 1 override: the top band renders the exact user hex (255,0,255)
    assert _rgb_close(zl["band0"], [255, 0, 255], tol=4), zl
    # Zone 2 / Zone 3 (no hex) render their categorical identity == the Volume
    # legend chip for the same name (the dataviz identity rule across tabs)
    vl = r["volLegend"]
    assert _rgb_close(zl["band1"], vl.get("Zone 2")), (zl["band1"], vl)
    assert _rgb_close(zl["band2"], vl.get("Zone 3")), (zl["band2"], vl)
    # override really diverges from the categorical slot the volume would use
    assert not _rgb_close(zl["band0"], vl.get("Zone 1")), (zl["band0"], vl)
    # the section zone legend swapped in three zone chips (fill-swatches, not lines)
    chips = {c["text"]: c for c in r["legendZoneChips"] if c["text"] in ("Zone 1", "Zone 2", "Zone 3")}
    assert set(chips) == {"Zone 1", "Zone 2", "Zone 3"}, r["legendZoneChips"]
    assert all(not chips[n]["line"] for n in chips), chips
    # dark theme: zone fill survives the token re-read (bands still painted,
    # identity still distinct from each other)
    zd = r["zoneDark"]
    assert r["theme"] == "dark", r
    assert _rgb_close(zd["band0"], [255, 0, 255], tol=4), zd  # user hex is theme-independent
    assert not _rgb_close(zd["band1"], zd["band2"]), zd       # zones stay distinguishable
    print(f"\n[zone] light bands z0/z1/z2 = {zl['band0']}/{zl['band1']}/{zl['band2']} | "
          f"volLegend Zone2/3 = {vl.get('Zone 2')}/{vl.get('Zone 3')}")


@pytest.mark.skipif(not _HAVE_PW, reason="playwright + chromium not available (browser leg)")
def test_section_no_zone_ids_hides_select(tmp_path):
    """A payload without zone_ids never shows the Color-by select and stays on the
    property colormap — graceful fallback, no error."""
    view = _save_zone_view(tmp_path, "nozone.html", zones=False)
    r = _run_zone(view)
    assert r["rc"] == 0, r.get("stderr")
    assert r["hasZones"] is False and r["hasSelect"] is False, r
    assert r["colorByInitial"] == "property", r


def _long_fence_section() -> dict:
    """A ~16 km fence (40 columns) with EIGHT interior-horizon traces that converge
    into a ~10 m band at the right edge — so their once-at-the-right labels would
    pile into one x-column without the extended slot ledger."""
    ncols, dmax = 40, 16000.0
    cols = []
    for c in range(ncols):
        d = (c / (ncols - 1)) * dmax
        cols.append({
            "distance_m": round(d, 1), "i": c, "j": 0, "x": d, "y": 0.0,
            "layer_tops": [2000.0], "layer_bases": [2100.0], "values": [0.5], "path_z": None,
        })
    traces = []
    for hi in range(8):
        # spread on the left, converge to 2050 + hi*1.5 at the right edge
        depths = []
        for c in range(ncols):
            f = c / (ncols - 1)
            right = 2050.0 + hi * 1.5
            depths.append(round(right + (1.0 - f) * hi * 8.0, 2))
        traces.append({"name": f"H{hi}", "depths": depths})
    return {
        "schema_version": 4, "property": "PORO",
        "top_name": "TopRes", "base_name": "BaseRes",
        "columns": cols, "horizon_traces": traces, "contacts": [],
    }


def _run_label(view: Path, timeout: int = 60) -> dict:
    out = subprocess.run([_NODE, str(_LABEL_JS), str(view)], capture_output=True, text=True, timeout=timeout)
    line = (out.stdout.strip().splitlines() or ["{}"])[-1]
    data = json.loads(line) if line.startswith("{") else {}
    return {"rc": out.returncode, "stderr": out.stderr, **data}


def _no_overlap(labels) -> bool:
    """No two labels overprint: any pair is separated on x (>=30px) OR y (>=11px)."""
    for i in range(len(labels)):
        for j in range(i + 1, len(labels)):
            a, b = labels[i], labels[j]
            if abs(a["x"] - b["x"]) < 30 and abs(a["y"] - b["y"]) < 11:
                return False
    return True


@pytest.mark.skipif(not _HAVE_PW, reason="playwright + chromium not available (browser leg)")
def test_long_fence_labels_stagger_not_cluster(tmp_path):
    """On a 16 km fence the 8 clustered horizon labels are decluttered by the
    extended slot ledger (vertical slot + horizontal stagger + fade) — none
    overprint, and the polish demonstrably engaged; both themes, zero errors."""
    from petektools.viewer import demo
    payload = demo.build_demo_payload()
    payload["sections"] = [_long_fence_section()]
    payload["section_labels"] = ["16km fence"]
    view = tmp_path / "longfence.html"
    save_view(payload, view)
    r = _run_label(view)
    assert r["rc"] == 0, r.get("stderr")
    assert not r.get("consoleErrors"), r["consoleErrors"]
    light, dark = r["light"], r["dark"]
    assert len(light) == 8 and len(dark) == 8, r
    assert _no_overlap(light), light
    assert _no_overlap(dark), dark
    # the polish engaged: at least one label staggered left of the right-edge
    # anchor, OR faded (a heavily-displaced label reads recessive)
    max_x = max(L["x"] for L in light)
    staggered = any(L["x"] < max_x - 20 for L in light)
    faded = any(L["alpha"] < 1 for L in light)
    assert staggered or faded, light
    print(f"\n[label] 8 labels | staggered={staggered} faded={faded} | "
          f"x-range {min(L['x'] for L in light):.0f}..{max_x:.0f}")


# --- color spec + per-layer legend: inferno points, clamped range, names ------
# Drives the P2 semantics end to end in a real browser: a view2d payload built
# with color="inferno_-2700_-2500" over NAMED points + a geometry must render
# the cloud in the payload-pinned inferno ramp with the explicit range CLAMPING
# out-of-range values to the ramp ends, show per-layer legend entries (type
# icon + duck-typed name, ramp + clamped range on the value-coloured points),
# initialize the colormap selector from the payload, and survive a theme flip.
_LEGEND_JS = Path(__file__).parent / "viewer_perf" / "legend_bench.mjs"

# world coordinates of the three probe blobs (z = max / min / below-min)
_BLOB_MAX = (100.0, 100.0)
_BLOB_MIN = (500.0, 100.0)
_BLOB_CLAMP = (900.0, 100.0)


def _build_inferno_points_view(tmp_path: Path) -> tuple[Path, dict]:
    import random

    from petektools import viewer

    rng = random.Random(11)

    class Points:
        name = "Top Dome"

        def xyz(self):
            rows = []
            for (cx, cy), z in (
                (_BLOB_MAX, -2500.0),    # == range max -> inferno t=1
                (_BLOB_MIN, -2700.0),    # == range min -> inferno t=0
                (_BLOB_CLAMP, -3000.0),  # below min -> CLAMPS to t=0
            ):
                for _ in range(1500):
                    rows.append([cx + rng.uniform(-20, 20), cy + rng.uniform(-20, 20), z])
            return rows

    class Geom:
        name = "Dome grid"
        xori = 0.0
        yori = 0.0
        xinc = 200.0
        yinc = 200.0
        ncol = 6
        nrow = 6

        def node_xy(self, i, j):
            return (i * 200.0, j * 200.0)

    payload = viewer.view2d_payload([Points(), Geom()], color="inferno_-2700_-2500")
    out = tmp_path / "inferno_points.html"
    save_view(payload, out)
    return out, payload


def _run_legend(view: Path, shots: Path, timeout: int = 90) -> dict:
    out = subprocess.run(
        [_NODE, str(_LEGEND_JS), str(view),
         f"--p1={_BLOB_MAX[0]},{_BLOB_MAX[1]}",
         f"--p2={_BLOB_MIN[0]},{_BLOB_MIN[1]}",
         f"--p3={_BLOB_CLAMP[0]},{_BLOB_CLAMP[1]}",
         f"--shot-light={shots / 'map-inferno-light.png'}",
         f"--shot-dark={shots / 'map-inferno-dark.png'}"],
        capture_output=True, text=True, timeout=timeout,
    )
    line = (out.stdout.strip().splitlines() or ["{}"])[-1]
    data = json.loads(line) if line.startswith("{") else {}
    return {"rc": out.returncode, "stderr": out.stderr, **data}


def _num(text: str) -> float:
    """A legend scale label back to its number (locale separators stripped)."""
    return float(text.replace(",", "").replace(" ", "").replace(" ", ""))


def _close(a, b, tol: int = 30) -> bool:
    return a is not None and b is not None and all(abs(x - y) <= tol for x, y in zip(a, b))


@pytest.mark.skipif(not _HAVE_PW, reason="playwright + chromium not available (browser leg)")
def test_map_inferno_points_clamped_legend_names_both_themes(tmp_path):
    view, payload = _build_inferno_points_view(tmp_path)
    # payload-side sanity: colormap pinned, explicit clamp range, NO fill
    assert payload["map"]["colormap"] == "inferno"
    assert payload["map"]["point_color"] == {"by": "z", "range": [-2700.0, -2500.0]}
    assert payload["map"]["fills"] == []
    assert {"kind": "points", "name": "Top Dome"} in payload["map"]["layers"]

    shots = Path(os.environ.get("PETEK_SHOTS_DIR", str(tmp_path)))
    shots.mkdir(parents=True, exist_ok=True)
    r = _run_legend(view, shots)
    assert r["rc"] == 0, r.get("stderr")
    assert not r.get("consoleErrors"), r["consoleErrors"]

    inferno_lo, inferno_hi = [0, 0, 4], [252, 255, 164]  # ramp ends (t=0 / t=1)
    alpha = 0.7  # the batched point path's fill alpha (< 20k points)

    def _blend(c, bg):  # a point bin composites ONCE over the background
        return [alpha * ci + (1 - alpha) * bi for ci, bi in zip(c, bg)]

    for mode in ("light", "dark"):
        s = r[mode]
        # the cloud rendered in the inferno ramp: max blob at the hot end,
        # min blob at the dark end (colours composite over the theme surface)
        assert _close(s["blobMax"], _blend(inferno_hi, s["bg"]), tol=12), (mode, s)
        assert _close(s["blobMin"], _blend(inferno_lo, s["bg"]), tol=12), (mode, s)
        # CLAMP: the below-range blob paints exactly like the min blob
        assert _close(s["blobClamped"], s["blobMin"], tol=10), (mode, s)
        assert not _close(s["blobClamped"], s["blobMax"]), (mode, s)
        # legend: the points layer wears its duck-typed NAME + the clamped range
        pts_hdr = [h for h in s["headers"] if "Top Dome" in h]
        assert pts_hdr, (mode, s["headers"])
        scale = s["scales"][0]
        assert _num(scale[0]) == -2700.0 and _num(scale[1]) == -2500.0, (mode, s["scales"])
        # the geometry layer's name appears as a key row, with type icons drawn
        assert any("Dome grid" in k for k in s["keys"]), (mode, s["keys"])
        assert s["icons"] >= 2, (mode, s)  # points block icon + lines row icon
        # the colormap selector initialized from the payload
        assert s["colormap"] == "inferno", (mode, s["colormap"])
    assert r["dark"]["theme"] == "dark", r["dark"]
    print(f"\n[legend] blobs max/min/clamped (light) = {r['light']['blobMax']}/"
          f"{r['light']['blobMin']}/{r['light']['blobClamped']} | "
          f"headers = {r['light']['headers']} | keys = {r['light']['keys']}")


# --- 2-D click-to-inspect: hover shows nothing, click reveals/dismisses --------
# Drives the owner-ruled interaction semantics on the Map tab end to end: HOVER
# shows nothing; a still CLICK on a point blob reveals the readout ANCHORED at
# the clicked location and it persists through plain mouse movement; clicking
# empty space (or the same target again) dismisses it; a moved press is a pan,
# never an inspect.
_INSPECT_JS = Path(__file__).parent / "viewer_perf" / "inspect_bench.mjs"


@pytest.mark.skipif(not _HAVE_PW, reason="playwright + chromium not available (browser leg)")
def test_map_click_inspect_hover_shows_nothing(tmp_path):
    view, payload = _build_inferno_points_view(tmp_path)
    out = subprocess.run(
        [_NODE, str(_INSPECT_JS), str(view),
         f"--blob={_BLOB_MAX[0]},{_BLOB_MAX[1]}", "--empty=700,700"],
        capture_output=True, text=True, timeout=120,
    )
    line = (out.stdout.strip().splitlines() or ["{}"])[-1]
    r = json.loads(line) if line.startswith("{") else {}
    assert out.returncode == 0, out.stderr
    assert not r.get("consoleErrors"), r["consoleErrors"]
    # hover shows NOTHING
    assert r["afterHover"]["hidden"] is True, r["afterHover"]
    # a still click reveals the readout, anchored at the clicked location, with
    # the dataset name + coordinates
    ac = r["afterClick"]
    assert ac["hidden"] is False, ac
    assert "Top Dome" in ac["text"] and "x" in ac["text"] and "z" in ac["text"], ac
    assert abs(ac["left"] - r["anchor"]["left"]) < 2 and abs(ac["top"] - r["anchor"]["top"]) < 2, (ac, r["anchor"])
    # it persists through plain mouse movement (no hover dismiss)
    assert r["afterMoveAway"]["hidden"] is False, r["afterMoveAway"]
    # empty-space click dismisses; same-target re-click toggles on then off
    assert r["afterEmptyClick"]["hidden"] is True, r["afterEmptyClick"]
    assert r["afterReClick"]["hidden"] is False, r["afterReClick"]
    assert r["afterSameSpot"]["hidden"] is True, r["afterSameSpot"]
    # a moved press pans — it never inspects
    assert r["afterDrag"]["hidden"] is True, r["afterDrag"]
    print(f"\n[inspect] click text = {ac['text']!r} @ ({ac['left']:.0f},{ac['top']:.0f})")


# --- the Scene3D (view3d) tab: smoke + the 200k-point build budget -------------
# Drives the P4 view3d path end to end in a real browser: a scene3d payload
# (points + geometry + a value-coloured surface + a well + contours) must build
# ONE Three.js scene (status hook __PETEK_SCENE3D_STATUS, like the volume tab's
# __PETEK_VOLUME_STATUS), render the per-layer legend with duck-typed names +
# the clamped inferno ramp, apply the z-exaggeration slider + colormap selector
# live, survive orbit/wheel interaction and a theme flip with zero console
# errors — and hold a sane build/first-render budget at 200k points.
_SCENE3D_JS = Path(__file__).parent / "viewer_perf" / "scene3d_bench.mjs"

SCENE3D_POINTS_N = 200_000
SCENE3D_BUILD_CAP_MS = 1500.0   # buildScene3d (decode + colour bake + GPU-object setup)
SCENE3D_TOTAL_CAP_MS = 10000.0  # tab click -> status ok (includes the first WebGL render)


class _S3dPoints:
    name = "Top Dome"

    def __init__(self, n):
        self.n = n

    def xyz(self):
        import random

        rng = random.Random(7)
        return [
            [rng.uniform(0.0, 6000.0), rng.uniform(0.0, 6000.0),
             -2600.0 + rng.uniform(-100.0, 100.0)]
            for _ in range(self.n)
        ]


class _S3dGeom:
    name = "Dome grid"
    xori = 0.0
    yori = 0.0
    xinc = 250.0
    yinc = 250.0
    ncol = 25
    nrow = 25

    def node_xy(self, i, j):
        return (i * 250.0, j * 250.0)


class _S3dSurf:
    name = "Top Dome surf"

    def value_layer(self, attr=None):
        n = 13
        nodes = [[i * 500.0, j * 500.0] for j in range(n) for i in range(n)]
        vals = [-2550.0 - 100.0 * (i % n) / (n - 1) for i in range(n * n)]
        tris = []
        for j in range(n - 1):
            for i in range(n - 1):
                a = j * n + i
                tris.append([a, a + 1, a + n])
                tris.append([a + 1, a + n + 1, a + n])
        return {"name": "z", "nodes": nodes, "triangles": tris,
                "values": vals, "range": [-2650.0, -2550.0]}

    def iso_lines(self, interval=None, levels=None, attr=None):
        return [(-2600.0, [[[0.0, 0.0], [6000.0, 6000.0]]]),
                (-2575.0, [[[0.0, 3000.0], [6000.0, 3000.0]]])]


class _S3dWell:
    name = "31/2-A"

    def trajectory(self):
        return [[1000.0, 1000.0, -2400.0], [2000.0, 2000.0, -2550.0],
                [3000.0, 3000.0, -2650.0]]


def _build_scene3d_view(tmp_path: Path, name: str, npts: int, **kw) -> tuple[Path, dict]:
    from petektools import viewer

    payload = viewer.view3d_payload(
        [_S3dPoints(npts), _S3dGeom(), _S3dSurf(), _S3dWell()],
        color="inferno_-2700_-2500", fill=True, contours=25.0, **kw,
    )
    out = tmp_path / name
    save_view(payload, out)
    return out, payload


def _run_scene3d(view: Path, *extra: str, timeout: int = 240) -> dict:
    out = subprocess.run(
        [_NODE, str(_SCENE3D_JS), str(view), *extra],
        capture_output=True, text=True, timeout=timeout,
    )
    line = (out.stdout.strip().splitlines() or ["{}"])[-1]
    data = json.loads(line) if line.startswith("{") else {}
    return {"rc": out.returncode, "stderr": out.stderr, **data}


@pytest.mark.skipif(not _HAVE_PW, reason="playwright + chromium not available (browser leg)")
def test_scene3d_smoke_renders_all_layer_kinds(tmp_path):
    shots = Path(os.environ.get("PETEK_SHOTS_DIR", str(tmp_path)))
    shots.mkdir(parents=True, exist_ok=True)
    view, payload = _build_scene3d_view(tmp_path, "scene3d_smoke.html", 5000)
    # payload-side sanity: the scene3d bundle carries every layer kind
    sc = payload["scene3d"]
    assert sc["colormap"] == "inferno"
    assert sc["point_color"] == {"by": "z", "range": [-2700.0, -2500.0]}
    assert sc["meshes"] and sc["lattices"] and sc["wells"] and sc["contours"]

    r = _run_scene3d(view, f"--screenshot={shots / 'scene3d-smoke.png'}")
    print(f"\n[scene3d] smoke: build {r.get('status', {}).get('buildMs')} ms | "
          f"render {r.get('renderMs')} ms | badge {r.get('badge')!r}")
    assert r["rc"] == 0, r.get("failure") or r.get("stderr")
    assert not r.get("consoleErrors"), r["consoleErrors"]
    st = r["status"]
    assert st["state"] == "ok" and st["points"] == 5000
    assert st["meshes"] == 1 and st["wells"] == 1 and st["triangles"] > 0
    # legend: per-layer entries with duck-typed names — the value-coloured
    # points ("Top Dome · z") and surface ramps + the lattice/well/contour keys
    lg = r["lightLegend"]
    assert any("Top Dome · z" in h for h in lg["headers"]), lg["headers"]
    assert any("Top Dome surf" in h for h in lg["headers"]), lg["headers"]
    assert any("Dome grid" in k for k in lg["keys"]), lg["keys"]
    assert any("31/2-A" in k for k in lg["keys"]), lg["keys"]
    assert lg["icons"] >= 4  # points + fill ramps, lattice, contours, well rows
    # the points ramp scale shows the CLAMPED spec range
    assert any(_num(s[0]) == -2700.0 and _num(s[1]) == -2500.0 for s in lg["scales"]), lg["scales"]
    # panel: colormap selector initialized from the payload; z-exag applies live
    assert r["colormapInitial"] == "inferno"
    assert "z ×12" in (r["badgeAfterExag"] or ""), r["badgeAfterExag"]
    # dark theme keeps the legend populated (tokens re-read, identities keep slots)
    assert r["darkLegend"]["headers"], r["darkLegend"]
    # click-to-inspect: hover (and an orbit drag) shows NOTHING; a clean click
    # picks an object, shows the readout, and re-targets the orbit pivot to the
    # picked point WITHOUT moving the camera; an empty-space click dismisses the
    # readout but keeps the pivot.
    assert r["hoverReadout"] is False
    ck = r["click"]
    assert ck["readout"] is True, ck
    pick = ck["pick"]
    assert pick and not pick.get("miss"), ck
    assert all(abs(t - p) < 1e-6 for t, p in zip(pick["target"], pick["point"])), pick
    assert all(abs(a - b) < 1e-9 for a, b in zip(pick["camera"], pick["cameraBefore"])), pick
    assert ck["dismissReadout"] is False, ck
    assert ck["dismissPick"] and ck["dismissPick"].get("miss") is True, ck
    assert ck["dismissPick"]["target"] == pick["target"], ck  # pivot kept


@pytest.mark.skipif(not _HAVE_PW, reason="playwright + chromium not available (browser leg)")
def test_scene3d_200k_points_build_and_render_budget(tmp_path):
    view, payload = _build_scene3d_view(tmp_path, "scene3d_200k.html", SCENE3D_POINTS_N)
    cloud = payload["scene3d"]["points"][0]
    assert cloud["n"] == SCENE3D_POINTS_N  # at the cap, undecimated
    assert "point_stride" not in payload["summary"]

    r = _run_scene3d(view, f"--build-cap-ms={SCENE3D_BUILD_CAP_MS}",
                     f"--total-cap-ms={SCENE3D_TOTAL_CAP_MS}")
    st = r.get("status") or {}
    print(f"\n[scene3d] 200k: build {st.get('buildMs')} ms | tab->ok {r.get('totalMs')} ms | "
          f"render {r.get('renderMs')} ms | {st.get('points')} pts + {st.get('triangles')} tris")
    assert r["rc"] == 0, r.get("failure") or r.get("stderr")
    assert not r.get("consoleErrors"), r["consoleErrors"]
    assert st["state"] == "ok" and st["points"] == SCENE3D_POINTS_N
    assert st["buildMs"] < SCENE3D_BUILD_CAP_MS
    assert r["totalMs"] < SCENE3D_TOTAL_CAP_MS


@pytest.mark.skipif(not _HAVE_PW, reason="playwright + chromium not available (browser leg)")
def test_scene3d_auto_degrades_over_budget(tmp_path):
    # Lower the primitive budget below the fixture so the volume tab's degrade
    # discipline MUST engage: a decimated 1-in-stride preview + a loud banner +
    # a 1:stride badge — never a refusal or a blank canvas.
    view, _payload = _build_scene3d_view(tmp_path, "scene3d_degrade.html", 5000)
    r = _run_scene3d(view, "--tri-budget=1000", "--expect-degraded")
    st = r.get("status") or {}
    print(f"\n[scene3d] degrade @1000: kept {st.get('points')} pts + {st.get('triangles')} tris "
          f"| badge {r.get('badge')!r}")
    assert r["rc"] == 0, r.get("failure") or r.get("stderr")
    assert not r.get("consoleErrors"), r["consoleErrors"]
    assert r["degradedBanner"] and "Decimated preview" in r["degradedBanner"]
    assert "1:" in (r["badge"] or "")
    assert 0 < st["points"] <= 1000  # the point cloud really decimated


# --- 2-D map binary blocks: wire size + Node decode + content-addressed dedup --
# The 2-D map's bulk arrays (points, fill nodes/triangles/values, grid_lines and
# contour lines) historically shipped as JSON floats — a single 78k-triangle fill
# is ~5-6 MB of JSON parsed on the main thread. The blocks encoding packs them as
# the v3 typed binary blocks (base64 f32/u32) in a content-addressed digest table
# so an identical array ships once, and the viewer decodes them off the main
# thread into typed arrays. These legs assert the wire-size win, the Node decode
# budget, and the dedup, all without a browser (the Node kernel is decode.js).
import copy

_MAP_BENCH_JS = Path(__file__).parent / "viewer_perf" / "map_decode_bench.js"

MAP_POINTS_N = 200_000
MAP_FILL_GRID = 198  # 198x198 nodes -> 197*197*2 = 77,618 triangles (~78k)
MAP_WIRE_MIN_RATIO = 3.0     # blocks must be >= 3x smaller than the JSON floats
MAP_DECODE_MS_MAX = 300.0    # Node decode of the ~200k-pt + 78k-tri block table


def _synthetic_2d_map(*, npts: int = MAP_POINTS_N, grid: int = MAP_FILL_GRID) -> dict:
    """A synthetic (pure-code) view2d `map` bundle in the PLAIN (JSON) shape: a
    `npts` point cloud + one value-coloured trimesh fill of ~78k triangles, a few
    grid lines and a contour set. `_blocks.encode_map` turns it into blocks."""
    import random

    rng = random.Random(7)
    w = 5000.0
    pts = []
    for _ in range(npts):
        x, y = rng.uniform(0, w), rng.uniform(0, w)
        z = -2600.0 + 40.0 * (x / w) - 30.0 * (y / w) ** 2
        # full-precision floats — the real view2d wire (no rounding), which is
        # exactly where JSON floats balloon and the typed blocks win.
        pts.append([x, y, z])
    zs = [p[2] for p in pts]
    nodes, values = [], []
    for j in range(grid):
        for i in range(grid):
            nodes.append([i * 25.0, j * 25.0])
            values.append(0.1 + 0.2 * math.sin(i / 10.0) * math.cos(j / 10.0))
    tris = []
    for j in range(grid - 1):
        for i in range(grid - 1):
            a = j * grid + i
            tris.append([a, a + 1, a + grid])
            tris.append([a + 1, a + grid + 1, a + grid])
    fill = {"name": "phi", "display_name": "phi", "nodes": nodes,
            "triangles": tris, "values": values, "range": [0.0, 0.4]}
    grid_lines = [[[0.0, c * 250.0], [w, c * 250.0]] for c in range(20)]
    contours = [{"level": -2600.0, "major": True,
                 "lines": [[[0.0, 0.0], [w, w]], [[0.0, w], [w, 0.0]]]}]
    return {
        "schema_version": 2,
        "frame": {"origin_x": 0, "origin_y": 0, "spacing_x": 25, "spacing_y": 25,
                  "ncol": grid, "nrow": grid},
        "outline": [[[0, 0], [w, 0], [w, w], [0, w], [0, 0]]],
        "grid_lines": grid_lines, "points": pts,
        "point_color": {"by": "z", "range": [min(zs), max(zs)]},
        "colormap": "viridis", "layers": [], "fills": [fill], "contours": contours,
        "horizons": [], "zone_averages": [], "k_slices": [], "contacts": [], "wells": [],
    }


def test_map_blocks_wire_size_beats_json():
    from petektools.viewer import _blocks

    plain = _synthetic_2d_map()
    json_bytes = len(json.dumps(plain))
    blocks = copy.deepcopy(plain)
    encoded = _blocks.encode_map(blocks, threshold_bytes=0)
    blocks_bytes = len(json.dumps(blocks))
    ratio = json_bytes / blocks_bytes
    print(f"\n[map-wire] 200k pts + 78k-tri fill: JSON {json_bytes/1e6:.1f} MB -> "
          f"blocks {blocks_bytes/1e6:.1f} MB = {ratio:.2f}x smaller "
          f"({len(blocks['blocks'])} table entries)")
    assert encoded and "blocks" in blocks
    assert ratio >= MAP_WIRE_MIN_RATIO, f"{ratio:.2f}x < {MAP_WIRE_MIN_RATIO}x"


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_map_blocks_decode_under_node(tmp_path):
    from petektools.viewer import _blocks

    blocks = _synthetic_2d_map()
    _blocks.encode_map(blocks, threshold_bytes=0)
    path = tmp_path / "map_blocks.json"
    path.write_text(json.dumps(blocks))
    out = subprocess.run([_NODE, str(_MAP_BENCH_JS), str(path), "3"],
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    r = json.loads(out.stdout.strip().splitlines()[-1])
    print(f"\n[map-decode] decode {r['decodeMs']} ms | {r['tableEntries']} blocks | "
          f"{r['elements']} elements | wire {path.stat().st_size/1e6:.1f} MB")
    assert r["tableEntries"] > 0 and r["elements"] > 0
    assert r["decodeMs"] < MAP_DECODE_MS_MAX, r


def test_map_blocks_dedup_shared_mesh_ships_once():
    from petektools.viewer import _blocks

    # Two fills over the SAME mesh (identical nodes + triangles) but distinct
    # values — the classic dedup case: the geometry blocks must ship once.
    grid = 40
    nodes = [[i * 25.0, j * 25.0] for j in range(grid) for i in range(grid)]
    tris = []
    for j in range(grid - 1):
        for i in range(grid - 1):
            a = j * grid + i
            tris.append([a, a + 1, a + grid])
            tris.append([a + 1, a + grid + 1, a + grid])
    n = len(nodes)
    fill_a = {"name": "phi", "display_name": "phi", "nodes": [list(p) for p in nodes],
              "triangles": [list(t) for t in tris], "values": [0.1] * n, "range": [0.0, 1.0]}
    fill_b = {"name": "sw", "display_name": "sw", "nodes": [list(p) for p in nodes],
              "triangles": [list(t) for t in tris], "values": [0.9] * n, "range": [0.0, 1.0]}
    m = {"schema_version": 2, "frame": {"origin_x": 0, "origin_y": 0, "spacing_x": 25,
         "spacing_y": 25, "ncol": grid, "nrow": grid},
         "outline": [], "grid_lines": [], "points": [], "point_color": None,
         "colormap": None, "layers": [], "fills": [fill_a, fill_b], "contours": [],
         "horizons": [], "zone_averages": [], "k_slices": [], "contacts": [], "wells": []}
    assert _blocks.encode_map(m, threshold_bytes=0)
    f0, f1 = m["fills"]
    # shared geometry -> one digest referenced by both fills (ships once)
    assert f0["nodes"]["__block__"] == f1["nodes"]["__block__"]
    assert f0["triangles"]["__block__"] == f1["triangles"]["__block__"]
    # distinct value arrays keep distinct digests (not falsely merged)
    assert f0["values"]["__block__"] != f1["values"]["__block__"]
    # the table carries each distinct block exactly once: nodes + triangles +
    # two value blocks = 4 entries (no duplicated geometry)
    table = m["blocks"]
    assert f0["nodes"]["__block__"] in table and f0["triangles"]["__block__"] in table
    assert len(table) == 4, sorted(table)
    print(f"\n[map-dedup] 2 fills / shared mesh -> {len(table)} blocks "
          f"(nodes+tris shared, 2 distinct value blocks)")


class _StridedMesh:
    """A synthetic trimesh producer whose `value_layer(stride=)` returns a
    coarser `stride`-decimated grid (≈ the petekio LOD seam), for a browserless
    measure of the stride-ladder coarse ring's cost."""

    def __init__(self, n: int):
        self.n = n

    @staticmethod
    def _grid(n: int):
        nodes = [[i * 25.0, j * 25.0] for j in range(n) for i in range(n)]
        values = [0.1 + 0.2 * math.sin(i / 10.0) * math.cos(j / 10.0)
                  for j in range(n) for i in range(n)]
        tris = []
        for j in range(n - 1):
            for i in range(n - 1):
                a = j * n + i
                tris.append([a, a + 1, a + n])
                tris.append([a + 1, a + n + 1, a + n])
        return nodes, tris, values

    def xyz(self):
        return [[nd[0], nd[1], 0.0] for nd in self._grid(self.n)[0]]

    def triangles(self):
        return self._grid(self.n)[1]

    def value_layer(self, attr=None, stride=None):
        n = self.n if not stride or stride <= 1 else (self.n + stride - 1) // stride
        nodes, tris, values = self._grid(n)
        return {"name": "phi", "nodes": nodes, "triangles": tris,
                "values": values, "range": [0.0, 0.4]}


def test_map_lod_coarse_ring_shrinks_wire():
    """The stride-4 coarse fill ring carries ≈k² fewer triangles and encodes to a
    small fraction of the full ring's block bytes — the win the viewer trades a
    few pixels of detail for when a data cell shrinks below ~4 px."""
    from petektools.viewer import view2d_payload

    mesh = _StridedMesh(MAP_FILL_GRID)  # 198×198 nodes → ~78k triangles
    p = view2d_payload([mesh], fill=True, lod=(4,), encoding="json")
    fill = p["map"]["fills"][0]
    full_tris = len(fill["triangles"])
    coarse_tris = len(fill["lod"]["triangles"])
    ratio = full_tris / max(1, coarse_tris)

    enc = view2d_payload([mesh], fill=True, lod=(4,), encoding="blocks",
                         block_threshold_bytes=0)
    m = enc["map"]
    tbl = m["blocks"]

    def blk_bytes(marker):
        return len(tbl[marker["__block__"]]["data"])

    full_b = blk_bytes(m["fills"][0]["nodes"]) + blk_bytes(m["fills"][0]["triangles"]) \
        + blk_bytes(m["fills"][0]["values"])
    lod = m["fills"][0]["lod"]
    coarse_b = blk_bytes(lod["nodes"]) + blk_bytes(lod["triangles"]) + blk_bytes(lod["values"])
    print(f"\n[map-lod] full {full_tris} tris / coarse {coarse_tris} tris = {ratio:.1f}x "
          f"fewer | full ring {full_b/1e6:.2f} MB(b64) -> coarse {coarse_b/1e3:.0f} KB "
          f"= {full_b/max(1,coarse_b):.0f}x smaller")
    assert ratio >= 8.0, f"coarse ring only {ratio:.1f}x fewer triangles"
    assert coarse_b * 8 < full_b, "coarse ring block bytes not materially smaller"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q", "-s"]))
