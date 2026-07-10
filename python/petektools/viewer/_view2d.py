"""Generic 2-D viewer payloads.

This module is deliberately domain-agnostic. It accepts plain coordinate
sequences plus duck-typed objects from producer libraries: a point object may
offer ``xyz()``/``xy()``, a geometry may offer ``node_xy(i, j)`` with ``ncol`` and
``nrow``, a triangulated mesh may offer ``triangles()`` with ``xyz()``/``points()``,
and an outline may offer ``rings()``. Two optional value conventions extend
these: ``value_layer(attr=None)`` returns a per-node value-coloured trimesh
(``{"name", "nodes", "triangles", "values", "range"}``; opted in via
``color=``), and ``iso_lines(interval=..., levels=..., attr=None)`` returns
``[(level, [polyline, ...]), ...]`` contour polylines (opted in via
``contours=``).
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
    color: bool | str = False,
    contours: float | list[float] | None = None,
    max_grid_lines: int = 800,
    max_line_points: int = 1000,
    point_limit: int | None = 200_000,
    max_mesh_edges: int | None = 150_000,
) -> dict[str, Any]:
    """Build a generic 2-D map payload from points, geometries, and outlines.

    ``items`` is normally a list such as ``[points, geometry]``. The accepted
    object conventions are intentionally tiny:

    - points: ``xyz()``/``xy()`` or a sequence of ``[x, y]``/``[x, y, z]`` rows
    - geometry: ``node_xy(i, j)``, ``ncol``, ``nrow`` and optional ``edge``
    - trimesh: ``triangles()`` index triples over ``xyz()``/``points()`` vertices,
      with optional ``edge`` — the unique triangle edges render as grid lines; an
      optional ``wireframe_edges()`` (index pairs) overrides the drawn edge set,
      e.g. a quad-dominant wireframe with cell diagonals removed
    - outline: ``rings()`` returning rings of ``[x, y]`` or ``[x, y, z]`` rows
    - value fill (opt-in via ``color=``): ``value_layer(attr=None)`` returning
      ``{"name", "nodes", "triangles", "values", "range"}`` — a per-node
      value-coloured trimesh rendered UNDER the grid lines
    - contour lines (opt-in via ``contours=``): ``iso_lines(interval=...,
      levels=..., attr=None)`` returning ``[(level, [polyline, ...]), ...]``

    ``color=True`` asks every item offering ``value_layer()`` for its primary
    layer; a string asks for that attribute (``value_layer(attr=color)``).
    With ``color`` on, plain points carrying a finite third component are
    colour-coded by it (``map.point_color`` records the z range).
    ``contours=<float>`` requests ``iso_lines(interval=...)``; a list requests
    ``iso_lines(levels=...)``; a string ``color`` is forwarded as ``attr=``.
    Items without these methods are unaffected, and an item that yields a fill
    still contributes its geometry/trimesh lines exactly as before.

    Point objects are rendered as points only. Topology-bearing point sets do
    not imply grid-line rendering; pass a geometry, structured surface, or
    trimesh when the grid itself should be visible.
    """
    scene_items = _scene_items(items)
    points: list[list[float]] = []
    grid_lines: list[list[list[float]]] = []
    outlines: list[list[list[float]]] = []
    fills: list[dict[str, Any]] = []
    contour_sets: list[dict[str, Any]] = []
    frame = None
    summary: dict[str, Any] = {}

    for item in scene_items:
        contributed = False
        if color:
            fill = _value_fill(item, color)
            if fill is not None:
                fills.append(fill)
                contributed = True
        if contours is not None:
            iso = _iso_contours(item, contours, color)
            if iso is not None:
                contour_sets.extend(iso)
                contributed = True

        if _is_geometry(item):
            edge = getattr(item, "edge", None)
            edge_rings = _rings(edge) if edge is not None else []
            grid_lines.extend(
                _grid_lines(
                    item,
                    max_grid_lines,
                    max_line_points,
                    clip_rings=edge_rings,
                )
            )
            if edge is not None:
                outlines.extend(edge_rings)
            summary["grid"] = f"{int(getattr(item, 'ncol'))} x {int(getattr(item, 'nrow'))}"
            rot = getattr(item, "rotation_deg", None)
            if rot is not None:
                summary["rotation_deg"] = float(rot)
            if not edge_rings:
                frame = _frame_from_geometry(item)
            continue

        if _is_trimesh(item):
            edge = getattr(item, "edge", None)
            edge_rings = _rings(edge) if edge is not None else []
            mesh_lines, n_triangles, edge_stride = _mesh_lines(
                item, max_mesh_edges, max_line_points
            )
            grid_lines.extend(mesh_lines)
            outlines.extend(edge_rings)
            summary["triangles"] = n_triangles
            if edge_stride > 1:
                summary["mesh_edge_stride"] = edge_stride
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

        if contributed:
            continue  # a fill/contour-only item carries no further geometry

        raise TypeError(f"cannot add {type(item).__name__} to a 2D view")

    if frame is None:
        frame = _frame_from_extent(_extent(points, grid_lines, outlines))
    if not outlines:
        outlines = _rect_outline_from_frame(frame)

    point_color = None
    if color:
        zs = [p[2] for p in points if len(p) > 2 and math.isfinite(p[2])]
        if zs:
            point_color = {"by": "z", "range": [min(zs), max(zs)]}

    summary["points"] = len(points)
    summary["grid_lines"] = len(grid_lines)
    summary["outlines"] = len(outlines)
    if fills:
        summary["fills"] = len(fills)
    if contour_sets:
        summary["contour_levels"] = len(contour_sets)
    if point_color is not None:
        summary["point_color"] = point_color["by"]

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
            "point_color": point_color,
            "fills": fills,
            "contours": contour_sets,
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
    color: bool | str = False,
    contours: float | list[float] | None = None,
    save: str | Path | None = None,
    port: int = 0,
    block: bool = False,
    open_browser: bool = True,
    max_grid_lines: int = 800,
    max_line_points: int = 1000,
    point_limit: int | None = 200_000,
    max_mesh_edges: int | None = 150_000,
) -> str | dict[str, Any]:
    """Open or save a generic 2-D map view.

    ``color=`` / ``contours=`` opt items into value-coloured fills and contour
    lines (see :func:`view2d_payload`). Returns the local server URL in live
    mode, the written path when ``save=`` is supplied, or the payload when
    ``open_browser=False`` and ``block=False`` is still served by the caller
    through ``view2d_payload`` directly.
    """
    payload = view2d_payload(
        items,
        title=title,
        color=color,
        contours=contours,
        max_grid_lines=max_grid_lines,
        max_line_points=max_line_points,
        point_limit=point_limit,
        max_mesh_edges=max_mesh_edges,
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
    if (
        isinstance(items, Iterable)
        and not _is_geometry(items)
        and not _is_trimesh(items)
        and not hasattr(items, "rings")
    ):
        return list(items)
    return [items]


def _is_geometry(obj: Any) -> bool:
    return hasattr(obj, "node_xy") and hasattr(obj, "ncol") and hasattr(obj, "nrow")


def _value_fill(item: Any, color: bool | str) -> dict[str, Any] | None:
    """One value-coloured trimesh fill from an item's ``value_layer()`` duck.

    ``color=True`` asks for the primary layer; a string asks for that attribute.
    Returns ``None`` when the item does not offer the method (silently — the
    fill is opt-in per item); raises ``TypeError`` on a malformed layer.
    """
    fn = getattr(item, "value_layer", None)
    if not callable(fn):
        return None
    layer = fn(attr=color) if isinstance(color, str) else fn()
    if layer is None:
        return None
    name = type(item).__name__
    if not isinstance(layer, dict):
        raise TypeError(
            f"value_layer() on {name} must return a dict, got {type(layer).__name__}"
        )
    missing = [k for k in ("name", "nodes", "triangles", "values", "range") if k not in layer]
    if missing:
        raise TypeError(f"value_layer() on {name} is missing key(s) {missing}")
    nodes = [_xy(n) for n in layer["nodes"]]
    values = [
        float(v) if v is not None and math.isfinite(float(v)) else None
        for v in layer["values"]
    ]
    if len(values) != len(nodes):
        raise TypeError(
            f"value_layer() on {name}: {len(values)} values for {len(nodes)} nodes"
        )
    triangles = [[int(t[0]), int(t[1]), int(t[2])] for t in layer["triangles"]]
    rng = list(layer["range"])
    if len(rng) != 2:
        raise TypeError(f"value_layer() on {name}: range must be [min, max], got {rng!r}")
    return {
        "name": str(layer["name"]),
        "nodes": nodes,
        "triangles": triangles,
        "values": values,
        "range": [float(rng[0]), float(rng[1])],
    }


def _iso_contours(
    item: Any, contours: float | list[float], color: bool | str
) -> list[dict[str, Any]] | None:
    """Contour sets from an item's ``iso_lines()`` duck.

    A float ``contours`` requests ``iso_lines(interval=...)``, a list requests
    ``iso_lines(levels=...)``; a string ``color`` forwards as ``attr=``. In
    interval mode, index levels — multiples of the round step nearest 4-5x the
    interval — are flagged ``major`` and render bolder (explicit level lists
    carry no majors). Returns ``None`` when the item does not offer the method;
    raises ``TypeError`` on a malformed result (each entry must be
    ``(level, [polyline, ...])``).
    """
    fn = getattr(item, "iso_lines", None)
    if not callable(fn):
        return None
    kwargs: dict[str, Any] = {}
    major_step = None
    if isinstance(contours, (int, float)) and not isinstance(contours, bool):
        kwargs["interval"] = float(contours)
        major_step = _major_step(float(contours))
    else:
        kwargs["levels"] = [float(v) for v in contours]
    if isinstance(color, str):
        kwargs["attr"] = color
    name = type(item).__name__
    out: list[dict[str, Any]] = []
    for entry in fn(**kwargs):
        try:
            level, lines = entry
        except (TypeError, ValueError):
            raise TypeError(
                f"iso_lines() on {name} must yield (level, [polyline, ...]) pairs, "
                f"got {entry!r}"
            ) from None
        level = float(level)
        major = (
            major_step is not None
            and abs(level / major_step - round(level / major_step)) < 1e-6
        )
        out.append(
            {
                "level": level,
                "major": major,
                "lines": [[_xy(p) for p in line] for line in lines],
            }
        )
    return out


def _major_step(interval: float) -> float:
    """The index-contour step: the first of 4x/5x the interval that lands on a
    round number (mantissa 1, 2, 2.5, or 5), falling back to 5x."""
    for k in (4, 5):
        step = interval * k
        exponent = math.floor(math.log10(step))
        mantissa = step / 10**exponent
        if any(abs(mantissa - m) < 1e-9 for m in (1.0, 2.0, 2.5, 5.0)):
            return step
    return interval * 5


def _is_trimesh(obj: Any) -> bool:
    return hasattr(obj, "triangles") and (hasattr(obj, "xyz") or hasattr(obj, "points"))


def _mesh_lines(
    mesh: Any,
    max_edges: int | None,
    max_line_points: int,
) -> tuple[list[list[list[float]]], int, int]:
    """Mesh edges as polylines, plus (triangle count, edge stride).

    A mesh offering ``wireframe_edges()`` (index pairs) draws exactly those —
    typically the quad-dominant wireframe with cell diagonals removed;
    otherwise the unique triangle edges are derived from ``triangles()``.
    """
    verts = mesh.xyz() if hasattr(mesh, "xyz") else mesh.points()
    tris = list(mesh.triangles())
    n_triangles = len(tris)
    edges: set[tuple[int, int]] = set()
    wireframe = getattr(mesh, "wireframe_edges", None)
    if callable(wireframe):
        for pair in wireframe():
            u, v = int(pair[0]), int(pair[1])
            edges.add((u, v) if u < v else (v, u))
    if not edges:
        for tri in tris:
            a, b, c = int(tri[0]), int(tri[1]), int(tri[2])
            for u, v in ((a, b), (b, c), (c, a)):
                edges.add((u, v) if u < v else (v, u))
    edge_list = sorted(edges)
    stride = 1
    if max_edges is not None and len(edge_list) > max_edges:
        stride = math.ceil(len(edge_list) / max_edges)
        edge_list = edge_list[::stride]
    return _chain_edges(edge_list, verts, max_line_points), n_triangles, stride


def _chain_edges(
    edge_list: list[tuple[int, int]],
    verts: Sequence[Any],
    max_line_points: int,
) -> list[list[list[float]]]:
    """Greedily chain shared-vertex edges into polylines (each edge drawn once)."""
    neighbors: dict[int, list[int]] = {}
    for u, v in edge_list:
        neighbors.setdefault(u, []).append(v)
        neighbors.setdefault(v, []).append(u)
    used: set[tuple[int, int]] = set()
    cap = max(2, max_line_points)
    lines: list[list[list[float]]] = []
    for u0, v0 in edge_list:
        if (u0, v0) in used:
            continue
        used.add((u0, v0))
        path = [u0, v0]
        tail = v0
        while len(path) < cap:
            step = None
            for w in neighbors[tail]:
                key = (tail, w) if tail < w else (w, tail)
                if key not in used:
                    step = w
                    used.add(key)
                    break
            if step is None:
                break
            path.append(step)
            tail = step
        lines.append([_xy(verts[i]) for i in path])
    return lines


def _frame_from_geometry(geom: Any) -> dict[str, float | int]:
    if not all(hasattr(geom, name) for name in ("xori", "yori", "xinc", "yinc")):
        bbox = _bbox(geom)
        if bbox is not None:
            xmin, ymin, xmax, ymax = bbox
            ncol = int(getattr(geom, "ncol"))
            nrow = int(getattr(geom, "nrow"))
            return {
                "origin_x": xmin,
                "origin_y": ymin,
                "spacing_x": (xmax - xmin) / max(1, ncol - 1),
                "spacing_y": (ymax - ymin) / max(1, nrow - 1),
                "ncol": ncol,
                "nrow": nrow,
            }
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


def _grid_lines(
    geom: Any,
    max_lines: int,
    max_line_points: int,
    *,
    clip_rings: list[list[list[float]]] | None = None,
) -> list[list[list[float]]]:
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
    if clip_rings:
        return _clip_lines_to_rings(lines, clip_rings)
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


def _clip_lines_to_rings(
    lines: Sequence[Sequence[list[float]]],
    rings: Sequence[Sequence[list[float]]],
) -> list[list[list[float]]]:
    clipped: list[list[list[float]]] = []
    for line in lines:
        if len(line) < 2:
            continue
        current: list[list[float]] = []
        for a, b in zip(line, line[1:]):
            mid = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5]
            if _point_in_rings(mid, rings):
                if not current:
                    current.append(a)
                current.append(b)
            else:
                if len(current) >= 2:
                    clipped.append(current)
                current = []
        if len(current) >= 2:
            clipped.append(current)
    return clipped


def _point_in_rings(point: Sequence[float], rings: Sequence[Sequence[list[float]]]) -> bool:
    return any(_point_in_ring(point, ring) for ring in rings)


def _point_in_ring(point: Sequence[float], ring: Sequence[list[float]]) -> bool:
    if len(ring) < 3:
        return False
    x, y = float(point[0]), float(point[1])
    inside = False
    prev = ring[-1]
    for cur in ring:
        x0, y0 = float(prev[0]), float(prev[1])
        x1, y1 = float(cur[0]), float(cur[1])
        if _point_on_segment(x, y, x0, y0, x1, y1):
            return True
        crosses = (y0 > y) != (y1 > y)
        if crosses:
            x_at_y = x0 + (y - y0) * (x1 - x0) / (y1 - y0)
            if x_at_y >= x:
                inside = not inside
        prev = cur
    return inside


def _point_on_segment(
    px: float, py: float, x0: float, y0: float, x1: float, y1: float
) -> bool:
    dx = x1 - x0
    dy = y1 - y0
    seg2 = dx * dx + dy * dy
    if seg2 <= 1e-24:
        return math.hypot(px - x0, py - y0) <= 1e-9
    cross = (px - x0) * dy - (py - y0) * dx
    tol = max(1e-9, math.sqrt(seg2) * 1e-9)
    if abs(cross) > tol:
        return False
    dot = (px - x0) * dx + (py - y0) * dy
    return -tol <= dot <= seg2 + tol


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


def _bbox(obj: Any) -> tuple[float, float, float, float] | None:
    if not hasattr(obj, "bbox"):
        return None
    try:
        b = obj.bbox()
    except TypeError:
        b = obj.bbox
    except Exception:
        return None
    try:
        return (float(b.xmin), float(b.ymin), float(b.xmax), float(b.ymax))
    except Exception:
        return None


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
