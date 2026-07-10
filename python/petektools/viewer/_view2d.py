"""Generic 2-D viewer payloads.

This module is deliberately domain-agnostic. It accepts plain coordinate
sequences plus duck-typed objects from producer libraries: a point object may
offer ``xyz()``/``xy()``, a geometry may offer ``node_xy(i, j)`` with ``ncol`` and
``nrow``, a triangulated mesh may offer ``triangles()`` with ``xyz()``/``points()``,
and an outline may offer ``rings()``. Two optional value conventions extend
these: ``value_layer(attr=None)`` returns a per-node value-coloured trimesh
(``{"name", "nodes", "triangles", "values", "range"}``; opted in via
``fill=``), and ``iso_lines(interval=..., levels=..., attr=None)`` returns
``[(level, [polyline, ...]), ...]`` contour polylines (opted in via
``contours=``). An optional ``name`` attribute on any item becomes the
layer's legend display name.

``color=`` and ``fill=`` share one string grammar, parsed by registry match:
``"[<attr>_]<cmap>[_<min>_<max>]"`` where ``<cmap>`` is a known colormap
(``viridis`` / ``magma`` / ``grays`` / ``inferno``). A string with no colormap
token is an attribute name (back-compat). See :func:`view2d_payload`.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Iterable, Sequence

from . import _blocks
from ._save import save_view
from ._server import serve


def view2d_payload(
    items: Any,
    *,
    title: str = "2D view",
    color: bool | str = True,
    fill: bool | str = False,
    contours: float | list[float] | None = None,
    max_grid_lines: int = 800,
    max_line_points: int = 1000,
    point_limit: int | None = 200_000,
    max_mesh_edges: int | None = 150_000,
    lod: bool | tuple = True,
    encoding: str = "blocks",
    block_threshold_bytes: int = _blocks.DEFAULT_THRESHOLD_BYTES,
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
    - value fill (opt-in via ``fill=``): ``value_layer(attr=None)`` returning
      ``{"name", "nodes", "triangles", "values", "range"}`` — a per-node
      value-coloured trimesh rendered UNDER the grid lines
    - contour lines (opt-in via ``contours=``): ``iso_lines(interval=...,
      levels=..., attr=None)`` returning ``[(level, [polyline, ...]), ...]``
    - structured surface (value-bearing, e.g. petekio's regular ``Surface``):
      an item offering ``value_layer()`` (typically with a 2-D ``.geometry``)
      that matches no convention above renders its STRUCTURE when passed
      bare — the ``.geometry`` lattice lines (clipped to ``edge``), or,
      geometry-less, its primary value layer's unique triangle edges. Values
      never colour anything without an explicit ``fill=``

    ``color=`` colours POINTS (and selects the colormap for whatever is
    value-coloured); it never triggers fills. It defaults ON — pass
    ``color=False`` for monochrome points. ``fill=`` opts items into value
    fills (``value_layer()``); contours keep their own ``contours=`` parameter.
    Both accept ``bool`` or a string spec parsed by REGISTRY MATCH: the string
    splits on ``"_"``; if a token matches a known colormap name (``viridis`` /
    ``magma`` / ``grays`` / ``inferno``), everything before it is the attribute
    (may itself contain underscores), and up to two trailing float tokens
    (negative numbers included) are the explicit ``[min, max]`` range. A string
    with no colormap token stays an ATTRIBUTE name (back-compat). Examples::

        color=True                        # the default: points by z, data range
        color=False                       # monochrome points
        color="inferno"                   # + the inferno colormap
        color="inferno_-2700_-2500"       # + an explicit clamp range
        color="porosity"                  # attribute (forwards to iso_lines)
        color="porosity_inferno_0_0.3"    # attribute + colormap + range
        fill="phi"                        # value_layer(attr="phi") fills

    A malformed spec (e.g. a colormap with a single trailing float, or
    non-float range tokens) raises ``ValueError``.

    With ``color`` on, plain points carrying a finite third component are
    colour-coded by it; ``map.point_color`` records the range — the explicit
    spec range when given (out-of-range values clamp to the ends), else the
    data z range. The parsed colormap travels as ``map.colormap`` (``color``'s
    wins over ``fill``'s), and an explicit ``fill`` range overrides each fill
    entry's producer range. ``fill=True`` asks every item offering
    ``value_layer()`` for its primary layer; a string spec's attribute asks for
    that attribute. ``contours=<float>`` requests ``iso_lines(interval=...)``;
    a list requests ``iso_lines(levels=...)``; the ``color`` spec's attribute
    (if any) is forwarded as ``attr=``. Items without these methods are
    unaffected, and an item that yields a fill still contributes its
    geometry/trimesh lines exactly as before.

    Every emitted layer records a legend display name, duck-typed from the
    source object's optional ``name`` attribute (``map.layers`` carries
    ``{"kind": "points"|"lines"|"contours", "name": str | None}`` entries;
    fills carry ``display_name``); the viewer falls back to the layer kind.

    Point objects are rendered as points only. Topology-bearing point sets do
    not imply grid-line rendering; pass a geometry, structured surface, or
    trimesh when the grid itself should be visible.

    ``lod`` controls the display-only **stride-ladder LOD**: when on (default),
    every item whose producer duck accepts the striding kwargs emits BOTH a
    full-resolution ring and ONE coarse ring, so the viewer can drop to the
    coarse ring when a data cell shrinks below a few screen pixels (geometry
    truth is never decimated — the coarse ring is additive display data). The
    coarse ring is requested from the producer: ``value_layer(stride=...)`` for
    a fill (``fills[i]["lod"] = {stride, nodes, triangles, values, range}`` —
    the range is the FULL-resolution range so colours stay stable across rings),
    ``wireframe_edges(stride=...)`` for mesh grid lines (``map["grid_lines_lod"]``),
    and ``iso_lines(..., simplify=tol)`` for contours (``contours[i]["lines_lod"]``).
    ``lod=True`` uses ``stride=4`` and derives the contour ``simplify`` tolerance
    from the contour extent (``extent / 512`` ≈ two coarse-ring pixels);
    ``lod=(stride,)`` or ``lod=(stride, simplify)`` overrides those; ``lod=False``
    emits no coarse ring (a payload byte-identical to the pre-LOD shape). A
    producer method that does not accept the striding kwarg is feature-detected
    (``TypeError``) and degrades silently to no coarse ring for that item — all
    LOD fields are additive and every one is block-encoded like its full ring.

    ``encoding`` controls how the bulk arrays travel. ``"blocks"`` (default)
    encodes ``points``, each fill's ``nodes``/``triangles``/``values``,
    ``grid_lines`` and ``contours[i].lines`` as content-addressed typed binary
    blocks (the v3 wire format; see ``SCHEMA.md`` / :mod:`_blocks`) with a
    per-payload ``map["blocks"]`` digest table that ships each identical array
    once — the viewer decodes them off the main thread into typed arrays. A
    payload whose bulk arrays total under ``block_threshold_bytes`` (~64 KB of
    floats) stays plain JSON regardless. ``encoding="json"`` forces the plain
    (pre-blocks) shape; the viewer renders either.
    """
    color_spec = _parse_spec(color, "color")
    fill_spec = _parse_spec(fill, "fill")
    lod_cfg = _parse_lod(lod)
    scene_items = _scene_items(items)
    points: list[list[float]] = []
    grid_lines: list[list[list[float]]] = []
    grid_lines_lod: list[list[list[float]]] = []
    outlines: list[list[list[float]]] = []
    fills: list[dict[str, Any]] = []
    contour_sets: list[dict[str, Any]] = []
    layers: list[dict[str, Any]] = []
    frame = None
    summary: dict[str, Any] = {}

    for item in scene_items:
        contributed = False
        name = _item_name(item)
        if fill_spec["enabled"]:
            fill_entry = _value_fill(item, fill_spec["attr"])
            if fill_entry is not None:
                fill_entry["display_name"] = name
                if fill_spec["range"] is not None:
                    fill_entry["range"] = list(fill_spec["range"])
                if lod_cfg["enabled"]:
                    ring = _value_fill_lod(item, fill_spec["attr"], lod_cfg["stride"])
                    if ring is not None:
                        fill_entry["lod"] = {
                            "stride": lod_cfg["stride"],
                            "nodes": ring["nodes"],
                            "triangles": ring["triangles"],
                            "values": ring["values"],
                            "range": list(fill_entry["range"]),
                        }
                fills.append(fill_entry)
                contributed = True
        if contours is not None:
            iso = _iso_contours(item, contours, color_spec["attr"], lod_cfg)
            if iso is not None:
                contour_sets.extend(iso)
                layers.append({"kind": "contours", "name": name})
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
            layers.append({"kind": "lines", "name": name})
            continue

        if _is_trimesh(item):
            edge = getattr(item, "edge", None)
            edge_rings = _rings(edge) if edge is not None else []
            mesh_lines, n_triangles, edge_stride = _mesh_lines(
                item, max_mesh_edges, max_line_points
            )
            grid_lines.extend(mesh_lines)
            if lod_cfg["enabled"]:
                lod_lines = _mesh_lines_lod(
                    item, max_mesh_edges, max_line_points, lod_cfg["stride"]
                )
                if lod_lines:
                    grid_lines_lod.extend(lod_lines)
            outlines.extend(edge_rings)
            summary["triangles"] = n_triangles
            if edge_stride > 1:
                summary["mesh_edge_stride"] = edge_stride
            layers.append({"kind": "lines", "name": name})
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
            layers.append({"kind": "points", "name": name})
            continue

        if contributed:
            continue  # a fill/contour-only item carries no further geometry

        # STRUCTURE fallback for value-bearing items passed bare (e.g. a
        # petekio regular Surface: ``value_layer()``/``iso_lines()`` + a 2-D
        # ``.geometry``, no top-level node_xy/triangles/xyz). Bare means
        # "show me the grid": the structure renders as lines exactly like a
        # bare geometry/trimesh; values stay an explicit ``fill=`` opt-in.
        geom = getattr(item, "geometry", None)
        if geom is not None and _is_geometry(geom):
            edge = getattr(item, "edge", None)
            if edge is None:
                edge = getattr(geom, "edge", None)
            edge_rings = _rings(edge) if edge is not None else []
            grid_lines.extend(
                _grid_lines(geom, max_grid_lines, max_line_points, clip_rings=edge_rings)
            )
            outlines.extend(edge_rings)
            summary["grid"] = f"{int(getattr(geom, 'ncol'))} x {int(getattr(geom, 'nrow'))}"
            if not edge_rings:
                frame = _frame_from_geometry(geom)
            layers.append({"kind": "lines", "name": name})
            continue
        layer = _primary_value_layer(item)
        if layer is not None:
            mesh_lines, n_triangles, edge_stride = _mesh_lines(
                _LayerMesh(layer), max_mesh_edges, max_line_points
            )
            grid_lines.extend(mesh_lines)
            if lod_cfg["enabled"]:
                ring = _value_fill_lod(item, None, lod_cfg["stride"])
                if ring is not None:
                    lod_ml, _, _ = _mesh_lines(
                        _LayerMesh(ring), max_mesh_edges, max_line_points
                    )
                    grid_lines_lod.extend(lod_ml)
            summary["triangles"] = n_triangles
            if edge_stride > 1:
                summary["mesh_edge_stride"] = edge_stride
            layers.append({"kind": "lines", "name": name})
            continue

        raise TypeError(
            f"cannot add {type(item).__name__} to a 2D view (a value-bearing "
            "item can be value-coloured with fill=)"
        )

    if frame is None:
        frame = _frame_from_extent(_extent(points, grid_lines, outlines))
    if not outlines:
        outlines = _rect_outline_from_frame(frame)

    point_color = None
    if color_spec["enabled"]:
        zs = [p[2] for p in points if len(p) > 2 and math.isfinite(p[2])]
        if zs:
            rng = color_spec["range"] or [min(zs), max(zs)]
            point_color = {"by": "z", "range": [float(rng[0]), float(rng[1])]}

    summary["points"] = len(points)
    summary["grid_lines"] = len(grid_lines)
    summary["outlines"] = len(outlines)
    if fills:
        summary["fills"] = len(fills)
    if contour_sets:
        summary["contour_levels"] = len(contour_sets)
    if point_color is not None:
        summary["point_color"] = point_color["by"]

    if encoding not in ("blocks", "json"):
        raise ValueError(f"encoding= must be 'blocks' or 'json', got {encoding!r}")

    payload = {
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
            "colormap": color_spec["cmap"] or fill_spec["cmap"],
            "layers": layers,
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
    # Additive stride-ladder LOD: the coarse mesh-grid-line ring (fills / contours
    # carry their own coarse rings inline). Attached only when non-empty, so a
    # `lod=False` or LOD-unsupported payload stays byte-identical to the pre-LOD
    # shape (no empty `grid_lines_lod` key).
    if grid_lines_lod:
        payload["map"]["grid_lines_lod"] = grid_lines_lod
    # Additive: encode the bulk arrays as content-addressed typed blocks (the v3
    # wire format) unless asked for plain JSON or the payload is below threshold.
    # A JSON-shaped payload still renders (the viewer decodes both).
    if encoding == "blocks":
        _blocks.encode_map(payload["map"], threshold_bytes=block_threshold_bytes)
    return payload


def view2d(
    items: Any,
    *,
    title: str = "2D view",
    color: bool | str = True,
    fill: bool | str = False,
    contours: float | list[float] | None = None,
    save: str | Path | None = None,
    port: int = 0,
    block: bool = False,
    open_browser: bool = True,
    max_grid_lines: int = 800,
    max_line_points: int = 1000,
    point_limit: int | None = 200_000,
    max_mesh_edges: int | None = 150_000,
    lod: bool | tuple = True,
    encoding: str = "blocks",
    block_threshold_bytes: int = _blocks.DEFAULT_THRESHOLD_BYTES,
) -> str | dict[str, Any]:
    """Open or save a generic 2-D map view.

    ``color=`` colours points (and picks the colormap + clamp range through
    the ``"[<attr>_]<cmap>[_<min>_<max>]"`` spec grammar); ``fill=`` opts
    items into value-coloured fills; ``contours=`` opts them into contour
    lines (see :func:`view2d_payload` for the full grammar and duck-typed
    conventions). Returns the local server URL in live mode, the written path
    when ``save=`` is supplied, or the payload when ``open_browser=False`` and
    ``block=False`` is still served by the caller through ``view2d_payload``
    directly.
    """
    payload = view2d_payload(
        items,
        title=title,
        color=color,
        fill=fill,
        contours=contours,
        max_grid_lines=max_grid_lines,
        max_line_points=max_line_points,
        point_limit=point_limit,
        max_mesh_edges=max_mesh_edges,
        lod=lod,
        encoding=encoding,
        block_threshold_bytes=block_threshold_bytes,
    )
    if save is not None:
        save_view(payload, save)
        return str(save)
    return serve(payload, port=port, block=block, open_browser=open_browser)


# The known colormap registry — the token-match anchor of the color=/fill=
# spec grammar. Must stay in sync with the JS renderer's COLORMAPS
# (assets/viewer/00-app.js).
_COLORMAPS = ("viridis", "magma", "grays", "inferno")


def _parse_spec(spec: bool | str, param: str) -> dict[str, Any]:
    """Parse a ``color=`` / ``fill=`` value into its parts.

    Returns ``{"enabled": bool, "attr": str | None, "cmap": str | None,
    "range": [float, float] | None}``. The string grammar is REGISTRY MATCH:
    split on ``"_"``; the first token matching a known colormap name splits the
    spec into ``<attr>`` (everything before it, underscores preserved) and up
    to two trailing float tokens ``<min>_<max>`` (negative numbers fine, e.g.
    ``"inferno_-2700_-2500"``). No colormap token → the whole string is an
    attribute name (back-compat). Malformed trailing tokens (one float, or
    non-floats) raise ``ValueError``.
    """
    if spec is False or spec is None:
        return {"enabled": False, "attr": None, "cmap": None, "range": None}
    if spec is True:
        return {"enabled": True, "attr": None, "cmap": None, "range": None}
    if not isinstance(spec, str):
        raise TypeError(f"{param}= must be a bool or str, got {type(spec).__name__}")
    if not spec:
        raise ValueError(f"{param}= spec must not be an empty string")
    tokens = spec.split("_")
    cmap_idx = next((i for i, tok in enumerate(tokens) if tok in _COLORMAPS), None)
    if cmap_idx is None:
        return {"enabled": True, "attr": spec, "cmap": None, "range": None}
    attr = "_".join(tokens[:cmap_idx]) or None
    cmap = tokens[cmap_idx]
    trailing = tokens[cmap_idx + 1 :]
    if not trailing:
        rng = None
    elif len(trailing) == 2:
        try:
            rng = [float(trailing[0]), float(trailing[1])]
        except ValueError:
            raise ValueError(
                f"malformed {param}= spec {spec!r}: the tokens after {cmap!r} "
                f"must be two floats (<min>_<max>), got {trailing!r}"
            ) from None
    else:
        raise ValueError(
            f"malformed {param}= spec {spec!r}: expected "
            f"'[<attr>_]{cmap}[_<min>_<max>]', got {len(trailing)} trailing "
            f"token(s) {trailing!r}"
        )
    return {"enabled": True, "attr": attr, "cmap": cmap, "range": rng}


def _item_name(item: Any) -> str | None:
    """A layer's legend display name, duck-typed from the item's optional
    ``name`` attribute (e.g. a petekIO dataset name like ``"Top Agat"``).
    ``None`` when absent, empty, or not a plain value."""
    nm = getattr(item, "name", None)
    if nm is None or callable(nm):
        return None
    return str(nm) or None


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


def _value_fill(item: Any, attr: str | None) -> dict[str, Any] | None:
    """One value-coloured trimesh fill from an item's ``value_layer()`` duck.

    ``attr=None`` asks for the primary layer; a string asks for that attribute.
    Returns ``None`` when the item does not offer the method (silently — the
    fill is opt-in per item); raises ``TypeError`` on a malformed layer.
    """
    fn = getattr(item, "value_layer", None)
    if not callable(fn):
        return None
    layer = fn(attr=attr) if attr is not None else fn()
    if layer is None:
        return None
    return _coerce_fill(layer, type(item).__name__)


def _coerce_fill(layer: Any, name: str) -> dict[str, Any]:
    """Validate and normalize a ``value_layer()`` dict into a fill entry."""
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


def _value_fill_lod(item: Any, attr: str | None, stride: int) -> dict[str, Any] | None:
    """A coarse value-fill ring via ``value_layer(stride=...)``.

    Feature-detects producer support: returns ``None`` when the item offers no
    ``value_layer``, when the method rejects the ``stride`` kwarg (``TypeError``
    → no LOD ring, silently), or when it returns ``None``. A supported coarse
    layer is coerced exactly like the full ring, so the two share a shape."""
    fn = getattr(item, "value_layer", None)
    if not callable(fn):
        return None
    try:
        layer = fn(attr=attr, stride=stride) if attr is not None else fn(stride=stride)
    except TypeError:
        return None
    if layer is None:
        return None
    return _coerce_fill(layer, type(item).__name__)


def _parse_lod(lod: bool | tuple) -> dict[str, Any]:
    """Parse the ``lod=`` value into ``{"enabled", "stride", "simplify"}``.

    ``True`` → enabled with ``stride=4`` and auto contour ``simplify`` (``None``
    = derive from the contour extent); ``False``/``None`` → disabled;
    ``(stride,)`` or ``(stride, simplify)`` → enabled with those overrides
    (``stride`` must be ``>= 2`` — a coarse ring at stride 1 is the full ring)."""
    if lod is False or lod is None:
        return {"enabled": False, "stride": 4, "simplify": None}
    if lod is True:
        return {"enabled": True, "stride": 4, "simplify": None}
    if isinstance(lod, tuple):
        if len(lod) not in (1, 2):
            raise ValueError(
                f"lod= tuple must be (stride,) or (stride, simplify), got {lod!r}"
            )
        stride = int(lod[0])
        if stride < 2:
            raise ValueError(f"lod= stride must be >= 2, got {stride}")
        simplify = float(lod[1]) if len(lod) == 2 else None
        return {"enabled": True, "stride": stride, "simplify": simplify}
    raise TypeError(f"lod= must be a bool or tuple, got {type(lod).__name__}")


def _iso_contours(
    item: Any,
    contours: float | list[float],
    attr: str | None,
    lod: dict[str, Any] | None = None,
) -> list[dict[str, Any]] | None:
    """Contour sets from an item's ``iso_lines()`` duck.

    A float ``contours`` requests ``iso_lines(interval=...)``, a list requests
    ``iso_lines(levels=...)``; the ``color`` spec's attribute forwards as
    ``attr=``. In
    interval mode, index levels — multiples of the round step nearest 4-5x the
    interval — are flagged ``major`` and render bolder (explicit level lists
    carry no majors). Returns ``None`` when the item does not offer the method;
    raises ``TypeError`` on a malformed result (each entry must be
    ``(level, [polyline, ...])``).

    When ``lod`` is enabled, a coarse ``lines_lod`` ring is attached to each set
    via ``iso_lines(..., simplify=tol)`` (Douglas–Peucker in world units);
    ``simplify`` defaults to the contour extent / 512 (≈ two coarse-ring pixels).
    """
    fn = getattr(item, "iso_lines", None)
    if not callable(fn):
        return None
    kwargs, major_step = _iso_kwargs(contours, attr)
    name = type(item).__name__
    out: list[dict[str, Any]] = []
    for entry in fn(**kwargs):
        level, lines = _iso_entry(entry, name)
        out.append(
            {
                "level": level,
                "major": _is_major(level, major_step),
                "lines": [[_xy(p) for p in line] for line in lines],
            }
        )
    if lod is not None and lod["enabled"] and out:
        _attach_iso_lod(fn, kwargs, out, lod["simplify"], name)
    return out


def _iso_kwargs(
    contours: float | list[float], attr: str | None
) -> tuple[dict[str, Any], float | None]:
    kwargs: dict[str, Any] = {}
    major_step = None
    if isinstance(contours, (int, float)) and not isinstance(contours, bool):
        kwargs["interval"] = float(contours)
        major_step = _major_step(float(contours))
    else:
        kwargs["levels"] = [float(v) for v in contours]
    if attr is not None:
        kwargs["attr"] = attr
    return kwargs, major_step


def _iso_entry(entry: Any, name: str) -> tuple[float, Any]:
    try:
        level, lines = entry
    except (TypeError, ValueError):
        raise TypeError(
            f"iso_lines() on {name} must yield (level, [polyline, ...]) pairs, "
            f"got {entry!r}"
        ) from None
    return float(level), lines


def _is_major(level: float, major_step: float | None) -> bool:
    return (
        major_step is not None
        and abs(level / major_step - round(level / major_step)) < 1e-6
    )


def _attach_iso_lod(
    fn: Any,
    kwargs: dict[str, Any],
    out: list[dict[str, Any]],
    simplify: float | None,
    name: str,
) -> None:
    """Attach a coarse ``lines_lod`` ring to each contour set via
    ``iso_lines(..., simplify=tol)``. Feature-detected (``TypeError`` → no ring);
    also skipped when the simplified call does not align level-for-level with the
    full ring (defensive — the two must share level order)."""
    if simplify is None:  # auto: derive from the full contour extent (~2 coarse px)
        span = _lines_span(o["lines"] for o in out)
        if span <= 0:
            return
        simplify = span / 512.0
    try:
        coarse = list(fn(simplify=simplify, **kwargs))
    except TypeError:
        return
    if len(coarse) != len(out):
        return
    for entry_out, entry in zip(out, coarse):
        _level, lines = _iso_entry(entry, name)
        entry_out["lines_lod"] = [[_xy(p) for p in line] for line in lines]


def _lines_span(line_sets: Iterable[list[list[list[float]]]]) -> float:
    """The larger of the x/y coordinate spans over a group of polyline sets."""
    xmin = ymin = math.inf
    xmax = ymax = -math.inf
    for lines in line_sets:
        for line in lines:
            for pt in line:
                x, y = float(pt[0]), float(pt[1])
                if x < xmin:
                    xmin = x
                if x > xmax:
                    xmax = x
                if y < ymin:
                    ymin = y
                if y > ymax:
                    ymax = y
    if not math.isfinite(xmin):
        return 0.0
    return max(xmax - xmin, ymax - ymin)


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


def _primary_value_layer(item: Any) -> dict[str, Any] | None:
    """The item's primary ``value_layer()`` dict, or ``None`` (not offered, or
    the layer carries no drawable nodes/triangles). The STRUCTURE-fallback
    probe for bare value-bearing items — never emits values (fills stay a
    ``fill=`` opt-in)."""
    fn = getattr(item, "value_layer", None)
    if not callable(fn):
        return None
    layer = fn()
    if not isinstance(layer, dict) or not layer.get("nodes") or not layer.get("triangles"):
        return None
    return layer


class _LayerMesh:
    """Adapter: a ``value_layer()`` dict as the trimesh duck ``_mesh_lines``
    reads (its unique triangle edges become the drawn structure lines)."""

    def __init__(self, layer: dict[str, Any]):
        self._layer = layer

    def points(self) -> Any:
        return self._layer["nodes"]

    def triangles(self) -> Any:
        return self._layer["triangles"]


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


def _mesh_lines_lod(
    mesh: Any,
    max_edges: int | None,
    max_line_points: int,
    stride: int,
) -> list[list[list[float]]] | None:
    """A coarse mesh-grid-line ring via ``wireframe_edges(stride=...)``.

    Feature-detects producer support: returns ``None`` when the mesh has no
    ``wireframe_edges`` or the method rejects the ``stride`` kwarg (``TypeError``
    → no LOD ring, silently). The coarse edge pairs are chained into polylines
    exactly like the full ring (and capped by ``max_edges`` the same way)."""
    wireframe = getattr(mesh, "wireframe_edges", None)
    if not callable(wireframe):
        return None
    try:
        pairs = wireframe(stride=stride)
    except TypeError:
        return None
    verts = mesh.xyz() if hasattr(mesh, "xyz") else mesh.points()
    edges: set[tuple[int, int]] = set()
    for pair in pairs:
        u, v = int(pair[0]), int(pair[1])
        edges.add((u, v) if u < v else (v, u))
    edge_list = sorted(edges)
    if max_edges is not None and len(edge_list) > max_edges:
        s = math.ceil(len(edge_list) / max_edges)
        edge_list = edge_list[::s]
    return _chain_edges(edge_list, verts, max_line_points)


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
