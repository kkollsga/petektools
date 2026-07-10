#!/usr/bin/env python3
"""petektools.viewer unit tests — the horizontal bundle renderer.

Proves the viewer unit renders a typed JSON payload with NO domain library in
sight (no peteksim / petekstatic): the generic render-schema snapshot, the local
server + pluggable ``/section`` provider, the self-contained single-file export,
and the standalone demo (the second-consumer proof of the owner ruling).

    PYTHONPATH=python pytest python/tests/test_viewer.py -q
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
import threading
import urllib.parse
import urllib.request
from pathlib import Path

import pytest

from petektools import viewer
from petektools.viewer import demo

# The generic render schema (SCHEMA.md) — the petekTools viewer contract.
TOP_KEYS = {
    "schema_version", "kind", "property", "properties", "summary",
    "volume", "map", "sections", "section_labels", "wells", "charts",
}
# The generic chart-mark schema (SCHEMA.md § ChartBundle) — schema_version 2.
TORNADO_BAR_KEYS = {"param", "in_lo", "in_hi", "out_lo", "out_hi", "out_min", "out_max", "swing"}
SCATTER_KEYS = {"mark", "title", "x", "y", "color_by", "groups", "points", "trends"}
SCATTER_AXIS_KEYS = {"name", "units", "log"}
DIST_SERIES_KEYS = {"name", "bins", "cdf", "markers"}
MAP_KEYS = {
    "schema_version", "frame", "outline", "horizons",
    "zone_averages", "k_slices", "contacts", "wells", "grid_lines", "points",
}
# v3 VolumeBundle envelope (exterior shell + binary blocks) — petekStatic API.md.
VOLUME_KEYS = {
    "schema_version", "kind", "inputs_ref", "property", "cell_count",
    "shell_cell_count", "vertex_count", "triangle_count", "zone_names",
    "value_range", "encoding", "blocks",
}
VOLUME_BLOCK_KEYS = {"positions", "indices", "tri_cell", "cell_values", "zone_ids"}
_DTYPE_FMT = {"f32": "f", "u32": "I", "u16": "H"}
_DTYPE_SIZE = {"f32": 4, "u32": 4, "u16": 2}


def _decode_block(block: dict) -> tuple:
    """Decode a v3 base64 block's little-endian bytes to a Python tuple."""
    import base64
    import struct

    raw = base64.b64decode(block["data"])
    dtype = block["dtype"]
    n = len(raw) // _DTYPE_SIZE[dtype]
    return struct.unpack("<%d%s" % (n, _DTYPE_FMT[dtype]), raw)
SECTION_KEYS = {
    "schema_version", "property", "top_name", "base_name", "columns", "contacts",
}
FRAME_KEYS = {"origin_x", "origin_y", "spacing_x", "spacing_y", "ncol", "nrow"}
SCALAR_LAYER_KEYS = {"name", "units", "values", "range"}
COLUMN_KEYS = {
    "distance_m", "i", "j", "x", "y", "layer_tops", "layer_bases", "values", "path_z",
}


@pytest.fixture(scope="module")
def payload() -> dict:
    return demo.build_demo_payload()


# --- the viewer unit carries no domain library -------------------------------
def test_no_domain_dependency():
    # importing the viewer unit must never drag in a domain package
    assert "peteksim" not in sys.modules
    assert "petekstatic" not in sys.modules


# --- generic render schema snapshot ------------------------------------------
def test_payload_schema_snapshot(payload):
    assert TOP_KEYS <= set(payload), set(payload)
    assert set(payload["map"]) == MAP_KEYS, set(payload["map"])
    assert set(payload["map"]["frame"]) == FRAME_KEYS
    assert set(payload["map"]["horizons"][0]) == SCALAR_LAYER_KEYS
    assert set(payload["map"]["zone_averages"][0]) == SCALAR_LAYER_KEYS
    assert set(payload["volume"]) == VOLUME_KEYS, set(payload["volume"])
    assert set(payload["sections"][0]) == SECTION_KEYS, set(payload["sections"][0])
    assert set(payload["sections"][0]["columns"][0]) == COLUMN_KEYS


def test_volume_v3_envelope(payload):
    # The demo ships a v3 exterior-shell volume (binary blocks, base64).
    v = payload["volume"]
    assert v["schema_version"] == 3 and v["kind"] == "volume"
    assert v["encoding"] == "base64"
    assert set(v["blocks"]) == VOLUME_BLOCK_KEYS, set(v["blocks"])
    for name, blk in v["blocks"].items():
        assert {"dtype", "shape", "data"} <= set(blk), (name, set(blk))
    assert set(v["value_range"]) == {"min", "max"}


def test_volume_v3_block_shapes_and_dtypes(payload):
    v = payload["volume"]
    V, T, C = v["vertex_count"], v["triangle_count"], v["shell_cell_count"]
    B = v["blocks"]
    assert B["positions"]["dtype"] == "f32" and B["positions"]["shape"] == [V, 3]
    assert B["indices"]["dtype"] == "u32" and B["indices"]["shape"] == [T, 3]
    assert B["tri_cell"]["dtype"] == "u32" and B["tri_cell"]["shape"] == [T]
    assert B["cell_values"]["dtype"] == "f32" and B["cell_values"]["shape"] == [C]
    assert B["zone_ids"]["dtype"] == "u16" and B["zone_ids"]["shape"] == [C]
    # shell is a strict subset of the grid; every zone id indexes zone_names
    assert 0 < C <= v["cell_count"]
    assert max(_decode_block(B["zone_ids"])) < len(v["zone_names"])


def test_volume_v3_blocks_decode_consistently(payload):
    # Round-trip decode the LE blocks: sizes match the manifest, indices reference
    # the vertex list, tri_cell references the compact shell cells.
    v = payload["volume"]
    V, T, C = v["vertex_count"], v["triangle_count"], v["shell_cell_count"]
    pos = _decode_block(v["blocks"]["positions"])
    idx = _decode_block(v["blocks"]["indices"])
    tc = _decode_block(v["blocks"]["tri_cell"])
    cv = _decode_block(v["blocks"]["cell_values"])
    assert len(pos) == V * 3
    assert len(idx) == T * 3 and max(idx) < V  # into the vertex list
    assert len(tc) == T and max(tc) < C  # into the compact shell cells
    assert len(cv) == C
    r = v["value_range"]
    assert r["min"] <= min(cv) <= max(cv) <= r["max"] + 1e-6


def test_map_layer_lengths(payload):
    m = payload["map"]
    f = m["frame"]
    ncell = f["ncol"] * f["nrow"]
    assert len(m["horizons"][0]["values"]) == ncell
    assert len(m["zone_averages"][0]["values"]) == ncell
    assert len(m["contacts"][0]["crossing"]) == ncell


def test_view2d_payload_accepts_points_and_geometry():
    class Geom:
        xori = 100.0
        yori = 200.0
        xinc = 10.0
        yinc = 20.0
        ncol = 3
        nrow = 2
        rotation_deg = 0.0

        def node_xy(self, i, j):
            return (self.xori + i * self.xinc, self.yori + j * self.yinc)

        @property
        def edge(self):
            return self

        def rings(self):
            return [[
                [100.0, 200.0],
                [120.0, 200.0],
                [120.0, 220.0],
                [100.0, 220.0],
                [100.0, 200.0],
            ]]

    class Points:
        def xyz(self):
            return [[100.0, 200.0, -10.0], [110.0, 210.0, -11.0]]

    p = viewer.view2d_payload([Points(), Geom()], title="Top QA")
    assert p["kind"] == "2D"
    assert p["property"] == "Top QA"
    assert p["map"]["schema_version"] == 2
    assert len(p["map"]["points"]) == 2
    assert p["map"]["grid_lines"]
    assert p["map"]["outline"][0][0] == [100.0, 200.0]
    assert p["summary"]["grid"] == "3 x 2"


def test_view2d_payload_keeps_pointsets_as_points_only():
    class TopologyPoints:
        def xyz(self):
            return [
                [0.0, 0.0, 100.0],
                [10.0, 0.0, 101.0],
                [0.0, 10.0, 102.0],
                [12.0, 10.0, 103.0],
            ]

        def attr(self, name):
            if name == "column":
                return [1.0, 2.0, 1.0, 2.0]
            if name == "row":
                return [1.0, 1.0, 2.0, 2.0]
            return None

    p = viewer.view2d_payload([TopologyPoints()], title="Top Agat points")

    assert p["map"]["points"] == [
        [0.0, 0.0, 100.0],
        [10.0, 0.0, 101.0],
        [0.0, 10.0, 102.0],
        [12.0, 10.0, 103.0],
    ]
    assert p["map"]["grid_lines"] == []
    assert "point_topology_grid" not in p["summary"]


def test_view2d_payload_clips_geometry_grid_to_edge():
    class Geom:
        xori = 0.0
        yori = 0.0
        xinc = 10.0
        yinc = 10.0
        ncol = 2
        nrow = 2

        def node_xy(self, i, j):
            return (self.xori + i * self.xinc, self.yori + j * self.yinc)

        @property
        def edge(self):
            return self

        def rings(self):
            return [[[0.0, 0.0], [10.0, 0.0], [0.0, 10.0], [0.0, 0.0]]]

    p = viewer.view2d_payload([Geom()], title="Top Agat QA")

    assert p["summary"]["grid"] == "2 x 2"
    assert p["summary"]["grid_lines"] == 2
    assert p["map"]["outline"][0] == [[0.0, 0.0], [10.0, 0.0], [0.0, 10.0], [0.0, 0.0]]
    assert all([10.0, 10.0] not in line for line in p["map"]["grid_lines"])


class _Mesh:
    """Duck-typed trimesh: two triangles sharing the (1, 2) diagonal."""

    def xyz(self):
        return [
            [0.0, 0.0, 1.0],
            [10.0, 0.0, 2.0],
            [0.0, 10.0, 3.0],
            [10.0, 10.0, 4.0],
        ]

    def triangles(self):
        return [(0, 1, 2), (1, 3, 2)]

    @property
    def edge(self):
        class Edge:
            def rings(self):
                return [[[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0], [0.0, 0.0]]]

        return Edge()


def test_view2d_payload_renders_trimesh_edges_and_edge_outline():
    p = viewer.view2d_payload([_Mesh()], title="Top Agat trimesh")

    drawn = set()
    for line in p["map"]["grid_lines"]:
        for a, b in zip(line, line[1:]):
            drawn.add(frozenset((tuple(a), tuple(b))))
    expected_edges = {
        frozenset(((0.0, 0.0), (10.0, 0.0))),
        frozenset(((10.0, 0.0), (0.0, 10.0))),
        frozenset(((0.0, 10.0), (0.0, 0.0))),
        frozenset(((10.0, 0.0), (10.0, 10.0))),
        frozenset(((10.0, 10.0), (0.0, 10.0))),
    }
    assert drawn == expected_edges
    assert sum(len(line) - 1 for line in p["map"]["grid_lines"]) == 5  # each edge once
    assert p["summary"]["triangles"] == 2
    assert p["map"]["outline"] == [
        [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0], [0.0, 0.0]]
    ]
    assert p["map"]["points"] == []  # a mesh is lines, not a point cloud
    assert "mesh_edge_stride" not in p["summary"]


def test_view2d_payload_flags_major_contour_levels():
    class Contoured:
        def iso_lines(self, interval=None, levels=None, attr=None):
            if interval is not None:  # pretend levels aligned to the interval
                return [(v, [[[0.0, 0.0], [1.0, 1.0]]]) for v in (-150.0, -125.0, -100.0, -75.0)]
            return [(v, [[[0.0, 0.0], [1.0, 1.0]]]) for v in levels]

    p = viewer.view2d_payload([Contoured()], contours=25.0)
    majors = {c["level"]: c["major"] for c in p["map"]["contours"]}
    # 25 m interval -> 100 m index step (4x lands on a round number)
    assert majors == {-150.0: False, -125.0: False, -100.0: True, -75.0: False}

    explicit = viewer.view2d_payload([Contoured()], contours=[-110.0, -100.0])
    assert all(c["major"] is False for c in explicit["map"]["contours"])


def test_view2d_payload_color_codes_points_by_z():
    class Points:
        def xyz(self):
            return [[0.0, 0.0, -10.0], [10.0, 0.0, -30.0], [5.0, 5.0, float("nan")]]

    colored = viewer.view2d_payload([Points()])  # color defaults ON
    assert colored["map"]["point_color"] == {"by": "z", "range": [-30.0, -10.0]}
    assert colored["summary"]["point_color"] == "z"

    plain = viewer.view2d_payload([Points()], color=False)  # explicit opt-out
    assert plain["map"]["point_color"] is None
    assert "point_color" not in plain["summary"]

    class FlatPoints:  # nothing finite in z → no colour coding
        def xy(self):
            return [[0.0, 0.0], [10.0, 0.0]]

    assert viewer.view2d_payload([FlatPoints()], color=True)["map"]["point_color"] is None


def test_view2d_payload_prefers_wireframe_edges_over_derived():
    class QuadMesh(_Mesh):
        def wireframe_edges(self):
            return [(0, 1), (1, 3), (3, 2), (2, 0)]  # the cell, minus its diagonal

    p = viewer.view2d_payload([QuadMesh()])

    drawn = set()
    for line in p["map"]["grid_lines"]:
        for a, b in zip(line, line[1:]):
            drawn.add(frozenset((tuple(a), tuple(b))))
    assert frozenset(((10.0, 0.0), (0.0, 10.0))) not in drawn  # diagonal hidden
    assert sum(len(line) - 1 for line in p["map"]["grid_lines"]) == 4
    assert p["summary"]["triangles"] == 2  # triangle count still reported


def test_view2d_payload_strides_trimesh_edges_over_budget():
    p = viewer.view2d_payload([_Mesh()], max_mesh_edges=2)

    assert sum(len(line) - 1 for line in p["map"]["grid_lines"]) == 2
    assert p["summary"]["mesh_edge_stride"] == 3


def test_view2d_payload_trimesh_without_edge_falls_back_to_frame_rect():
    class BareMesh:
        def points(self):
            return [(0.0, 0.0, 1.0), (10.0, 0.0, 2.0), (0.0, 10.0, 3.0)]

        def triangles(self):
            return [(0, 1, 2)]

    p = viewer.view2d_payload([BareMesh()])

    assert p["summary"]["triangles"] == 1
    assert sum(len(line) - 1 for line in p["map"]["grid_lines"]) == 3
    assert p["map"]["outline"]  # frame-rect fallback still supplies an outline


# --- the color=/fill= spec grammar (registry match) ---------------------------
def test_spec_grammar_registry_match():
    from petektools.viewer._view2d import _parse_spec

    # bools
    assert _parse_spec(True, "color") == {"enabled": True, "attr": None, "cmap": None, "range": None}
    assert _parse_spec(False, "color") == {"enabled": False, "attr": None, "cmap": None, "range": None}
    # a bare colormap name
    assert _parse_spec("inferno", "color") == {"enabled": True, "attr": None, "cmap": "inferno", "range": None}
    # colormap + a NEGATIVE range
    assert _parse_spec("inferno_-2700_-2500", "color") == {
        "enabled": True, "attr": None, "cmap": "inferno", "range": [-2700.0, -2500.0],
    }
    # a non-colormap leading string stays an ATTRIBUTE name (back-compat)
    assert _parse_spec("porosity", "color") == {"enabled": True, "attr": "porosity", "cmap": None, "range": None}
    # combined attr + colormap + range
    assert _parse_spec("porosity_inferno_0_0.3", "color") == {
        "enabled": True, "attr": "porosity", "cmap": "inferno", "range": [0.0, 0.3],
    }
    # the attr may itself contain underscores — cmap matched by registry scan
    assert _parse_spec("net_pay_viridis_-1_1", "fill") == {
        "enabled": True, "attr": "net_pay", "cmap": "viridis", "range": [-1.0, 1.0],
    }
    # every registry name resolves
    for cmap in ("viridis", "magma", "grays", "inferno"):
        assert _parse_spec(cmap, "color")["cmap"] == cmap
    # an attr-only string that HAPPENS to contain no registry token keeps its
    # underscores whole
    assert _parse_spec("net_to_gross", "color")["attr"] == "net_to_gross"


def test_spec_grammar_malformed_raises():
    from petektools.viewer._view2d import _parse_spec

    with pytest.raises(ValueError, match="malformed"):
        _parse_spec("inferno_-2700", "color")  # one trailing float
    with pytest.raises(ValueError, match="malformed"):
        _parse_spec("inferno_a_b", "color")  # non-float range tokens
    with pytest.raises(ValueError, match="malformed"):
        _parse_spec("inferno_1_2_3", "fill")  # too many trailing tokens
    with pytest.raises(ValueError, match="empty"):
        _parse_spec("", "color")
    with pytest.raises(TypeError, match="bool or str"):
        _parse_spec(3, "color")


def test_view2d_color_spec_drives_point_color_and_colormap():
    class Points:
        name = "Top Agat"

        def xyz(self):
            return [[0.0, 0.0, -2600.0], [10.0, 0.0, -2900.0], [5.0, 5.0, -2400.0]]

    # colormap only: data range
    p = viewer.view2d_payload([Points()], color="inferno")
    assert p["map"]["colormap"] == "inferno"
    assert p["map"]["point_color"] == {"by": "z", "range": [-2900.0, -2400.0]}
    # explicit range (negative floats) CLAMPS the normalization — carried as-is
    p = viewer.view2d_payload([Points()], color="inferno_-2700_-2500")
    assert p["map"]["point_color"] == {"by": "z", "range": [-2700.0, -2500.0]}
    assert p["map"]["colormap"] == "inferno"
    # color=True: no colormap pinned, data range
    p = viewer.view2d_payload([Points()], color=True)
    assert p["map"]["colormap"] is None
    assert p["map"]["point_color"]["range"] == [-2900.0, -2400.0]
    # malformed spec surfaces at the payload builder
    with pytest.raises(ValueError, match="malformed"):
        viewer.view2d_payload([Points()], color="inferno_-2700")


def test_view2d_layers_record_duck_typed_names():
    class NamedPoints:
        name = "Top Agat"

        def xyz(self):
            return [[0.0, 0.0, -10.0], [10.0, 10.0, -20.0]]

    class Geom:
        # no `name` → the legend falls back to the layer kind
        xori = 0.0
        yori = 0.0
        xinc = 10.0
        yinc = 10.0
        ncol = 2
        nrow = 2

        def node_xy(self, i, j):
            return (i * 10.0, j * 10.0)

    p = viewer.view2d_payload([NamedPoints(), Geom()], color=True)
    assert p["map"]["layers"] == [
        {"kind": "points", "name": "Top Agat"},
        {"kind": "lines", "name": None},
    ]


# --- value-coloured fills + contour lines (view2d fill= / contours=) ----------
class _ValueMesh(_Mesh):
    """Duck-typed trimesh that also offers the value seam:
    ``value_layer(attr=None)`` + ``iso_lines(interval|levels, attr=None)``."""

    def __init__(self):
        self.seen: dict = {}

    def value_layer(self, attr=None):
        self.seen["value_attr"] = attr
        return {
            "kind": "trimesh",
            "name": attr or "z",
            "nodes": [[0.0, 0.0], [10.0, 0.0], [0.0, 10.0], [10.0, 10.0]],
            "triangles": [[0, 1, 2], [1, 3, 2]],
            "values": [1.0, 2.0, 3.0, float("nan")],
            "range": [1.0, 4.0],
        }

    def iso_lines(self, interval=None, levels=None, attr=None):
        self.seen["iso"] = {"interval": interval, "levels": levels, "attr": attr}
        return [
            (1.5, [[[0.0, 1.0], [5.0, 6.0]]]),
            (2.5, [[[0.0, 3.0], [5.0, 8.0]], [[6.0, 3.0], [9.0, 8.0]]]),
        ]


def test_view2d_fill_true_adds_fill_and_keeps_mesh_lines():
    mesh = _ValueMesh()
    p = viewer.view2d_payload([mesh], fill=True)

    assert mesh.seen["value_attr"] is None  # primary layer requested
    assert len(p["map"]["fills"]) == 1
    fill = p["map"]["fills"][0]
    assert set(fill) == {"name", "nodes", "triangles", "values", "range", "display_name"}
    assert fill["name"] == "z"
    assert fill["display_name"] is None  # _ValueMesh carries no `name`
    assert fill["nodes"] == [[0.0, 0.0], [10.0, 0.0], [0.0, 10.0], [10.0, 10.0]]
    assert fill["triangles"] == [[0, 1, 2], [1, 3, 2]]
    assert fill["values"][:3] == [1.0, 2.0, 3.0]
    assert fill["values"][3] is None  # NaN travels as JSON null (renderer skips)
    assert fill["range"] == [1.0, 4.0]
    # the mesh still contributes its grid lines exactly as before (fills render UNDER)
    assert p["summary"]["triangles"] == 2
    assert sum(len(line) - 1 for line in p["map"]["grid_lines"]) == 5
    assert p["summary"]["fills"] == 1
    assert p["map"]["contours"] == []  # contours not requested


def test_view2d_color_true_no_longer_fills_a_value_layer_item():
    # THE decision-2 gate: fills come ONLY from fill= — color=True over an item
    # offering value_layer() colours points/lines, never a filled trimesh.
    mesh = _ValueMesh()
    p = viewer.view2d_payload([mesh], color=True)
    assert p["map"]["fills"] == []
    assert "fills" not in p["summary"]
    assert "value_attr" not in mesh.seen  # value_layer() never even called
    # the mesh still contributes its lines
    assert sum(len(line) - 1 for line in p["map"]["grid_lines"]) == 5


def test_view2d_fill_false_ignores_value_layer():
    p = viewer.view2d_payload([_ValueMesh()])  # fill defaults to False
    assert p["map"]["fills"] == []
    assert "fills" not in p["summary"]


def test_view2d_fill_attr_string_passes_through():
    mesh = _ValueMesh()
    p = viewer.view2d_payload([mesh], fill="phi", color="phi", contours=[1.5, 2.5])
    assert mesh.seen["value_attr"] == "phi"
    assert p["map"]["fills"][0]["name"] == "phi"
    # the COLOR spec's attr forwards to iso_lines (back-compat)
    assert mesh.seen["iso"] == {"interval": None, "levels": [1.5, 2.5], "attr": "phi"}


def test_view2d_fill_spec_overrides_range_and_sets_colormap():
    mesh = _ValueMesh()
    p = viewer.view2d_payload([mesh], fill="magma_0_2")
    assert p["map"]["fills"][0]["range"] == [0.0, 2.0]  # user range wins
    assert p["map"]["colormap"] == "magma"
    # color's colormap wins over fill's when both are given
    mesh2 = _ValueMesh()
    p2 = viewer.view2d_payload([mesh2], color="inferno", fill="magma")
    assert p2["map"]["colormap"] == "inferno"
    assert p2["map"]["fills"][0]["range"] == [1.0, 4.0]  # producer range kept


def test_view2d_fill_records_item_display_name():
    class NamedMesh(_ValueMesh):
        name = "Top Agat"

    p = viewer.view2d_payload([NamedMesh()], fill=True)
    assert p["map"]["fills"][0]["display_name"] == "Top Agat"


def test_view2d_contours_interval_and_levels_forms():
    mesh = _ValueMesh()
    p = viewer.view2d_payload([mesh], contours=25.0)
    assert mesh.seen["iso"] == {"interval": 25.0, "levels": None, "attr": None}
    assert [c["level"] for c in p["map"]["contours"]] == [1.5, 2.5]
    assert p["map"]["contours"][0]["lines"] == [[[0.0, 1.0], [5.0, 6.0]]]
    assert len(p["map"]["contours"][1]["lines"]) == 2
    assert p["summary"]["contour_levels"] == 2
    assert p["map"]["fills"] == []  # color not requested

    mesh2 = _ValueMesh()
    viewer.view2d_payload([mesh2], contours=[1.5, 2.5])
    assert mesh2.seen["iso"] == {"interval": None, "levels": [1.5, 2.5], "attr": None}


def test_view2d_color_without_methods_is_silent():
    # a plain mesh (no value_layer / iso_lines) + color/fill/contours → no
    # fill, no contours, no error
    p = viewer.view2d_payload([_Mesh()], color=True, fill=True, contours=10.0)
    assert p["map"]["fills"] == []
    assert p["map"]["contours"] == []
    assert p["summary"]["triangles"] == 2


def test_view2d_malformed_value_layer_raises():
    class BadMesh(_Mesh):
        def value_layer(self, attr=None):
            return {"name": "z", "nodes": [[0.0, 0.0]], "triangles": []}  # no values/range

    with pytest.raises(TypeError, match="missing key"):
        viewer.view2d_payload([BadMesh()], fill=True)


# --- stride-ladder LOD (view2d lod=) ------------------------------------------
class _LodMesh:
    """A trimesh whose producer ducks accept the LOD striding kwargs:
    ``value_layer(stride=)``, ``wireframe_edges(stride=)``, ``iso_lines(simplify=)``.
    A coarse call (stride > 1 / simplify set) returns a decimated ring; it records
    every kwarg it saw so the tests can assert the derived defaults."""

    name = "Top"

    def __init__(self):
        self.seen: dict = {}

    def xyz(self):
        return [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [0.0, 10.0, 0.0], [10.0, 10.0, 0.0]]

    def points(self):
        return self.xyz()

    def triangles(self):
        return [(0, 1, 2), (1, 3, 2)]

    def wireframe_edges(self, stride=None):
        self.seen["wf_stride"] = stride
        if stride and stride > 1:
            return [(0, 1), (1, 3)]
        return [(0, 1), (1, 2), (2, 3), (3, 0), (0, 3)]

    def value_layer(self, attr=None, stride=None):
        self.seen.setdefault("vl_strides", []).append(stride)
        if stride and stride > 1:
            return {"name": attr or "z", "nodes": [[0.0, 0.0], [10.0, 10.0]],
                    "triangles": [(0, 1, 0)], "values": [1.0, 2.0], "range": [1.0, 4.0]}
        return {"name": attr or "z",
                "nodes": [[0.0, 0.0], [10.0, 0.0], [0.0, 10.0], [10.0, 10.0]],
                "triangles": [(0, 1, 2), (1, 3, 2)], "values": [1.0, 2.0, 3.0, 4.0],
                "range": [1.0, 4.0]}

    def iso_lines(self, interval=None, levels=None, attr=None, simplify=None):
        self.seen.setdefault("iso_simplify", []).append(simplify)
        # same LEVELS full vs coarse (only the geometry is simplified) — a real
        # Douglas–Peucker producer keeps the level set, so full and coarse align
        if simplify:
            return [(1.5, [[[0.0, 1.0], [5.0, 6.0]]]),
                    (2.5, [[[0.0, 3.0], [10.0, 8.0]]])]
        return [(1.5, [[[0.0, 1.0], [2.0, 3.0], [5.0, 6.0]]]),
                (2.5, [[[0.0, 3.0], [10.0, 8.0]]])]


def test_view2d_lod_emits_full_and_coarse_rings():
    mesh = _LodMesh()
    p = viewer.view2d_payload([mesh], fill=True, contours=25.0, lod=True, encoding="json")
    m = p["map"]
    # fill LOD ring: additive `lod` sub-dict, full-res range kept (stable colours)
    lod = m["fills"][0]["lod"]
    assert set(lod) == {"stride", "nodes", "triangles", "values", "range"}
    assert lod["stride"] == 4
    assert lod["nodes"] == [[0.0, 0.0], [10.0, 10.0]]
    assert lod["triangles"] == [[0, 1, 0]]
    assert lod["range"] == [1.0, 4.0]  # the FULL-res range, not a coarse re-range
    # coarse mesh grid lines: fewer unique edges than the full ring (2 vs 4;
    # the full wireframe's (3,0)/(0,3) collapse to one undirected edge)
    assert "grid_lines_lod" in m
    assert sum(len(l) - 1 for l in m["grid_lines_lod"]) == 2
    assert sum(len(l) - 1 for l in m["grid_lines"]) == 4
    assert mesh.seen["wf_stride"] == 4
    # coarse contour ring on each set
    assert all("lines_lod" in c for c in m["contours"])
    assert m["contours"][0]["lines_lod"] == [[[0.0, 1.0], [5.0, 6.0]]]


def test_view2d_lod_false_emits_no_rings():
    mesh = _LodMesh()
    p = viewer.view2d_payload([mesh], fill=True, contours=25.0, lod=False, encoding="json")
    m = p["map"]
    assert "lod" not in m["fills"][0]
    assert "grid_lines_lod" not in m
    assert all("lines_lod" not in c for c in m["contours"])
    # the producer's coarse (stride>1) path was never requested
    assert all(s is None for s in mesh.seen.get("vl_strides", []))
    assert mesh.seen.get("wf_stride") is None
    assert all(s is None for s in mesh.seen.get("iso_simplify", []))


def test_view2d_lod_default_matches_lod_false_when_unsupported():
    # A producer whose ducks DON'T accept the striding kwargs: lod=True must
    # feature-detect (TypeError) and degrade to a payload byte-identical to
    # lod=False (the "no coarse ring, no error, no change" contract).
    on = viewer.view2d_payload([_ValueMesh()], fill=True, contours=25.0, lod=True, encoding="json")
    off = viewer.view2d_payload([_ValueMesh()], fill=True, contours=25.0, lod=False, encoding="json")
    assert json.dumps(on, sort_keys=True) == json.dumps(off, sort_keys=True)
    assert "lod" not in on["map"]["fills"][0]


def test_view2d_lod_feature_detect_fill_fallback():
    # The explicit mock from the brief: value_layer rejects stride → no ring, no
    # error. _ValueMesh.value_layer(self, attr=None) has no `stride` parameter.
    p = viewer.view2d_payload([_ValueMesh()], fill=True, lod=True, encoding="json")
    assert "lod" not in p["map"]["fills"][0]
    assert p["map"]["fills"][0]["nodes"]  # the full ring is unaffected


def test_view2d_lod_simplify_default_derives_from_extent():
    mesh = _LodMesh()
    viewer.view2d_payload([mesh], contours=25.0, lod=True, encoding="json")
    # full contour coords span x 0..10, y 1..8 → max extent 10 → simplify 10/512
    simplifies = [s for s in mesh.seen["iso_simplify"] if s is not None]
    assert len(simplifies) == 1
    assert simplifies[0] == pytest.approx(10.0 / 512.0)


def test_view2d_lod_tuple_overrides_stride_and_simplify():
    mesh = _LodMesh()
    p = viewer.view2d_payload([mesh], fill=True, contours=25.0, lod=(8, 2.5), encoding="json")
    assert p["map"]["fills"][0]["lod"]["stride"] == 8
    assert mesh.seen["wf_stride"] == 8
    assert 8 in mesh.seen["vl_strides"]
    assert 2.5 in mesh.seen["iso_simplify"]  # explicit simplify, not the auto value
    # single-element tuple = stride only, simplify auto
    mesh2 = _LodMesh()
    viewer.view2d_payload([mesh2], fill=True, lod=(6,), encoding="json")
    assert 6 in mesh2.seen["vl_strides"]


def test_view2d_lod_rejects_bad_tuple():
    with pytest.raises(ValueError, match="stride must be >= 2"):
        viewer.view2d_payload([_LodMesh()], lod=(1,))
    with pytest.raises(ValueError, match=r"\(stride,\) or \(stride, simplify\)"):
        viewer.view2d_payload([_LodMesh()], lod=(2, 3, 4))


def test_view2d_lod_rings_are_block_encoded():
    # With blocks on (threshold 0), every LOD ring is a typed block / CSR marker
    # in the same table as the full rings, and round-trips.
    mesh = _LodMesh()
    p = viewer.view2d_payload([mesh], fill=True, contours=25.0, lod=True,
                              encoding="blocks", block_threshold_bytes=0)
    m = p["map"]
    lod = m["fills"][0]["lod"]
    assert set(lod["nodes"]) == {"__block__"}
    assert set(lod["triangles"]) == {"__block__"}
    assert set(lod["values"]) == {"__block__"}
    assert set(m["grid_lines_lod"]) == {"__csr__"}
    assert all(set(c["lines_lod"]) == {"__csr__"} for c in m["contours"])
    table = m["blocks"]
    # the coarse fill nodes decode back to the 2-node coarse ring
    coarse_nodes = _decode_block(table[lod["nodes"]["__block__"]])
    assert list(coarse_nodes) == [0.0, 0.0, 10.0, 10.0]


# --- bare value-bearing items (the petekio regular-Surface duck) ---------------
class _SurfaceGeom:
    xori = 0.0
    yori = 0.0
    xinc = 10.0
    yinc = 10.0
    ncol = 3
    nrow = 3

    def node_xy(self, i, j):
        return (i * 10.0, j * 10.0)


class _SurfaceDuck:
    """The petekio regular-Surface shape: ``value_layer()``/``iso_lines()`` +
    a 2-D ``.geometry`` (GridGeometry duck), ``name``/``kind`` — and NO
    top-level ``node_xy``/``triangles``/``xyz``."""

    name = "Top Agat"
    kind = "surface"
    geometry = _SurfaceGeom()

    def __init__(self):
        self.seen: dict = {}

    def value_layer(self, attr=None):
        self.seen["value_attr"] = attr
        return {
            "name": attr or "z",
            "nodes": [[0.0, 0.0], [10.0, 0.0], [0.0, 10.0], [10.0, 10.0]],
            "triangles": [[0, 1, 2], [1, 3, 2]],
            "values": [-2600.0, -2610.0, -2620.0, -2630.0],
            "range": [-2630.0, -2600.0],
        }

    def iso_lines(self, interval=None, levels=None, attr=None):
        return [(-2610.0, [[[0.0, 0.0], [10.0, 10.0]]])]


def test_view2d_bare_surface_renders_structure_lines():
    # the natural flow view2d([pts, surf]) must not die: a bare Surface shows
    # its STRUCTURE (the .geometry lattice), never a bare-color fill
    surf = _SurfaceDuck()
    p = viewer.view2d_payload([surf])  # color defaults ON; no fill=
    assert p["map"]["fills"] == []                # values stay fill= opt-in
    assert "value_attr" not in surf.seen          # value_layer never consulted
    assert p["map"]["grid_lines"]                 # .geometry lattice drawn
    assert p["summary"]["grid"] == "3 x 3"
    assert {"kind": "lines", "name": "Top Agat"} in p["map"]["layers"]


def test_view2d_bare_value_layer_only_item_draws_mesh_edges():
    # geometry-less value-bearing item: the primary layer's triangle edges
    # become the drawn structure (still no fill without fill=)
    class LayerOnly:
        name = "Top Agat"

        def value_layer(self, attr=None):
            return _SurfaceDuck().value_layer(attr)

    p = viewer.view2d_payload([LayerOnly()])
    assert p["map"]["fills"] == []
    assert sum(len(line) - 1 for line in p["map"]["grid_lines"]) == 5  # unique edges
    assert p["summary"]["triangles"] == 2
    assert {"kind": "lines", "name": "Top Agat"} in p["map"]["layers"]


def test_view2d_surface_with_fill_unchanged():
    surf = _SurfaceDuck()
    p = viewer.view2d_payload([surf], fill=True, contours=[-2610.0])
    assert len(p["map"]["fills"]) == 1
    assert p["map"]["fills"][0]["display_name"] == "Top Agat"
    assert surf.seen["value_attr"] is None
    assert p["summary"]["contour_levels"] == 1


def test_view2d_unrenderable_item_error_mentions_fill():
    with pytest.raises(TypeError, match=r"cannot add.*fill="):
        viewer.view2d_payload([object()])


# --- view3d: the scene3d bundle (full view2d parity in one 3-D scene) ---------
SCENE3D_KEYS = {
    "schema_version", "points", "meshes", "lattices", "contours", "wells",
    "outlines", "layers", "point_color", "colormap", "z_exaggeration", "ref_z",
}
MESH3D_KEYS = {"name", "display_name", "nodes", "triangles", "values", "range"}


def _decode_xyz(block: dict) -> tuple:
    """Decode a scene3d f32 [n, 3] point block (base64, little-endian) — the
    same wire the viewer's decode kernel reads."""
    import base64
    import struct

    raw = base64.b64decode(block["data"])
    n = len(raw) // 4
    return struct.unpack("<%df" % n, raw)


class _Points3D:
    name = "Top Agat"

    def xyz(self):
        return [[0.0, 0.0, -2600.0], [10.0, 0.0, -2900.0], [5.0, 5.0]]  # one z-less row


class _Geom3D:
    name = "Agat grid"
    xori = 0.0
    yori = 0.0
    xinc = 100.0
    yinc = 100.0
    ncol = 3
    nrow = 3

    def node_xy(self, i, j):
        return (i * 100.0, j * 100.0)


class _Well3D:
    name = "31/2-A"

    def trajectory(self):
        return [[0.0, 0.0, -2400.0], [50.0, 50.0, -2600.0]]


def test_view3d_payload_points_and_geometry_classification():
    p = viewer.view3d_payload([_Points3D(), _Geom3D()], color="inferno_-2700_-2500")
    assert p["kind"] == "3D" and p["map"] is None and p["volume"] is None
    sc = p["scene3d"]
    assert set(sc) == SCENE3D_KEYS, set(sc)
    # item classification parity: a point cloud + a geometry lattice, with the
    # SAME duck-typed legend names view2d records
    assert sc["layers"] == [
        {"kind": "points", "name": "Top Agat"},
        {"kind": "lines", "name": "Agat grid"},
    ]
    assert len(sc["lattices"]) == 1 and sc["lattices"][0]["lines"]
    assert p["summary"]["grid"] == "3 x 3" and p["summary"]["points"] == 3
    # the spec grammar is the view2d grammar: colormap pinned + clamp range
    assert sc["colormap"] == "inferno"
    assert sc["point_color"] == {"by": "z", "range": [-2700.0, -2500.0]}
    # the point cloud travels as ONE compact f32 [n, 3] block; a z-less row is NaN
    cloud = sc["points"][0]
    assert cloud["name"] == "Top Agat" and cloud["n"] == 3
    assert cloud["xyz"]["dtype"] == "f32" and cloud["xyz"]["shape"] == [3, 3]
    vals = _decode_xyz(cloud["xyz"])
    assert vals[:6] == (0.0, 0.0, -2600.0, 10.0, 0.0, -2900.0)
    assert vals[6:8] == (5.0, 5.0) and vals[8] != vals[8]  # NaN z


def test_view3d_grammar_is_view2d_grammar():
    # bare colormap → data range; attribute string stays an attribute (no cmap)
    p = viewer.view3d_payload([_Points3D()], color="inferno")
    assert p["scene3d"]["colormap"] == "inferno"
    assert p["scene3d"]["point_color"]["range"] == [-2900.0, -2600.0]
    p = viewer.view3d_payload([_Points3D()], color="porosity")
    assert p["scene3d"]["colormap"] is None
    # color=False → monochrome (no point_color)
    p = viewer.view3d_payload([_Points3D()], color=False)
    assert p["scene3d"]["point_color"] is None
    # malformed specs raise exactly like view2d
    with pytest.raises(ValueError, match="malformed"):
        viewer.view3d_payload([_Points3D()], color="inferno_-2700")
    with pytest.raises(ValueError, match="malformed"):
        viewer.view3d_payload([_Points3D()], fill="magma_a_b")


def test_view3d_fill_surface_takes_z_from_primary_values():
    # a surface duck (value_layer only, 2-D nodes): the PRIMARY layer's values
    # are its elevation, so fill=True yields a 3-D value-coloured mesh
    mesh = _ValueMesh()
    p = viewer.view3d_payload([mesh], fill=True)
    sc = p["scene3d"]
    assert mesh.seen["value_attr"] is None
    assert len(sc["meshes"]) == 1
    m = sc["meshes"][0]
    assert set(m) == MESH3D_KEYS, set(m)
    assert m["name"] == "z" and m["display_name"] is None
    # 2-D nodes lifted to 3-D: z == the layer value; the NaN-valued node is gapped
    assert m["nodes"][:3] == [[0.0, 0.0, 1.0], [10.0, 0.0, 2.0], [0.0, 10.0, 3.0]]
    assert m["nodes"][3] == [10.0, 10.0, None]
    assert m["values"][:3] == [1.0, 2.0, 3.0] and m["values"][3] is None
    assert m["range"] == [1.0, 4.0]
    assert p["summary"]["meshes"] == 1 and p["summary"]["triangles"] == 2


def test_view3d_fill_spec_overrides_range_and_attr_stays_flat():
    mesh = _ValueMesh()
    p = viewer.view3d_payload([mesh], fill="magma_0_2")
    assert p["scene3d"]["meshes"][0]["range"] == [0.0, 2.0]  # user clamp wins
    assert p["scene3d"]["colormap"] == "magma"
    # an ATTRIBUTE fill over 2-D nodes stays gapped (values are not elevations)
    mesh2 = _ValueMesh()
    p2 = viewer.view3d_payload([mesh2], fill="phi")
    assert mesh2.seen["value_attr"] == "phi"
    assert all(n[2] is None for n in p2["scene3d"]["meshes"][0]["nodes"])


def test_view3d_trimesh_neutral_vs_value_colored():
    # no fill: a trimesh renders as ONE neutral mesh (values None — the JS gives
    # it the neutral material + the wireframe option)
    p = viewer.view3d_payload([_ValueMesh()])
    assert len(p["scene3d"]["meshes"]) == 1
    m = p["scene3d"]["meshes"][0]
    assert m["values"] is None and m["range"] is None and m["name"] == "mesh"
    assert m["nodes"][0] == [0.0, 0.0, 1.0]  # xyz vertices carry their own z
    # fill=: the value_layer IS the surface — one value-coloured mesh, never a
    # neutral duplicate on top
    p2 = viewer.view3d_payload([_ValueMesh()], fill=True)
    assert len(p2["scene3d"]["meshes"]) == 1
    assert p2["scene3d"]["meshes"][0]["values"] is not None


def test_view3d_wells_duck_type():
    p = viewer.view3d_payload([_Well3D(), _Points3D()])
    sc = p["scene3d"]
    assert sc["wells"] == [
        {"id": "31/2-A", "trajectory": [[0.0, 0.0, -2400.0], [50.0, 50.0, -2600.0]]}
    ]
    assert {"kind": "wells", "name": "31/2-A"} in sc["layers"]
    assert p["summary"]["wells"] == 1

    class BadWell:
        def trajectory(self):
            return [[0.0, 0.0]]  # no z — not a 3-D bore path

    with pytest.raises(TypeError, match="x, y, z"):
        viewer.view3d_payload([BadWell()])


def test_view3d_contours_reuse_view2d_seam():
    mesh = _ValueMesh()
    p = viewer.view3d_payload([mesh], contours=25.0, color="porosity")
    # the same iso_lines forwarding as view2d (interval + the color attr)
    assert mesh.seen["iso"] == {"interval": 25.0, "levels": None, "attr": "porosity"}
    cs = p["scene3d"]["contours"]
    assert [c["level"] for c in cs] == [1.5, 2.5]
    assert all({"level", "major", "lines"} == set(c) for c in cs)
    assert p["summary"]["contour_levels"] == 2


def test_view3d_point_decimation_cap():
    class Cloud:
        name = "big"

        def xyz(self):
            return [[float(i), 0.0, -float(i)] for i in range(250)]

    p = viewer.view3d_payload([Cloud()], point_limit=100)
    sc = p["scene3d"]
    assert p["summary"]["point_stride"] == 3
    cloud = sc["points"][0]
    assert cloud["n"] == 84 and cloud["xyz"]["shape"] == [84, 3]
    # the colour range reads the DECIMATED cloud (parity with view2d)
    assert sc["point_color"]["range"] == [-249.0, 0.0]


def test_view3d_z_exaggeration_and_ref_z():
    # the z-exag slider seed defaults to the volume tab's 5x, overridable
    assert viewer.view3d_payload([_Points3D()])["scene3d"]["z_exaggeration"] == 5.0
    p = viewer.view3d_payload([_Points3D()], z_exaggeration=12)
    assert p["scene3d"]["z_exaggeration"] == 12.0
    # ref_z (the flat-lattice/outline elevation) is the scene z-extent midpoint
    assert p["scene3d"]["ref_z"] == -2750.0
    # an all-flat scene (no z anywhere) parks the reference plane at 0
    assert viewer.view3d_payload([_Geom3D()])["scene3d"]["ref_z"] == 0.0


def test_view3d_bare_surface_renders_neutral_elevation_mesh():
    # the natural flow view3d([pts, surf]) must not die: a bare Surface shows
    # its STRUCTURE as a NEUTRAL elevation mesh (never value-coloured)
    surf = _SurfaceDuck()
    p = viewer.view3d_payload([surf])  # no fill=
    sc = p["scene3d"]
    assert len(sc["meshes"]) == 1
    m = sc["meshes"][0]
    assert set(m) == MESH3D_KEYS, set(m)
    assert m["values"] is None and m["range"] is None  # NEUTRAL — wireframe path
    assert m["name"] == "mesh" and m["display_name"] == "Top Agat"
    # value-as-elevation: the primary layer's values became the node z
    assert [n[2] for n in m["nodes"]] == [-2600.0, -2610.0, -2620.0, -2630.0]
    assert p["summary"]["meshes"] == 1 and p["summary"]["triangles"] == 2
    assert sc["ref_z"] == -2615.0  # mesh nodes still feed the reference plane


def test_view3d_surface_with_fill_unchanged():
    p = viewer.view3d_payload([_SurfaceDuck()], fill=True)
    m = p["scene3d"]["meshes"][0]
    assert m["values"] == [-2600.0, -2610.0, -2620.0, -2630.0]
    assert m["range"] == [-2630.0, -2600.0]
    assert m["name"] == "z" and m["display_name"] == "Top Agat"
    assert len(p["scene3d"]["meshes"]) == 1  # never a neutral duplicate


def test_view3d_geometry_only_item_falls_back_to_lattice():
    class GeomHolder:
        name = "holder"
        geometry = _SurfaceGeom()

    p = viewer.view3d_payload([GeomHolder()])
    sc = p["scene3d"]
    assert sc["meshes"] == [] and len(sc["lattices"]) == 1 and sc["lattices"][0]["lines"]
    assert {"kind": "lines", "name": "holder"} in sc["layers"]


def test_view3d_rejects_unknown_items():
    with pytest.raises(TypeError, match=r"cannot add.*fill="):
        viewer.view3d_payload([object()])


def test_view3d_save_is_self_contained(tmp_path):
    import petektools

    assert petektools.view3d is viewer.view3d  # exported at the package root
    out = tmp_path / "view3d.html"
    got = viewer.view3d([_Points3D(), _Geom3D()], save=out)
    assert got == str(out)
    html = out.read_text()
    assert "window.PETEK_VIEWER_PAYLOAD=" in html and '"scene3d"' in html
    assert "<script src=" not in html  # zero external fetches


# --- the generic chart-mark schema (Charts tab) ------------------------------
def test_schema_version_bumped(payload):
    assert payload["schema_version"] == 3  # v3: volume exterior-shell + binary blocks


def test_demo_carries_one_of_each_mark(payload):
    marks = {c["mark"] for c in payload["charts"]}
    assert {"tornado", "scatter", "distribution"} <= marks, marks


def test_tornado_bundle_shape(payload):
    t = next(c for c in payload["charts"] if c["mark"] == "tornado")
    assert {"mark", "title", "units", "base", "bars", "fold_count"} <= set(t)
    assert isinstance(t["base"], (int, float)) and t["bars"]
    for bar in t["bars"]:
        assert set(bar) <= TORNADO_BAR_KEYS, set(bar)
        assert {"param", "out_lo", "out_hi"} <= set(bar)


def test_scatter_bundle_shape(payload):
    s = next(c for c in payload["charts"] if c["mark"] == "scatter")
    assert set(s) == SCATTER_KEYS, set(s)
    assert set(s["x"]) == SCATTER_AXIS_KEYS and set(s["y"]) == SCATTER_AXIS_KEYS
    assert s["y"]["log"] is True  # perm on a log axis (petroleum convention)
    assert s["color_by"]["kind"] == "categorical"
    assert s["points"] and {"x", "y", "c"} <= set(s["points"][0])
    for tr in s["trends"]:  # render-only: coefficients arrive in the payload
        assert {"x0", "y0", "x1", "y1", "slope", "intercept", "r2", "equation"} <= set(tr)


def test_distribution_bundle_shape(payload):
    d = next(c for c in payload["charts"] if c["mark"] == "distribution")
    assert {"mark", "title", "units", "series"} <= set(d)
    for s in d["series"]:
        assert set(s) == DIST_SERIES_KEYS, set(s)
        assert s["bins"] and {"lo", "hi", "count"} <= set(s["bins"][0])
        assert s["cdf"] and {"x", "exceedance"} <= set(s["cdf"][0])
        assert {"p90", "p50", "p10"} <= set(s["markers"])
        # reservoir convention: P90 is the low case, P10 the high
        assert s["markers"]["p90"] <= s["markers"]["p50"] <= s["markers"]["p10"]


# --- the single-file export is self-contained (confidential-data hard rule) ---
def test_save_view_self_contained(payload):
    out = Path(tempfile.mkdtemp()) / "view.html"
    viewer.save_view(payload, out)
    html = out.read_text()
    assert "window.PETEK_VIEWER_PAYLOAD=" in html
    assert 'window.PETEK_VIEWER_MODE="file"' in html
    assert "THREE" in html and "OrbitControls" in html
    # the v3 decode kernel + inline-worker source are inlined too (no companion file)
    assert "PETEK_DECODE" in html and "workerSource" in html
    assert "<script src=" not in html
    assert "<link" not in html
    for pat in (r'src\s*=\s*["\']https?:', r'href\s*=\s*["\']https?:',
                r'@import', r'url\(\s*https?:', r'fetch\(\s*["\']https?:'):
        assert not re.search(pat, html), pat


# --- viewer.js is assembled from ordered concat parts (build-time concat) -----
def test_viewer_bundle_assembles_one_iife():
    from petektools.viewer import _bundle

    parts = sorted(_bundle._PARTS_DIR.glob("*.js"))
    assert len(parts) >= 2, "viewer.js is maintained as ordered concat parts"
    src = _bundle.viewer_js()
    # One shared-closure IIFE: the first part opens it, the last part closes it,
    # and no part is a runtime module (zero-CDN rule: concat, never import).
    assert src.count('"use strict"') == 1
    assert src.rstrip().endswith("})();")
    assert "import " not in src.split("\n")[0]
    # Every part contributes (no empty fragment silently dropped from the bundle).
    assert all(p.read_text().strip() for p in parts)


def test_viewer_bundle_parses_under_node(tmp_path):
    """The assembled bundle is syntactically valid JS (`node --check`). The parts
    are IIFE fragments (not standalone) — only the concatenation is checkable, and
    it is the artifact the browser actually loads."""
    import shutil
    import subprocess

    node = shutil.which("node")
    if node is None:
        pytest.skip("node not available")
    from petektools.viewer import _bundle

    src = tmp_path / "viewer.js"
    src.write_text(_bundle.viewer_js())
    out = subprocess.run([node, "--check", str(src)], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr


def test_save_view_accepts_json_string(payload):
    out = Path(tempfile.mkdtemp()) / "view.html"
    viewer.save_view(json.dumps(payload), out)  # a pre-serialized string, too
    assert "window.PETEK_VIEWER_PAYLOAD=" in out.read_text()


def test_save_view_precomputed_sections(payload):
    extra = dict(payload["sections"][0])
    out = Path(tempfile.mkdtemp()) / "view.html"
    # strip baked sections, then inject one via precomputed_sections
    bare = dict(payload, sections=[], section_labels=[])
    viewer.save_view(bare, out, precomputed_sections=[extra])
    html = out.read_text()
    m = re.search(r"window\.PETEK_VIEWER_PAYLOAD=(.*?);window\.PETEK_VIEWER_MODE", html)
    baked = json.loads(m.group(1).replace("<\\/", "</"))
    assert len(baked["sections"]) == 1
    assert len(baked["section_labels"]) == 1


# --- the local server: start, GET /, GET /model.json, GET /section, shutdown --
def test_server_smoke_and_section_provider(payload):
    seen = {}

    def provider(line=None, well=None, property=None):
        seen["line"], seen["property"] = line, property
        return {
            "schema_version": 1, "property": property or "PORO",
            "top_name": "T", "base_name": "B", "contacts": [],
            "columns": [{
                "distance_m": 0.0, "i": 0, "j": 0, "x": 0.0, "y": 0.0,
                "layer_tops": [1500.0], "layer_bases": [1515.0],
                "values": [0.2], "path_z": None,
            }],
        }

    httpd, url = viewer.build_server(payload, section_provider=provider)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        with urllib.request.urlopen(url + "/", timeout=5) as r:
            assert r.status == 200
        with urllib.request.urlopen(url + "/model.json", timeout=5) as r:
            assert json.loads(r.read())["kind"] == "demo"
        q = urllib.parse.urlencode({"line": json.dumps([[0, 0], [100, 100]])})
        with urllib.request.urlopen(url + "/section?" + q, timeout=5) as r:
            sec = json.loads(r.read())
            assert set(sec) <= SECTION_KEYS and sec["columns"]
        assert seen["line"] == [[0, 0], [100, 100]]
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_section_endpoint_501_without_provider(payload):
    httpd, url = viewer.build_server(payload)  # no provider
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        with pytest.raises(urllib.error.HTTPError) as exc:
            urllib.request.urlopen(url + "/section?well=x", timeout=5)
        assert exc.value.code == 501
    finally:
        httpd.shutdown()
        httpd.server_close()


# --- v3 encode: sidecar round-trip + the served /volume re-cut seam -----------
def test_v3_sidecar_manifest_and_bin():
    from petektools.viewer import _v3

    env, binb = _v3.build_v3_volume(8, 8, 4, encoding="sidecar")
    assert env["encoding"] == "sidecar" and binb is not None
    # offsets/lengths tile model.bin contiguously in block order, no gaps
    order = ["positions", "indices", "tri_cell", "cell_values", "zone_ids"]
    offset = 0
    for name in order:
        blk = env["blocks"][name]
        assert "data" not in blk and blk["offset"] == offset
        offset += blk["length"]
    assert offset == len(binb)


def test_volume_provider_recut_endpoint():
    from petektools.viewer import _v3

    base, _ = _v3.build_v3_volume(6, 6, 3)
    seen = {}

    def provider(property=None, cutoff=None, keep_above=None):
        seen.update(property=property, cutoff=cutoff, keep_above=keep_above)
        env, _bin = _v3.build_v3_volume(6, 6, 3)  # a re-cut shell (peteksim's job)
        return env

    httpd, url = viewer.build_server(base, volume_provider=provider)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        q = urllib.parse.urlencode({"property": "PORO", "cutoff": "0.15", "keep_above": "true"})
        with urllib.request.urlopen(url + "/volume?" + q, timeout=5) as r:
            env = json.loads(r.read())
            assert env["schema_version"] == 3 and env["kind"] == "volume"
        assert seen["property"] == "PORO" and seen["cutoff"] == 0.15 and seen["keep_above"] is True
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_volume_endpoint_501_without_provider(payload):
    httpd, url = viewer.build_server(payload)  # no volume provider
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        with pytest.raises(urllib.error.HTTPError) as exc:
            urllib.request.urlopen(url + "/volume?property=PORO&cutoff=0.1", timeout=5)
        assert exc.value.code == 501
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_sidecar_server_serves_model_bin():
    from petektools.viewer import _v3

    env, binb = _v3.build_v3_volume(6, 6, 3, encoding="sidecar")
    payload = {"schema_version": 3, "kind": "demo", "property": "PORO", "volume": env}
    httpd, url = viewer.build_server(payload, model_bin=binb)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        with urllib.request.urlopen(url + "/model.bin", timeout=5) as r:
            assert r.read() == binb
    finally:
        httpd.shutdown()
        httpd.server_close()


# --- serve() is non-blocking (returns immediately with a URL) -----------------
def test_serve_nonblocking(payload):
    done = {}

    def run():
        done["url"] = viewer.serve(payload, open_browser=False, port=0)

    t = threading.Thread(target=run)
    t.start()
    t.join(timeout=5)
    assert not t.is_alive(), "serve() blocked — should return immediately"
    assert done["url"].startswith("http://127.0.0.1")


# --- the standalone demo (second-consumer proof) ------------------------------
def test_demo_writes_self_contained_file(tmp_path):
    out = tmp_path / "demo.html"
    rc = demo.main(["--out", str(out)])
    assert rc == 0 and out.exists()
    assert "window.PETEK_VIEWER_PAYLOAD=" in out.read_text()


# --- the WellLogBundle seam (kind "wells_logs", v4) — the producer contract ----
# This is the round-trip fixture the upcoming peteksim/petekio producers must
# satisfy; precision matters (the seam doc is authoritative).
WELL_LOG_BUNDLE_KEYS = {"kind", "schema_version", "flatten_default", "wells"}
WELL_KEYS = {"id", "display_name", "x", "y", "datum_m", "md_m", "tvd_m", "curves", "tops", "zones", "ties"}
CURVE_MIN_KEYS = {"mnemonic", "display_name", "unit", "kind", "values"}
LANE_KEYS = {"dtype", "shape", "data"}


def _decode_lane(block: dict) -> tuple:
    """Decode an f32 lane block (base64, little-endian) — the same wire the viewer
    reads on its decode path. NaN entries survive as float('nan')."""
    import base64
    import struct

    raw = base64.b64decode(block["data"])
    n = len(raw) // 4
    return struct.unpack("<%df" % n, raw)


@pytest.fixture(scope="module")
def wells_bundle() -> dict:
    from petektools.viewer._wells import build_well_log_bundle

    return build_well_log_bundle()


def test_wells_bundle_schema(wells_bundle):
    b = wells_bundle
    assert set(b) == WELL_LOG_BUNDLE_KEYS, set(b)
    assert b["kind"] == "wells_logs" and b["schema_version"] == 4
    assert b["flatten_default"] and len(b["wells"]) >= 3
    for w in b["wells"]:
        assert WELL_KEYS <= set(w), set(w)
        assert set(w["md_m"]) == LANE_KEYS and set(w["tvd_m"]) == LANE_KEYS
        for c in w["curves"]:
            assert CURVE_MIN_KEYS <= set(c), set(c)
            assert c["kind"] in ("continuous", "flag")
            assert set(c["values"]) == LANE_KEYS


def test_wells_lanes_decode_consistently(wells_bundle):
    # Every well's lanes are equal-length and align (md/tvd/curves share n samples).
    for w in wells_bundle["wells"]:
        md = _decode_lane(w["md_m"])
        tvd = _decode_lane(w["tvd_m"])
        assert len(md) == len(tvd) > 0
        # md is monotonically increasing (sorted, top->down)
        assert all(md[i] <= md[i + 1] for i in range(len(md) - 1))
        for c in w["curves"]:
            vals = _decode_lane(c["values"])
            assert len(vals) == len(tvd), (w["id"], c["mnemonic"])


def test_wells_zone_character_believable(wells_bundle):
    # The sandy zone must read cleaner (higher mean PHIE) than the shaly zone —
    # the coupled generator's whole point.
    w = wells_bundle["wells"][0]
    tvd = _decode_lane(w["tvd_m"])
    phie = _decode_lane(next(c for c in w["curves"] if c["mnemonic"] == "PHIE")["values"])
    means = {}
    for z in w["zones"]:
        seg = [phie[i] for i, d in enumerate(tvd) if z["top_tvd_m"] <= d < z["base_tvd_m"]]
        means[z["name"]] = sum(seg) / len(seg)
    ordered = sorted(means, key=means.get)
    assert means[ordered[-1]] > means[ordered[0]] + 0.05  # a clear sand↔shale contrast


def test_wells_missing_pick_present(wells_bundle):
    # Exactly the fixture's design: one well is missing the default flatten pick, so
    # the viewer's flatten "parked well" path is exercised by the contract fixture.
    pick = wells_bundle["flatten_default"]
    missing = [w["id"] for w in wells_bundle["wells"] if pick not in {t["horizon"] for t in w["tops"]}]
    present = [w["id"] for w in wells_bundle["wells"] if pick in {t["horizon"] for t in w["tops"]}]
    assert len(missing) == 1 and len(present) >= 2, (missing, present)


def test_wells_tops_and_ties_shape(wells_bundle):
    for w in wells_bundle["wells"]:
        assert w["tops"] and all({"horizon", "tvd_m"} == set(t) for t in w["tops"])
        assert all({"name", "top_tvd_m", "base_tvd_m"} == set(z) for z in w["zones"])
        assert all({"horizon", "residual_m"} == set(t) for t in w["ties"])
        # tops are ordered top->down (increasing tvd)
        ds = [t["tvd_m"] for t in w["tops"]]
        assert ds == sorted(ds)


# --- the correlation demo payload (Wells tab + tie glyphs + v4 interior traces) -
def test_correlation_demo_payload_shape():
    p = demo.build_correlation_demo_payload()
    assert p["schema_version"] == 4
    assert p["wells_logs"]["kind"] == "wells_logs"
    # map well markers carry tie residuals (the tie-quality glyph reads these)
    assert p["wells"] and all(w.get("ties") for w in p["wells"])
    # the section carries v4 interior-horizon traces (parallel to columns, NaN-gapped)
    sec = p["sections"][0]
    assert sec["schema_version"] == 4 and sec["horizon_traces"]
    for ht in sec["horizon_traces"]:
        assert {"name", "depths"} == set(ht)
        assert len(ht["depths"]) == len(sec["columns"])
    # at least one trace is gapped somewhere (the "column doesn't reach" case).
    # The gap is a JSON null — what serde makes of the engine's f64::NAN; the
    # viewer must treat null as inactive, never as depth 0.
    assert any(
        any(d is None or d != d for d in ht["depths"]) for ht in sec["horizon_traces"]
    )


def test_correlation_demo_self_contained(tmp_path):
    out = tmp_path / "wells.html"
    rc = demo.main(["--wells", "--out", str(out)])
    assert rc == 0 and out.exists()
    html = out.read_text()
    assert "window.PETEK_VIEWER_PAYLOAD=" in html
    assert '"wells_logs"' in html and '"horizon_traces"' in html
    assert "<script src=" not in html  # fully inlined, zero external fetch


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
