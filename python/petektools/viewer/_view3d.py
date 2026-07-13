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
    _LayerMesh,
    _grid_lines,
    _is_geometry,
    _is_trimesh,
    _iso_contours,
    _mesh_vertices,
    _mesh_lines,
    _norm_item,
    _parse_spec,
    _points,
    _render_role,
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
    max_mesh_edges: int | None = 150_000,
    z_exaggeration: float = 5.0,
) -> dict[str, Any]:
    """Build a generic 3-D scene payload from the view2d item conventions.

    ``items`` is normally a list such as ``[points, geometry]``. Accepted duck
    types (identical to :func:`~petektools.viewer.view2d_payload`, plus wells):

    - points: ``xyz()``/``xy()`` or a sequence of ``[x, y, z?]`` rows — a
      colour-coded 3-D point cloud (compact base64 ``f32`` block on the wire)
    - geometry: ``node_xy(i, j)``, ``ncol``, ``nrow``, optional ``edge`` — a
      FLAT lattice grid, clipped to ``edge`` exactly as in 2-D, placed at the
      scene's SHALLOWEST point (a geometry carries no z of its own; z is
      elevation, negative down → shallowest = the scene's max finite z; an
      all-flat scene parks it at ``ref_z``), edge rings at the same level
    - geometry-shell trimesh passed BARE (``kind == "mesh_shell"`` and
      ``triangles()`` over ``xyz()``/``points()``/``nodes()`` vertices, e.g.
      petekio's ``infer_geometry`` result): a
      FLAT WIREFRAME GRID — its unique triangle edges (or
      ``wireframe_edges()``) as lattice lines placed at the SHALLOWEST point
      of its own nodes (max finite vertex z), edge rings at that same level.
      An explicit ``fill=`` remains available for any producer that also
      offers ``value_layer()``
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
    - a value-bearing surface passed BARE (``kind`` is ``"surface"``,
      ``"structured_mesh"``, or ``"tri_surface"``): its STRUCTURE renders as
      a NEUTRAL elevation mesh from the primary value layer
      (value-as-elevation; ``values`` stay null → neutral shading + the
      wireframe toggle — never value-coloured without ``fill=``). Unclassified
      legacy ``.geometry``-bearing / value-bearing items passed bare retain the
      flat lattice fallback at the shallowest point of their own nodes

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

    Each scene item may also be a DICT — the per-object form (owner ruling,
    identical to view2d): ``{"object": obj, "color": bool | spec, "fill":
    bool | spec, "name": str}``. Per-object settings take PRECEDENCE over the
    call-level parameters (which stay the defaults for bare items), ``name``
    overrides the duck-typed display name, and colour/ramp/range travel PER
    LAYER — each point cloud carries its own resolved ``range`` (+ a pinned
    ``colormap`` for a per-object spec; ``colored: false`` for an explicit
    ``color=False``) and each value mesh its own ``colormap``; the legend
    shows each entry's own ramp/range. The global ``scene3d.point_color`` /
    ``scene3d.colormap`` stay emitted as a fallback for older consumers.

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
    outlines: list[Any] = []  # plain rings (ref_z) + {"points", "z"} flat rings
    flat_rings: list[dict[str, Any]] = []  # rings tied to a flat item's level
    layers: list[dict[str, Any]] = []
    summary: dict[str, Any] = {}
    point_zs: list[float] = []
    colored_zs: list[float] = []  # finite zs of per-cloud-coloured points
    item_cmap: str | None = None  # first per-object colormap (global fallback)
    n_points = 0
    n_triangles = 0

    for scene_entry in scene_items:
        item, cspec, fspec, name, c_explicit, f_explicit = _norm_item(
            scene_entry, color_spec, fill_spec
        )
        role = _render_role(item)
        contributed = False
        mesh_added = False

        if fspec["enabled"]:
            entry = _value_mesh(item, fspec["attr"])
            if entry is not None:
                entry["display_name"] = name
                if fspec["range"] is not None:
                    entry["range"] = list(fspec["range"])
                if f_explicit and fspec["cmap"]:
                    entry["colormap"] = fspec["cmap"]  # per-object pin
                    item_cmap = item_cmap or fspec["cmap"]
                meshes.append(entry)
                n_triangles += len(entry["triangles"])
                contributed = True
                mesh_added = True
        if contours is not None:
            iso = _iso_contours(item, contours, cspec["attr"])
            if iso is not None:
                contour_sets.extend(iso)
                layers.append({"kind": "contours", "name": name})
                contributed = True

        # Role metadata wins over overlapping method ducks. All three
        # value-bearing surface levels render as surfaces; their corresponding
        # geometry-only shells continue through the lattice/wireframe paths.
        if role == "surface":
            edge = getattr(item, "edge", None)
            edge_rings = _rings(edge) if edge is not None else []
            if mesh_added:
                outlines.extend(edge_rings)
                continue
            entry = _value_mesh(item, None)
            if entry is None:
                raise TypeError(
                    f"{type(item).__name__} declares surface kind "
                    f"{getattr(item, 'kind', None)!r} but offers no value_layer()"
                )
            entry["values"] = None
            entry["range"] = None
            entry["name"] = "mesh"
            entry["display_name"] = name
            meshes.append(entry)
            n_triangles += len(entry["triangles"])
            continue

        if role == "geometry" and not (_is_geometry(item) or _is_trimesh(item)):
            raise TypeError(
                f"{type(item).__name__} declares geometry kind "
                f"{getattr(item, 'kind', None)!r} but offers neither the structured "
                "node_xy/ncol/nrow duck nor triangles with mesh vertices"
            )

        if _is_geometry(item) and role != "points":
            # a z-less geometry renders as a FLAT lattice at the SCENE's
            # shallowest point (z=None resolves after the loop), edge rings at
            # the same level (owner ruling: flat, never a solid layer).
            edge = getattr(item, "edge", None)
            edge_rings = _rings(edge) if edge is not None else []
            lines = _grid_lines(
                item, max_grid_lines, max_line_points, clip_rings=edge_rings
            )
            lattices.append({"name": name, "lines": lines, "z": None})
            for ring in edge_rings:
                flat_rings.append({"points": ring, "z": None})
            summary["grid"] = f"{int(getattr(item, 'ncol'))} x {int(getattr(item, 'nrow'))}"
            layers.append({"kind": "lines", "name": name})
            continue

        if _is_trimesh(item) and role != "points":
            edge = getattr(item, "edge", None)
            edge_rings = _rings(edge) if edge is not None else []
            if mesh_added:
                # fill= opted this mesh into the value-coloured surface;
                # its edge rings keep the ref_z plane (pre-ruling behaviour)
                outlines.extend(edge_rings)
                continue
            # A bare geometry-shell trimesh (e.g. infer_geometry's MeshShell):
            # a FLAT WIREFRAME GRID at the item's own shallowest point
            # (max finite vertex elevation), edge rings at the same level —
            # value-bearing surface roles were handled above.
            lines, n_tris, edge_stride = _mesh_lines(
                item, max_mesh_edges, max_line_points
            )
            z_flat = _verts_shallowest(_mesh_vertices(item))
            lattices.append({"name": name, "lines": lines, "z": z_flat})
            for ring in edge_rings:
                flat_rings.append({"points": ring, "z": z_flat})
            summary["triangles"] = summary.get("triangles", 0) + n_tris
            if edge_stride > 1:
                summary["mesh_edge_stride"] = edge_stride
            layers.append({"kind": "lines", "name": name})
            continue

        if _is_well(item) and role != "points":
            wells.append(_well_entry(item, name, len(wells)))
            layers.append({"kind": "wells", "name": wells[-1]["id"]})
            continue

        # Stable point metadata is authoritative even if a producer also
        # exposes topology helpers such as edge/rings for other workflows.
        rings = _rings(item) if role != "points" else []
        if rings:
            outlines.extend(rings)
            continue

        pts = _points(item)
        if pts:
            if point_limit is not None and len(pts) > point_limit:
                step = max(1, math.ceil(len(pts) / point_limit))
                pts = pts[::step]
                summary["point_stride"] = step
            zs = [p[2] for p in pts if len(p) > 2 and math.isfinite(p[2])]
            point_zs.extend(zs)
            # Per-cloud colour (per-object color ruling): each cloud carries
            # its OWN resolved clamp range (explicit spec range, else its
            # finite-z data range) and a per-object colormap pin; the global
            # scene3d.point_color/colormap stay the fallback.
            cloud: dict[str, Any] = {"name": name, "n": len(pts), "xyz": _xyz_block(pts)}
            if cspec["enabled"]:
                if zs:
                    rng = cspec["range"] or [min(zs), max(zs)]
                    cloud["range"] = [float(rng[0]), float(rng[1])]
                    colored_zs.extend(zs)
            else:
                cloud["colored"] = False
            if c_explicit and cspec["cmap"]:
                cloud["colormap"] = cspec["cmap"]  # per-object pin
                item_cmap = item_cmap or cspec["cmap"]
            clouds.append(cloud)
            n_points += len(pts)
            layers.append({"kind": "points", "name": name})
            continue

        if contributed:
            continue  # a fill/contour-only item carries no further geometry

        # STRUCTURE fallback for unclassified value-bearing items passed bare.
        # Recognized surfaces were handled above; legacy geometry-ish items
        # render FLAT through their ``.geometry`` lattice lines
        # (or, geometry-less, the primary layer's triangle edges) at the
        # SHALLOWEST point of its own nodes — max finite elevation, the
        # scene's shallowest point when it carries no z — with edge rings at
        # that same level.
        entry = _value_mesh(item, None)
        z_flat = _verts_shallowest(entry["nodes"]) if entry is not None else None
        geom = getattr(item, "geometry", None)
        if geom is not None and _is_geometry(geom):
            edge = getattr(item, "edge", None)
            if edge is None:
                edge = getattr(geom, "edge", None)
            edge_rings = _rings(edge) if edge is not None else []
            lines = _grid_lines(
                geom, max_grid_lines, max_line_points, clip_rings=edge_rings
            )
            lattices.append({"name": name, "lines": lines, "z": z_flat})
            for ring in edge_rings:
                flat_rings.append({"points": ring, "z": z_flat})
            layers.append({"kind": "lines", "name": name})
            continue
        if entry is not None:
            lines, n_tris, edge_stride = _mesh_lines(
                _LayerMesh(entry), max_mesh_edges, max_line_points
            )
            lattices.append({"name": name, "lines": lines, "z": z_flat})
            summary["triangles"] = summary.get("triangles", 0) + n_tris
            if edge_stride > 1:
                summary["mesh_edge_stride"] = edge_stride
            layers.append({"kind": "lines", "name": name})
            continue

        raise TypeError(
            f"cannot add {type(item).__name__} to a 3D view (a value-bearing "
            "item can be value-coloured with fill=)"
        )

    # The GLOBAL fallback for older payload consumers (per-cloud fields win):
    # present only when at least one cloud actually colours — the call-level
    # explicit clamp range when the call-level color= is on, else the union
    # of the coloured clouds' data.
    point_color = None
    if colored_zs:
        rng = (color_spec["range"] if color_spec["enabled"] else None) or [
            min(colored_zs),
            max(colored_zs),
        ]
        point_color = {"by": "z", "range": [float(rng[0]), float(rng[1])]}

    # Resolve z-less flat items (a bare GridGeometry lattice + its rings) to
    # the SCENE's shallowest point (z is elevation, negative down → max
    # finite z over the scene's own data); null when the scene is all-flat
    # (the JS falls back to ref_z).
    scene_shallowest = _scene_shallowest(point_zs, meshes, wells, lattices, flat_rings)
    for lat in lattices:
        if lat["z"] is None:
            lat["z"] = scene_shallowest
    for fr in flat_rings:
        if fr["z"] is None:
            fr["z"] = scene_shallowest
    outlines.extend(flat_rings)

    summary["points"] = n_points
    if meshes:
        summary["meshes"] = len(meshes)
        summary["triangles"] = summary.get("triangles", 0) + n_triangles
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
            "colormap": color_spec["cmap"] or fill_spec["cmap"] or item_cmap,
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
    max_mesh_edges: int | None = 150_000,
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
        max_mesh_edges=max_mesh_edges,
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


def _verts_shallowest(rows: Any) -> float | None:
    """The SHALLOWEST elevation among vertex/node rows — z is elevation
    (negative down), so shallowest = the max finite third component. ``None``
    when no row carries a finite z (a z-less item defers to the scene)."""
    best: float | None = None
    for row in rows:
        vals = list(row)
        if len(vals) < 3 or vals[2] is None:
            continue
        z = float(vals[2])
        if math.isfinite(z) and (best is None or z > best):
            best = z
    return best


def _scene_shallowest(
    point_zs: list[float],
    meshes: list[dict[str, Any]],
    wells: list[dict[str, Any]],
    lattices: list[dict[str, Any]],
    flat_rings: list[dict[str, Any]],
) -> float | None:
    """The scene's shallowest point (max finite elevation over its own data) —
    the fallback level for z-less flat items. ``None`` for an all-flat scene."""
    zs = [z for z in point_zs if math.isfinite(z)]
    for mesh in meshes:
        zs.extend(n[2] for n in mesh["nodes"] if n[2] is not None)
    for well in wells:
        zs.extend(p[2] for p in well["trajectory"] if p[2] is not None)
    zs.extend(lat["z"] for lat in lattices if lat["z"] is not None)
    zs.extend(fr["z"] for fr in flat_rings if fr["z"] is not None)
    if not zs:
        return None
    return float(max(zs))


def _ref_z(
    point_zs: list[float],
    meshes: list[dict[str, Any]],
    wells: list[dict[str, Any]],
) -> float:
    """The flat-element elevation: midpoint of the scene's finite z extent.

    Plain outline rings carry no z of their own and render at this reference
    plane (0.0 for an all-flat scene); it is also the JS fallback for a flat
    lattice whose ``z`` is null (an all-flat scene).
    """
    zs = list(point_zs)
    for mesh in meshes:
        zs.extend(n[2] for n in mesh["nodes"] if n[2] is not None)
    for well in wells:
        zs.extend(p[2] for p in well["trajectory"] if p[2] is not None)
    if not zs:
        return 0.0
    return (min(zs) + max(zs)) / 2.0
