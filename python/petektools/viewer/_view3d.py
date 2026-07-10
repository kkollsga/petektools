"""Generic 3-D viewer payloads — full :mod:`._view2d` parity in one Three.js scene.

This module is deliberately domain-agnostic and accepts the SAME duck-typed
item conventions as :func:`~petektools.viewer.view2d` (points via ``xyz()``/
``xy()``, geometry via ``node_xy``/``ncol``/``nrow``, trimesh via
``triangles()`` + ``xyz()``/``points()``, value surfaces via
``value_layer()``, contour lines via ``iso_lines()``, outlines via
``rings()``/``edge``) plus one 3-D-only convention: a WELL offers
``trajectory()`` (or a ``trajectory`` attribute) returning ``[x, y, z]`` rows.

The vertical axis is **elevation** (family convention: z is negative down —
a horizon at 2600 m depth has ``z == -2600``). ``color=`` / ``fill=`` share
:func:`._view2d._parse_spec`'s registry-match grammar
(``"[<attr>_]<cmap>[_<min>_<max>]"``), and every emitted layer records the
same duck-typed ``name`` legend entries as view2d. The payload's ``scene3d``
section (see ``SCHEMA.md``) renders as the viewer's **3D** tab.
"""

from __future__ import annotations

import base64
import math
from pathlib import Path
from typing import Any, Sequence

from ._save import save_view
from ._server import serve
from ._v3 import _le_bytes
from ._view2d import (
    _grid_lines,
    _is_geometry,
    _is_trimesh,
    _iso_contours,
    _item_name,
    _parse_spec,
    _points,
    _rings,
    _scene_items,
)


def view3d_payload(
    items: Any,
    *,
    title: str = "3D view",
    color: bool | str = True,
    fill: bool | str = False,
    contours: float | list[float] | None = None,
    max_grid_lines: int = 800,
    max_line_points: int = 1000,
    point_limit: int | None = 200_000,
    z_exaggeration: float = 5.0,
) -> dict[str, Any]:
    """Build a generic 3-D scene payload from the view2d item conventions.

    ``items`` is normally a list such as ``[points, geometry]``. Accepted duck
    types (identical to :func:`~petektools.viewer.view2d_payload`, plus wells):

    - points: ``xyz()``/``xy()`` or a sequence of ``[x, y, z?]`` rows — a
      colour-coded 3-D point cloud (compact base64 ``f32`` block on the wire)
    - geometry: ``node_xy(i, j)``, ``ncol``, ``nrow``, optional ``edge`` — the
      lattice lines render as a flat grid at the scene's reference elevation
      (``scene3d.ref_z``, the midpoint of the scene's z extent; geometries
      carry no z of their own), clipped to ``edge`` exactly as in 2-D
    - trimesh: ``triangles()`` over ``xyz()``/``points()`` vertices — a 3-D
      surface mesh; neutral-shaded (with a wireframe toggle) unless ``fill=``
      opts it into value colouring
    - value fill (opt-in via ``fill=``): ``value_layer(attr=None)`` — the
      returned ``{"name", "nodes", "triangles", "values", "range"}`` layer IS
      the surface: it renders once, value-coloured. A node row may carry
      ``[x, y, z]``; a 2-D ``[x, y]`` node takes its elevation from the
      layer's value when the PRIMARY layer was requested (``fill=True`` /
      a pure-colormap spec — a surface's primary value layer is its
      elevation), and otherwise renders gapped (an attribute fill needs
      z-bearing nodes to be a 3-D shape)
    - contour lines (opt-in via ``contours=``): ``iso_lines(interval=...,
      levels=..., attr=None)`` — each polyline renders at ``z = level``
      (elevation iso-lines; an attribute-valued contour level is drawn at its
      level value on the z axis)
    - well: ``trajectory()`` (or attribute) returning ``[x, y, z]`` rows with
      z ELEVATION (negative down) — a 3-D bore path with a wellhead marker,
      identity-coloured; optional ``id``/``name`` labels it
    - outline: ``rings()`` of ``[x, y]`` rows — flat rings at ``ref_z``
    - structured surface passed BARE (value-bearing, e.g. petekio's regular
      ``Surface`` — ``value_layer()`` + a 2-D ``.geometry``, no top-level
      trimesh/geometry ducks): renders its STRUCTURE as a NEUTRAL elevation
      mesh from the primary value layer (value-as-elevation; ``values`` stay
      null → neutral shading + the wireframe toggle — never value-coloured
      without ``fill=``); an item with only a 2-D ``.geometry`` falls back
      to lattice lines at ``ref_z``

    ``color=`` / ``fill=`` / ``contours=`` keep their exact view2d semantics
    and grammar: ``color=`` colours POINTS by z (default ON; ``color=False``
    for monochrome) and selects the colormap for whatever is value-coloured;
    it never triggers fills. ``fill=`` opts items into value-coloured
    surfaces. Both accept ``bool`` or the registry-match spec
    ``"[<attr>_]<cmap>[_<min>_<max>]"`` (``viridis`` / ``magma`` / ``grays``
    / ``inferno``; negative range floats fine — ``"inferno_-2700_-2500"``); a
    string with no colormap token stays an attribute name; a malformed spec
    raises ``ValueError``. An explicit range clamps the normalization (values
    outside it render at the ramp ends).

    Point clouds cap at ``point_limit`` (default 200k) by striding, exactly
    like view2d (``summary.point_stride``). ``z_exaggeration`` seeds the 3D
    tab's z-exaggeration slider (display-only scale, badge + true-depth
    readouts — the same control the volume tab has; default 5x).

    Every emitted layer records a legend display name duck-typed from the
    item's optional ``name`` attribute (``scene3d.layers`` carries
    ``{"kind": "points"|"lines"|"contours"|"wells", "name": str | None}``;
    value meshes self-describe via ``display_name``, like 2-D fills).
    """
    color_spec = _parse_spec(color, "color")
    fill_spec = _parse_spec(fill, "fill")
    scene_items = _scene_items(items)

    clouds: list[dict[str, Any]] = []
    meshes: list[dict[str, Any]] = []
    lattices: list[dict[str, Any]] = []
    contour_sets: list[dict[str, Any]] = []
    wells: list[dict[str, Any]] = []
    outlines: list[list[list[float]]] = []
    layers: list[dict[str, Any]] = []
    summary: dict[str, Any] = {}
    point_zs: list[float] = []
    n_points = 0
    n_triangles = 0

    for item in scene_items:
        contributed = False
        mesh_added = False
        name = _item_name(item)

        if fill_spec["enabled"]:
            entry = _value_mesh(item, fill_spec["attr"])
            if entry is not None:
                entry["display_name"] = name
                if fill_spec["range"] is not None:
                    entry["range"] = list(fill_spec["range"])
                meshes.append(entry)
                n_triangles += len(entry["triangles"])
                contributed = True
                mesh_added = True
        if contours is not None:
            iso = _iso_contours(item, contours, color_spec["attr"])
            if iso is not None:
                contour_sets.extend(iso)
                layers.append({"kind": "contours", "name": name})
                contributed = True

        if _is_geometry(item):
            edge = getattr(item, "edge", None)
            edge_rings = _rings(edge) if edge is not None else []
            lines = _grid_lines(
                item, max_grid_lines, max_line_points, clip_rings=edge_rings
            )
            lattices.append({"name": name, "lines": lines})
            outlines.extend(edge_rings)
            summary["grid"] = f"{int(getattr(item, 'ncol'))} x {int(getattr(item, 'nrow'))}"
            layers.append({"kind": "lines", "name": name})
            continue

        if _is_trimesh(item):
            if not mesh_added:
                meshes.append(_neutral_mesh(item, name))
                n_triangles += len(meshes[-1]["triangles"])
            edge = getattr(item, "edge", None)
            if edge is not None:
                outlines.extend(_rings(edge))
            continue

        if _is_well(item):
            wells.append(_well_entry(item, name, len(wells)))
            layers.append({"kind": "wells", "name": wells[-1]["id"]})
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
            point_zs.extend(p[2] for p in pts if len(p) > 2 and math.isfinite(p[2]))
            clouds.append({"name": name, "n": len(pts), "xyz": _xyz_block(pts)})
            n_points += len(pts)
            layers.append({"kind": "points", "name": name})
            continue

        if contributed:
            continue  # a fill/contour-only item carries no further geometry

        # STRUCTURE fallback for value-bearing items passed bare (the petekio
        # regular-Surface duck: value_layer()/iso_lines() + a 2-D .geometry,
        # no top-level node_xy/triangles/xyz): the primary value layer's
        # nodes ARE the surface — render it as a NEUTRAL elevation mesh
        # (``values``/``range`` null → the neutral material + wireframe
        # toggle; colouring stays a ``fill=`` opt-in). An item carrying only
        # a 2-D ``.geometry`` falls back to lattice lines at ``ref_z``.
        entry = _value_mesh(item, None)
        if entry is not None:
            entry["values"] = None
            entry["range"] = None
            entry["name"] = "mesh"
            entry["display_name"] = name
            meshes.append(entry)
            n_triangles += len(entry["triangles"])
            continue
        geom = getattr(item, "geometry", None)
        if geom is not None and _is_geometry(geom):
            lines = _grid_lines(geom, max_grid_lines, max_line_points, clip_rings=[])
            lattices.append({"name": name, "lines": lines})
            layers.append({"kind": "lines", "name": name})
            continue

        raise TypeError(
            f"cannot add {type(item).__name__} to a 3D view (a value-bearing "
            "item can be value-coloured with fill=)"
        )

    point_color = None
    if color_spec["enabled"] and point_zs:
        rng = color_spec["range"] or [min(point_zs), max(point_zs)]
        point_color = {"by": "z", "range": [float(rng[0]), float(rng[1])]}

    summary["points"] = n_points
    if meshes:
        summary["meshes"] = len(meshes)
        summary["triangles"] = n_triangles
    if lattices:
        summary["lattices"] = len(lattices)
    if wells:
        summary["wells"] = len(wells)
    if contour_sets:
        summary["contour_levels"] = len(contour_sets)
    if point_color is not None:
        summary["point_color"] = point_color["by"]

    return {
        "schema_version": 4,
        "kind": "3D",
        "property": title,
        "properties": [],
        "summary": summary,
        "volume": None,
        "map": None,
        "scene3d": {
            "schema_version": 1,
            "points": clouds,
            "meshes": meshes,
            "lattices": lattices,
            "contours": contour_sets,
            "wells": wells,
            "outlines": outlines,
            "layers": layers,
            "point_color": point_color,
            "colormap": color_spec["cmap"] or fill_spec["cmap"],
            "z_exaggeration": float(z_exaggeration),
            "ref_z": _ref_z(point_zs, meshes, wells),
        },
        "sections": [],
        "section_labels": [],
        "wells": [],
        "charts": [],
    }


def view3d(
    items: Any,
    *,
    title: str = "3D view",
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
    z_exaggeration: float = 5.0,
) -> str | dict[str, Any]:
    """Open or save a generic 3-D scene view (the viewer's **3D** tab).

    Same duck-typed item handling and ``color=`` / ``fill=`` / ``contours=``
    semantics as :func:`~petektools.viewer.view2d` — see
    :func:`view3d_payload` for the full grammar and conventions. Returns the
    local server URL in live mode, or the written path when ``save=`` is
    supplied.
    """
    payload = view3d_payload(
        items,
        title=title,
        color=color,
        fill=fill,
        contours=contours,
        max_grid_lines=max_grid_lines,
        max_line_points=max_line_points,
        point_limit=point_limit,
        z_exaggeration=z_exaggeration,
    )
    if save is not None:
        save_view(payload, save)
        return str(save)
    return serve(payload, port=port, block=block, open_browser=open_browser)


def _xyz_block(rows: Sequence[Sequence[float]]) -> dict[str, Any]:
    """Pack ``[x, y, z?]`` rows as one compact f32 binary block.

    The exact ``{dtype, shape, data}`` little-endian base64 shape the viewer's
    existing decode kernel reads (v3 volume blocks / well-log lanes); a
    missing/non-finite z packs as NaN (the renderer parks it at ``ref_z`` in
    the neutral colour).
    """
    flat: list[float] = []
    for row in rows:
        flat.append(float(row[0]))
        flat.append(float(row[1]))
        z = float(row[2]) if len(row) > 2 else math.nan
        flat.append(z if math.isfinite(z) else math.nan)
    raw = _le_bytes(flat, "f32")
    return {
        "dtype": "f32",
        "shape": [len(rows), 3],
        "data": base64.b64encode(raw).decode("ascii"),
    }


def _is_well(obj: Any) -> bool:
    """A well offers a ``trajectory`` (callable or attribute) of [x, y, z] rows."""
    return getattr(obj, "trajectory", None) is not None


def _well_entry(item: Any, name: str | None, idx: int) -> dict[str, Any]:
    traj = item.trajectory() if callable(item.trajectory) else item.trajectory
    rows: list[list[float | None]] = []
    for row in traj:
        vals = list(row)
        if len(vals) < 3:
            raise TypeError(
                f"trajectory() on {type(item).__name__} must yield [x, y, z] rows, "
                f"got {row!r}"
            )
        z = float(vals[2])
        rows.append([float(vals[0]), float(vals[1]), z if math.isfinite(z) else None])
    wid = getattr(item, "id", None)
    wid = str(wid) if wid is not None and not callable(wid) else None
    return {"id": wid or name or f"well {idx + 1}", "trajectory": rows}


def _value_mesh(item: Any, attr: str | None) -> dict[str, Any] | None:
    """One value-coloured 3-D surface from an item's ``value_layer()`` duck.

    Validated exactly like the 2-D fill seam, but keeps nodes 3-D: a node row's
    third component is its elevation; a 2-D ``[x, y]`` node takes the layer's
    VALUE as elevation when the primary layer was requested (``attr=None`` —
    a surface's primary value layer is its z), else it stays gapped (NaN →
    JSON null; triangles touching it are skipped).
    """
    fn = getattr(item, "value_layer", None)
    if not callable(fn):
        return None
    layer = fn(attr=attr) if attr is not None else fn()
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
    values = [
        float(v) if v is not None and math.isfinite(float(v)) else None
        for v in layer["values"]
    ]
    if len(values) != len(layer["nodes"]):
        raise TypeError(
            f"value_layer() on {name}: {len(values)} values for {len(layer['nodes'])} nodes"
        )
    nodes: list[list[float | None]] = []
    for i, row in enumerate(layer["nodes"]):
        vals = list(row)
        z: float | None = None
        if len(vals) > 2 and vals[2] is not None and math.isfinite(float(vals[2])):
            z = float(vals[2])
        elif attr is None:
            z = values[i]
        nodes.append([float(vals[0]), float(vals[1]), z])
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


def _neutral_mesh(item: Any, name: str | None) -> dict[str, Any]:
    """A trimesh item's raw 3-D surface (no value colouring — neutral shading)."""
    verts = item.xyz() if hasattr(item, "xyz") else item.points()
    nodes: list[list[float | None]] = []
    for row in verts:
        vals = list(row)
        z = float(vals[2]) if len(vals) > 2 else math.nan
        nodes.append([float(vals[0]), float(vals[1]), z if math.isfinite(z) else None])
    triangles = [[int(t[0]), int(t[1]), int(t[2])] for t in item.triangles()]
    return {
        "name": "mesh",
        "display_name": name,
        "nodes": nodes,
        "triangles": triangles,
        "values": None,
        "range": None,
    }


def _ref_z(
    point_zs: list[float],
    meshes: list[dict[str, Any]],
    wells: list[dict[str, Any]],
) -> float:
    """The flat-element elevation: midpoint of the scene's finite z extent.

    Geometries and outline rings carry no z of their own, so their lattice
    lines / rings render at this reference plane (0.0 for an all-flat scene).
    """
    zs = list(point_zs)
    for mesh in meshes:
        zs.extend(n[2] for n in mesh["nodes"] if n[2] is not None)
    for well in wells:
        zs.extend(p[2] for p in well["trajectory"] if p[2] is not None)
    if not zs:
        return 0.0
    return (min(zs) + max(zs)) / 2.0
