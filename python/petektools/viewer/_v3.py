"""v3 VolumeBundle wire encoding + a synthetic exterior-shell generator.

The viewer *decodes* the v3 binary-block ``VolumeBundle`` (petekStatic ``API.md``
"Binary-block payload spec"); petekStatic's Rust engine is the authoritative
*writer*. This module gives the viewer's own Python side two things the engine
would otherwise be needed for:

- :func:`encode_volume_bundle` — pack shell arrays into the exact v3 envelope
  (little-endian, tightly-packed ``f32``/``u32``/``u16`` blocks; NaN = the
  canonical ``0x7FC00000``) in ``base64`` (self-contained) *or* ``sidecar``
  (offset/length manifest + a companion ``model.bin``) form. It is the demo's
  v3 upgrade and the test/bench payload builder.
- :func:`synth_box_shell` — the exterior shell of a synthetic ``ni×nj×nk`` box
  (deduped verts, boundary faces only, ``tri_cell`` per triangle). Pure
  synthetic data; used to build 100k / 1M / 5M-cell shells for the perf harness.

Nothing here reproduces engine code — it emits the *documented wire format* the
viewer must read, so a round-trip decode/render is provable without the Rust build.
"""

from __future__ import annotations

import base64
import math
import struct
import sys
from array import array
from typing import Any, Dict, List, Optional, Sequence, Tuple

# canonical quiet-NaN f32 bit pattern (matches the engine's 0x7FC00000).
NAN_F32 = struct.unpack("<f", struct.pack("<I", 0x7FC00000))[0]

_DTYPE_CODE = {"f32": "f", "u32": "I", "u16": "H", "u8": "B"}
_DTYPE_SIZE = {"f32": 4, "u32": 4, "u16": 2, "u8": 1}


def _le_bytes(values: Sequence[float], dtype: str) -> bytes:
    """Pack ``values`` as tightly-packed little-endian bytes of ``dtype``."""
    code = _DTYPE_CODE[dtype]
    a = array(code, values)
    if a.itemsize != _DTYPE_SIZE[dtype]:  # platform sanity (all targets match)
        raise RuntimeError(f"array('{code}').itemsize={a.itemsize} != {_DTYPE_SIZE[dtype]}")
    if sys.byteorder == "big":
        a = array(code, a)
        a.byteswap()
    return a.tobytes()


def encode_volume_bundle(
    *,
    property: str,
    cell_count: int,
    positions: Sequence[float],
    indices: Sequence[int],
    tri_cell: Sequence[int],
    cell_values: Sequence[float],
    zone_ids: Sequence[int],
    zone_names: Sequence[str],
    value_range: Dict[str, float],
    inputs_ref: str = "",
    encoding: str = "base64",
) -> Tuple[Dict[str, Any], Optional[bytes]]:
    """Encode a v3 ``VolumeBundle`` envelope. Returns ``(envelope, bin_bytes)``.

    ``bin_bytes`` is ``None`` for ``encoding="base64"`` (blocks inline as
    ``data``); for ``encoding="sidecar"`` it is the concatenated ``model.bin``
    the envelope's ``offset``/``length`` manifest indexes into (block order:
    positions, indices, tri_cell, cell_values, zone_ids).
    """
    n_vert = len(positions) // 3
    n_tri = len(indices) // 3
    n_shell = len(cell_values)
    if len(zone_ids) != n_shell:
        raise ValueError("zone_ids length must equal cell_values length (shell cells)")
    if len(tri_cell) != n_tri:
        raise ValueError("tri_cell length must equal triangle count")

    specs = [
        ("positions", "f32", [n_vert, 3], positions),
        ("indices", "u32", [n_tri, 3], indices),
        ("tri_cell", "u32", [n_tri], tri_cell),
        ("cell_values", "f32", [n_shell], cell_values),
        ("zone_ids", "u16", [n_shell], zone_ids),
    ]

    blocks: Dict[str, Any] = {}
    bin_parts: List[bytes] = []
    offset = 0
    for name, dtype, shape, values in specs:
        raw = _le_bytes(values, dtype)
        block: Dict[str, Any] = {"dtype": dtype, "shape": shape}
        if encoding == "sidecar":
            block["offset"] = offset
            block["length"] = len(raw)
            bin_parts.append(raw)
            offset += len(raw)
        else:
            block["data"] = base64.b64encode(raw).decode("ascii")
        blocks[name] = block

    envelope = {
        "schema_version": 3,
        "kind": "volume",
        "inputs_ref": inputs_ref,
        "property": property,
        "cell_count": cell_count,
        "shell_cell_count": n_shell,
        "vertex_count": n_vert,
        "triangle_count": n_tri,
        "zone_names": list(zone_names),
        "value_range": {"min": value_range["min"], "max": value_range["max"]},
        "encoding": encoding,
        "blocks": blocks,
    }
    bin_bytes = b"".join(bin_parts) if encoding == "sidecar" else None
    return envelope, bin_bytes


# 12 triangles (6 quad faces × 2) into a cell's local 0..7 corners — the corner
# order matches _box_corners below (top face z=ztop, then bottom z=zbot).
_FACES = {
    "top": [0, 1, 2, 0, 2, 3],
    "bottom": [4, 6, 5, 4, 7, 6],
    "y0": [0, 4, 5, 0, 5, 1],
    "y1": [3, 2, 6, 3, 6, 7],
    "x0": [0, 3, 7, 0, 7, 4],
    "x1": [1, 5, 6, 1, 6, 2],
}


def _box_corners(x0, x1, y0, y1, zt, zb):
    return [
        (x0, y0, zt), (x1, y0, zt), (x1, y1, zt), (x0, y1, zt),
        (x0, y0, zb), (x1, y0, zb), (x1, y1, zb), (x0, y1, zb),
    ]


def synth_box_shell(
    ni: int, nj: int, nk: int,
    *,
    spacing: float = 100.0,
    dz: float = 15.0,
    top: float = 1500.0,
    n_zones: int = 3,
) -> Dict[str, Any]:
    """Exterior shell of a synthetic ``ni×nj×nk`` box (cell-major i,j,k).

    Only faces bordering the grid boundary are emitted (a real shell — interior
    cells contribute nothing), verts are deduplicated by position, and every
    triangle carries a compact ``tri_cell`` index into the per-shell-cell
    ``cell_values`` / ``zone_ids``. Returns the kwargs for
    :func:`encode_volume_bundle` (plus ``cell_count``). Pure synthetic data.
    """
    vert_index: Dict[Tuple[float, float, float], int] = {}
    positions: List[float] = []
    indices: List[int] = []
    tri_cell: List[int] = []
    cell_values: List[float] = []
    zone_ids: List[int] = []

    def vid(p):
        key = (round(p[0], 4), round(p[1], 4), round(p[2], 4))
        i = vert_index.get(key)
        if i is None:
            i = len(positions) // 3
            vert_index[key] = i
            positions.extend(p)
        return i

    def poro(i, j, k):
        return 0.12 + 0.10 * (math.sin(i / 5.0) * math.cos(j / 5.0) + 1) / 2 * (1 - 0.15 * k / max(1, nk))

    shell = 0
    for k in range(nk):
        for j in range(nj):
            for i in range(ni):
                on_shell = i == 0 or i == ni - 1 or j == 0 or j == nj - 1 or k == 0 or k == nk - 1
                if not on_shell:
                    continue
                x0, x1 = i * spacing, (i + 1) * spacing
                y0, y1 = j * spacing, (j + 1) * spacing
                zt = top + k * dz + 20.0 * math.sin(i / 8.0)
                zb = zt + dz
                corners = _box_corners(x0, x1, y0, y1, zt, zb)
                faces = []
                if k == 0:
                    faces.append("top")
                if k == nk - 1:
                    faces.append("bottom")
                if j == 0:
                    faces.append("y0")
                if j == nj - 1:
                    faces.append("y1")
                if i == 0:
                    faces.append("x0")
                if i == ni - 1:
                    faces.append("x1")
                if not faces:
                    continue
                for face in faces:
                    tris = _FACES[face]
                    for t in range(0, len(tris), 3):
                        indices.append(vid(corners[tris[t]]))
                        indices.append(vid(corners[tris[t + 1]]))
                        indices.append(vid(corners[tris[t + 2]]))
                        tri_cell.append(shell)
                cell_values.append(poro(i, j, k))
                zone_ids.append(min(n_zones - 1, k * n_zones // max(1, nk)))
                shell += 1

    vmin = min(cell_values) if cell_values else 0.0
    vmax = max(cell_values) if cell_values else 1.0
    return {
        "property": "PORO",
        "cell_count": ni * nj * nk,
        "positions": positions,
        "indices": indices,
        "tri_cell": tri_cell,
        "cell_values": cell_values,
        "zone_ids": zone_ids,
        "zone_names": [f"Zone {z + 1}" for z in range(n_zones)],
        "value_range": {"min": vmin, "max": vmax},
    }


def build_v3_volume(ni: int, nj: int, nk: int, *, encoding: str = "base64", **kw):
    """Convenience: synth a box shell and encode it. Returns ``(envelope, bin)``."""
    shell = synth_box_shell(ni, nj, nk, **kw)
    return encode_volume_bundle(encoding=encoding, **shell)
