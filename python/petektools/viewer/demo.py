"""A standalone second-consumer demo for the viewer unit.

Renders a **tiny synthetic payload** — a map raster + a section + a corner-point
mesh — through ``petektools.viewer`` with *no* peteksim / petekStatic anywhere.
This is the proof that the renderer is horizontal capability: any consumer that
maps its data onto the generic render schema (``SCHEMA.md``) can drive it.

    python -m petektools.viewer.demo            # write demo_view.html, print path
    python -m petektools.viewer.demo --serve    # open a live server instead

The payload is hand-built here in pure Python — it depends on nothing but the
render schema, exactly as a real domain consumer's bundle-mapping layer would.
"""

from __future__ import annotations

import argparse
import math
import tempfile
from pathlib import Path
from typing import Any, Dict, List

from . import save_view, serve
from ._v3 import build_v3_volume
from ._wells import build_well_log_bundle


def build_demo_payload(ni: int = 6, nj: int = 5, nk: int = 3) -> Dict[str, Any]:
    """Build a minimal but complete render payload: a map (a depth horizon + a
    property zone-average raster + an outline + a contact), one cross-section, and
    a corner-point volume mesh. Pure synthetic data, no domain library."""
    spacing = 100.0
    ox = oy = 0.0

    # A smooth synthetic surface + property field over the (ncol=ni, nrow=nj) grid.
    def depth(i, j):
        return 1500.0 + 30.0 * math.sin(i / 2.0) + 20.0 * math.cos(j / 2.0)

    def poro(i, j):
        return 0.12 + 0.10 * (math.sin(i / 3.0) * math.cos(j / 3.0) + 1) / 2

    horizon_vals: List[float] = [depth(i, j) for j in range(nj) for i in range(ni)]
    poro_vals: List[float] = [poro(i, j) for j in range(nj) for i in range(ni)]
    contact_depth = 1500.0
    crossing = [1490.0 <= horizon_vals[j * ni + i] <= 1510.0 for j in range(nj) for i in range(ni)]

    frame = {
        "origin_x": ox, "origin_y": oy,
        "spacing_x": spacing, "spacing_y": spacing,
        "ncol": ni, "nrow": nj,
    }
    outline = [[
        [ox, oy], [ox + (ni - 1) * spacing, oy],
        [ox + (ni - 1) * spacing, oy + (nj - 1) * spacing],
        [ox, oy + (nj - 1) * spacing], [ox, oy],
    ]]
    demo_map = {
        "schema_version": 1,
        "frame": frame,
        "outline": outline,
        "horizons": [{
            "name": "TopReservoir", "units": "m",
            "values": horizon_vals,
            "range": {"min": min(horizon_vals), "max": max(horizon_vals)},
        }],
        "zone_averages": [{
            "name": "PORO", "units": "fraction",
            "values": poro_vals,
            "range": {"min": min(poro_vals), "max": max(poro_vals)},
        }],
        "k_slices": [],
        "contacts": [{"kind": "OWC", "depth_m": contact_depth, "crossing": crossing}],
        "grid_lines": [],
        "points": [],
        "wells": [],
    }

    # A cross-section along the i-axis at j = nj//2.
    jj = nj // 2
    columns = []
    for i in range(ni):
        top = depth(i, jj)
        thickness = 15.0
        layer_tops, layer_bases, values = [], [], []
        for k in range(nk):
            zt = top + k * (thickness / nk)
            layer_tops.append(zt)
            layer_bases.append(zt + thickness / nk)
            values.append(poro(i, jj) * (1 - 0.1 * k))
        columns.append({
            "distance_m": i * spacing, "i": i, "j": jj,
            "x": ox + i * spacing, "y": oy + jj * spacing,
            "layer_tops": layer_tops, "layer_bases": layer_bases,
            "values": values, "path_z": None,
        })
    section = {
        "schema_version": 1, "property": "PORO",
        "top_name": "TopReservoir", "base_name": "BaseReservoir",
        "columns": columns,
        "contacts": [{"kind": "OWC", "depth_m": contact_depth}],
    }

    # A v3 exterior-shell volume: only the box's boundary faces, deduped verts,
    # binary blocks base64'd into the envelope (the same wire contract the viewer
    # decodes off petekStatic's engine). Self-contained (base64) so the demo file
    # export stays single-file.
    volume, _bin = build_v3_volume(ni, nj, nk, spacing=spacing, dz=15.0, top=1500.0, n_zones=nk)

    return {
        "schema_version": 3,
        "kind": "demo",
        "property": "PORO",
        "properties": ["PORO"],
        "summary": {"source": "petektools.viewer.demo", "cells": ni * nj * nk},
        "volume": volume,
        "map": demo_map,
        "sections": [section],
        "section_labels": ["j-line section"],
        "wells": [],
        "charts": build_demo_charts(),
    }


def build_demo_charts() -> List[Dict[str, Any]]:
    """A tornado, a crossplot and a volume-distribution — one of each analytics
    mark, hand-built as pure synthetic payload (no domain library). Proves the
    generic chart schema renders straight from typed JSON, exactly as a real
    consumer (peteksim) hands it over."""
    base = 42.0  # a deterministic STOIIP (MSm³) the swings anchor on
    tornado = {
        "mark": "tornado",
        "title": "STOIIP tornado",
        "units": "MSm³",
        "base": base,
        "fold_count": 6,
        "bars": [
            # out_lo/out_hi = oil in-place with the input at its low/high pivot;
            # in_lo/in_hi = the pivot input values (hover); out_min/out_max = full span.
            {"param": "net_to_gross", "in_lo": 0.62, "in_hi": 0.88,
             "out_lo": 33.0, "out_hi": 51.0, "out_min": 30.0, "out_max": 54.0, "swing": 18.0},
            {"param": "porosity", "in_lo": 0.19, "in_hi": 0.27,
             "out_lo": 35.0, "out_hi": 49.0, "out_min": 33.5, "out_max": 50.5, "swing": 14.0},
            {"param": "contact_depth", "in_lo": 2738.0, "in_hi": 2748.0,
             "out_lo": 37.5, "out_hi": 46.5, "out_min": 36.0, "out_max": 48.0, "swing": 9.0},
            {"param": "water_saturation", "in_lo": 0.22, "in_hi": 0.34,
             "out_lo": 45.0, "out_hi": 39.0, "out_min": 46.5, "out_max": 37.5, "swing": 6.0},
        ],
    }

    # A poro-perm crossplot: PERM on a log y-axis (petroleum convention), coloured
    # by well identity, with a per-well trend line (coefficients arrive here).
    wells = ["Well-A", "Well-B"]
    points: List[Dict[str, Any]] = []
    for wi, well in enumerate(wells):
        for n in range(40):
            phi = 0.08 + 0.20 * (n / 40.0) + 0.01 * wi
            perm = 10 ** (-2.0 + 14.0 * phi + 0.2 * wi + 0.3 * math.sin(n))
            points.append({"x": round(phi, 4), "y": round(perm, 4), "c": well})
    scatter = {
        "mark": "scatter",
        "title": "PHIE vs PERM",
        "x": {"name": "PHIE", "units": "fraction", "log": False},
        "y": {"name": "PERM", "units": "mD", "log": True},
        "color_by": {"name": "well", "kind": "categorical"},
        "groups": wells,
        "points": points,
        "trends": [
            {"group": "Well-A", "kind": "loglinear", "x0": 0.08, "y0": 10 ** -0.88,
             "x1": 0.28, "y1": 10 ** 1.92, "slope": 14.0, "intercept": -2.0, "r2": 0.94,
             "equation": "log10(PERM) = 14.0·PHIE − 2.0"},
        ],
    }

    # A volume distribution: histogram + exceedance CDF, P90/P50/P10 (reservoir
    # convention). Two series (a structure + the field) proves the overlay.
    def _dist_series(name, centre, spread):
        bins, cdf = [], []
        n = 10
        lo0 = centre - 3 * spread
        for k in range(n):
            lo = lo0 + k * (6 * spread / n)
            hi = lo + (6 * spread / n)
            mid = (lo + hi) / 2
            count = int(300 * math.exp(-((mid - centre) ** 2) / (2 * spread * spread)))
            bins.append({"lo": round(lo, 3), "hi": round(hi, 3), "count": count})
        for k in range(21):
            x = lo0 + k * (6 * spread / 20)
            exc = max(0.0, min(1.0, 1.0 - 0.5 * (1 + math.erf((x - centre) / (spread * math.sqrt(2))))))
            cdf.append({"x": round(x, 3), "exceedance": round(exc, 4)})
        return {
            "name": name, "bins": bins, "cdf": cdf,
            "markers": {"p90": round(centre - 1.28 * spread, 2), "p50": round(centre, 2),
                        "p10": round(centre + 1.28 * spread, 2)},
        }

    distribution = {
        "mark": "distribution",
        "title": "STOIIP distribution",
        "units": "MSm³",
        "series": [_dist_series("Field", 42.0, 6.0), _dist_series("North", 24.0, 4.0)],
    }
    return [tornado, scatter, distribution]


def build_correlation_demo_payload() -> Dict[str, Any]:
    """A payload that exercises the fourth-wave viewer obligations in one export:
    the **Wells** correlation tab (a full ``wells_logs`` bundle), a **Map** whose
    well markers carry tie residuals (the tie-quality glyph), and an **Intersection**
    section carrying v4 ``horizon_traces`` (interior-horizon polylines). Pure
    synthetic data — no domain library, exactly as a producer's mapping layer would
    hand it over."""
    bundle = build_well_log_bundle()

    # Map wells at the bundle's world positions, each carrying its tie residuals so
    # the map draws the tie-quality glyph + lists per-horizon residuals in the panel.
    wells = [
        {"id": w["id"], "display_name": w["display_name"], "x": w["x"], "y": w["y"],
         "trajectory": [[w["x"], w["y"], 1820.0], [w["x"], w["y"], 1950.0]],
         "ties": list(w["ties"])}
        for w in bundle["wells"]
    ]
    xs = [w["x"] for w in wells]
    ys = [w["y"] for w in wells]
    ox, oy = min(xs) - 400, min(ys) - 400
    spacing = 120.0
    ncol = int((max(xs) - ox + 400) / spacing) + 1
    nrow = int((max(ys) - oy + 400) / spacing) + 1

    def depth(i, j):
        return 1820.0 + 0.02 * (i * spacing) - 0.015 * (j * spacing)

    vals = [depth(i, j) for j in range(nrow) for i in range(ncol)]
    demo_map = {
        "schema_version": 1,
        "frame": {"origin_x": ox, "origin_y": oy, "spacing_x": spacing, "spacing_y": spacing,
                  "ncol": ncol, "nrow": nrow},
        "outline": [[[ox, oy], [ox + (ncol - 1) * spacing, oy],
                     [ox + (ncol - 1) * spacing, oy + (nrow - 1) * spacing],
                     [ox, oy + (nrow - 1) * spacing], [ox, oy]]],
        "horizons": [{"name": "TopSand", "units": "m", "values": vals,
                      "range": {"min": min(vals), "max": max(vals)}}],
        "zone_averages": [], "k_slices": [], "contacts": [], "wells": [],
    }

    # A section across three of the wells: three layers (the three zones), the
    # structural top/base traces, and TWO interior-horizon traces (TopShale,
    # TopMixed) parallel to columns. TopShale is null-gapped mid-section to exercise
    # the "column doesn't reach this horizon" gap idiom. The gap is JSON null —
    # exactly what serde makes of the engine's f64::NAN (a Python float("nan")
    # would serialize as a NaN literal, invalid JSON for the served model.json).
    line_wells = bundle["wells"][:3]
    ncols = 24
    columns = []
    topshale_trace, topmixed_trace = [], []
    for c in range(ncols):
        f = c / (ncols - 1)
        x = line_wells[0]["x"] + f * (line_wells[-1]["x"] - line_wells[0]["x"])
        y = line_wells[0]["y"] + f * (line_wells[-1]["y"] - line_wells[0]["y"])
        top = 1849.0 + 8.0 * math.sin(f * math.pi)
        t_sand, t_shale, t_mixed, t_base = top, top + 34, top + 56, top + 96
        columns.append({
            "distance_m": round(f * 1600.0, 2), "i": c, "j": 0, "x": x, "y": y,
            "layer_tops": [t_sand, t_shale, t_mixed],
            "layer_bases": [t_shale, t_mixed, t_base],
            "values": [0.23, 0.09, 0.16], "path_z": None,
        })
        topshale_trace.append(None if 0.4 < f < 0.55 else round(t_shale, 2))
        topmixed_trace.append(round(t_mixed, 2))
    section = {
        "schema_version": 4, "property": "PHIE",
        "top_name": "TopSand", "base_name": "BaseReservoir",
        "columns": columns,
        "horizon_traces": [
            {"name": "TopShale", "depths": topshale_trace},
            {"name": "TopMixed", "depths": topmixed_trace},
        ],
        "contacts": [{"kind": "OWC", "depth_m": 1930.0}],
    }

    return {
        "schema_version": 4,
        "kind": "wells",
        "property": "PHIE",
        "properties": ["PHIE", "SW", "NTG"],
        "summary": {"source": "petektools.viewer.demo (correlation)", "wells": len(wells)},
        "map": demo_map,
        "sections": [section],
        "section_labels": ["3-well correlation line"],
        "wells": wells,
        "wells_logs": bundle,
        "charts": [],
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Render a synthetic payload through petektools.viewer.")
    ap.add_argument("--serve", action="store_true", help="open a live local server instead of writing a file")
    ap.add_argument("--wells", action="store_true", help="render the well-correlation demo (Wells tab + tie glyphs + interior traces)")
    ap.add_argument("--out", default=None, help="output HTML path (default: a temp file)")
    ap.add_argument("--no-browser", action="store_true", help="with --serve, do not auto-open a browser tab")
    args = ap.parse_args(argv)

    payload = build_correlation_demo_payload() if args.wells else build_demo_payload()
    if args.serve:
        url = serve(payload, open_browser=not args.no_browser)
        print(f"serving the demo payload at {url}")
        return 0

    name = "petektools_wells_view.html" if args.wells else "petektools_demo_view.html"
    out = Path(args.out) if args.out else Path(tempfile.gettempdir()) / name
    save_view(payload, out)
    print(f"wrote a self-contained viewer to {out}")
    if args.wells:
        print("open it in a browser (file://) — the Wells correlation tab + Map tie glyphs + section interior traces.")
    else:
        print("open it in a browser (file://) — Map / Intersection / Volume tabs all render.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
