"""Generic 2-D viewer payloads.

This module is deliberately domain-agnostic. It accepts plain coordinate
sequences plus duck-typed objects from producer libraries: a point object may
offer ``xyz()``/``xy()``, a geometry may offer ``node_xy(i, j)`` with ``ncol`` and
``nrow``, and an outline may offer ``rings()``.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Iterable, Sequence

from ._save import save_view
from ._server import serve


def view2d_payload(
    items: Any,
    *,
    title: str = "2D view",
    max_grid_lines: int = 800,
    max_line_points: int = 1000,
    point_limit: int | None = 200_000,
) -> dict[str, Any]:
    """Build a generic 2-D map payload from points, geometries, and outlines.

    ``items`` is normally a list such as ``[points, geometry]``. The accepted
    object conventions are intentionally tiny:

    - points: ``xyz()``/``xy()`` or a sequence of ``[x, y]``/``[x, y, z]`` rows
    - geometry: ``node_xy(i, j)``, ``ncol``, ``nrow`` and optional ``edge``
    - outline: ``rings()`` returning rings of ``[x, y]`` or ``[x, y, z]`` rows
    """
    scene_items = _scene_items(items)
    points: list[list[float]] = []
    grid_lines: list[list[list[float]]] = []
    outlines: list[list[list[float]]] = []
    frame = None
    summary: dict[str, Any] = {}

    for item in scene_items:
        if _is_geometry(item):
            frame = _frame_from_geometry(item)
            grid_lines.extend(_grid_lines(item, max_grid_lines, max_line_points))
            edge = getattr(item, "edge", None)
            if edge is not None:
                outlines.extend(_rings(edge))
            summary["grid"] = f"{int(getattr(item, 'ncol'))} x {int(getattr(item, 'nrow'))}"
            rot = getattr(item, "rotation_deg", None)
            if rot is not None:
                summary["rotation_deg"] = float(rot)
            continue

        rings = _rings(item)
        if rings:
            outlines.extend(rings)
            continue

        pts = _points(item)
        if pts:
            if point_limit is not None and len(pts) > point_limit:
                step = max(1, math.ceil(len(pts) / point_limit))
                pts = pts[::step]
                summary["point_stride"] = step
            points.extend(pts)
            continue

        raise TypeError(f"cannot add {type(item).__name__} to a 2D view")

    if frame is None:
        frame = _frame_from_extent(_extent(points, grid_lines, outlines))
    if not outlines:
        outlines = _rect_outline_from_frame(frame)

    summary["points"] = len(points)
    summary["grid_lines"] = len(grid_lines)
    summary["outlines"] = len(outlines)

    return {
        "schema_version": 4,
        "kind": "2D",
        "property": title,
        "properties": [],
        "summary": summary,
        "volume": None,
        "map": {
            "schema_version": 2,
            "frame": frame,
            "outline": outlines,
            "grid_lines": grid_lines,
            "points": points,
            "horizons": [],
            "zone_averages": [],
            "k_slices": [],
            "contacts": [],
            "wells": [],
        },
        "sections": [],
        "section_labels": [],
        "wells": [],
        "charts": [],
    }


def view2d(
    items: Any,
    *,
    title: str = "2D view",
    save: str | Path | None = None,
    port: int = 0,
    block: bool = False,
    open_browser: bool = True,
    max_grid_lines: int = 800,
    max_line_points: int = 1000,
    point_limit: int | None = 200_000,
) -> str | dict[str, Any]:
    """Open or save a generic 2-D map view.

    Returns the local server URL in live mode, the written path when ``save=`` is
    supplied, or the payload when ``open_browser=False`` and ``block=False`` is
    still served by the caller through ``view2d_payload`` directly.
    """
    payload = view2d_payload(
        items,
        title=title,
        max_grid_lines=max_grid_lines,
        max_line_points=max_line_points,
        point_limit=point_limit,
    )
    if save is not None:
        save_view(payload, save)
        return str(save)
    return serve(payload, port=port, block=block, open_browser=open_browser)


def _scene_items(items: Any) -> list[Any]:
    if isinstance(items, (str, bytes)):
        return [items]
    if _is_point_row(items):
        return [items]
    if _looks_like_point_cloud(items):
        return [items]
    if isinstance(items, Iterable) and not _is_geometry(items) and not hasattr(items, "rings"):
        return list(items)
    return [items]


def _is_geometry(obj: Any) -> bool:
    return hasattr(obj, "node_xy") and hasattr(obj, "ncol") and hasattr(obj, "nrow")


def _frame_from_geometry(geom: Any) -> dict[str, float | int]:
    return {
        "origin_x": float(getattr(geom, "xori", 0.0)),
        "origin_y": float(getattr(geom, "yori", 0.0)),
        "spacing_x": float(getattr(geom, "xinc", 1.0)),
        "spacing_y": float(getattr(geom, "yinc", 1.0)),
        "ncol": int(getattr(geom, "ncol")),
        "nrow": int(getattr(geom, "nrow")),
    }


def _frame_from_extent(extent: tuple[float, float, float, float]) -> dict[str, float | int]:
    xmin, ymin, xmax, ymax = extent
    if not all(math.isfinite(v) for v in extent):
        xmin = ymin = 0.0
        xmax = ymax = 1.0
    dx = xmax - xmin
    dy = ymax - ymin
    if abs(dx) < 1e-12:
        dx = 1.0
    if abs(dy) < 1e-12:
        dy = 1.0
    return {
        "origin_x": xmin,
        "origin_y": ymin,
        "spacing_x": dx,
        "spacing_y": dy,
        "ncol": 2,
        "nrow": 2,
    }


def _grid_lines(geom: Any, max_lines: int, max_line_points: int) -> list[list[list[float]]]:
    ncol = int(getattr(geom, "ncol"))
    nrow = int(getattr(geom, "nrow"))
    if ncol <= 0 or nrow <= 0:
        return []
    line_stride = max(1, math.ceil((ncol + nrow) / max(1, max_lines)))
    i_vals = _sampled_indices(ncol, line_stride)
    j_vals = _sampled_indices(nrow, line_stride)
    i_points = _sampled_indices(ncol, max(1, math.ceil(ncol / max(2, max_line_points))))
    j_points = _sampled_indices(nrow, max(1, math.ceil(nrow / max(2, max_line_points))))

    lines: list[list[list[float]]] = []
    for j in j_vals:
        lines.append([_xy(geom.node_xy(i, j)) for i in i_points])
    for i in i_vals:
        lines.append([_xy(geom.node_xy(i, j)) for j in j_points])
    return lines


def _sampled_indices(n: int, stride: int) -> list[int]:
    vals = list(range(0, n, max(1, stride)))
    if n > 0 and vals[-1] != n - 1:
        vals.append(n - 1)
    return vals


def _points(obj: Any) -> list[list[float]]:
    if hasattr(obj, "xyz"):
        rows = obj.xyz()
    elif hasattr(obj, "xy"):
        rows = obj.xy()
    else:
        rows = obj
    if not isinstance(rows, Iterable) or isinstance(rows, (str, bytes)):
        return []
    out: list[list[float]] = []
    for row in rows:
        if not _is_point_row(row):
            return []
        vals = list(row)
        out.append([float(vals[0]), float(vals[1]), float(vals[2]) if len(vals) > 2 else math.nan])
    return out


def _rings(obj: Any) -> list[list[list[float]]]:
    if hasattr(obj, "rings"):
        rows = obj.rings()
    else:
        rows = obj
    if not isinstance(rows, Iterable) or isinstance(rows, (str, bytes)):
        return []
    if _looks_like_point_cloud(rows):
        return []
    out: list[list[list[float]]] = []
    for ring in rows:
        if not isinstance(ring, Iterable) or isinstance(ring, (str, bytes)):
            return []
        pts = []
        for v in ring:
            if not _is_point_row(v):
                return []
            pts.append(_xy(v))
        if len(pts) >= 2:
            out.append(pts)
    return out


def _is_point_row(row: Any) -> bool:
    if not isinstance(row, Sequence) or isinstance(row, (str, bytes)):
        return False
    if len(row) < 2:
        return False
    return all(isinstance(row[i], (int, float)) for i in range(min(3, len(row))))


def _looks_like_point_cloud(rows: Any) -> bool:
    if not isinstance(rows, Sequence) or isinstance(rows, (str, bytes)) or not rows:
        return False
    return _is_point_row(rows[0])


def _xy(row: Any) -> list[float]:
    vals = list(row)
    return [float(vals[0]), float(vals[1])]


def _extent(
    points: list[list[float]],
    grid_lines: list[list[list[float]]],
    outlines: list[list[list[float]]],
) -> tuple[float, float, float, float]:
    xs: list[float] = []
    ys: list[float] = []
    for p in points:
        xs.append(p[0])
        ys.append(p[1])
    for line in grid_lines:
        for p in line:
            xs.append(p[0])
            ys.append(p[1])
    for ring in outlines:
        for p in ring:
            xs.append(p[0])
            ys.append(p[1])
    if not xs:
        return (0.0, 0.0, 1.0, 1.0)
    return (min(xs), min(ys), max(xs), max(ys))


def _rect_outline_from_frame(frame: dict[str, float | int]) -> list[list[list[float]]]:
    x0 = float(frame["origin_x"])
    y0 = float(frame["origin_y"])
    x1 = x0 + float(frame["spacing_x"]) * (int(frame["ncol"]) - 1)
    y1 = y0 + float(frame["spacing_y"]) * (int(frame["nrow"]) - 1)
    return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]

