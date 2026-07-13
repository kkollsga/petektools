"""Content-addressed typed-binary blocks for the 2-D map's bulk arrays.

The 2-D map bundle (:mod:`_view2d`) historically ships its bulk arrays as JSON
floats: a single 78k-triangle fill is ~5-6 MB of JSON parsed on the browser's
main thread. This module encodes those arrays with the **same wire format the v3
``VolumeBundle`` uses** (:mod:`_v3`): tightly-packed little-endian ``f32``/``u32``/
``u8``
blocks, ``base64`` in ``data``, NaN = the canonical ``0x7FC00000``. The viewer's
decode kernel (``assets/decode.js``) reads both shapes.

Two additive marker forms replace a JSON array in place, so a decoder that does
not understand blocks still sees a plain object it can skip:

- ``{"__block__": "<digest>"}`` — a single block (fill ``nodes``/``triangles``/
  ``values``, ``points``, contact ``crossing`` masks). The digest indexes the
  payload's block table.
- ``{"__csr__": {"coords": "<digest>", "offsets": "<digest>"}}`` — a
  CSR-encoded *set* of variable-length polylines (``grid_lines`` and each
  ``contours[i].lines``): ``coords`` is an ``f32 [total_points, 2]`` block of all
  points concatenated, ``offsets`` a ``u32 [n_lines + 1]`` block where line ``k``
  is ``coords[offsets[k]:offsets[k+1]]``.

**Content-addressed dedup.** Every block carries a sha-256 digest of its raw
little-endian bytes; the payload emits a single ``map["blocks"]`` table keyed by
digest, so an identical array (e.g. two fills sharing one mesh, or a mesh whose
``nodes`` equal another's) ships exactly once. The client caches decoded blocks
by the same digest, so a digest seen across views in one session decodes once.

The whole thing is additive and opt-out: below a byte threshold the map stays
plain JSON (the round-trip a JSON-shaped payload renders through unchanged).
"""

from __future__ import annotations

import base64
import hashlib
from typing import Any, Callable, Dict, List, Sequence

from ._v3 import NAN_F32, _le_bytes

# Default: a map whose bulk arrays serialize to fewer than this many *value*
# bytes (f32/u32 counted at 4 B each) stays plain JSON — the block envelope's
# base64 + table overhead is not worth it for a small payload. ~64 KB of floats.
DEFAULT_THRESHOLD_BYTES = 65_536


def _digest(raw: bytes) -> str:
    """sha-256 hex of a block's raw little-endian bytes (the content address)."""
    return hashlib.sha256(raw).hexdigest()


class BlockTable:
    """A digest-keyed table of typed blocks with content-addressed dedup.

    :meth:`add` packs values to little-endian bytes, hashes them, and stores the
    ``{dtype, shape, data}`` descriptor once per distinct byte string; it returns
    the digest the payload references. Identical arrays collapse to one entry.
    """

    def __init__(self) -> None:
        self.table: Dict[str, Dict[str, Any]] = {}
        # Automatic surface attributes deliberately retain one Python geometry
        # object.  Remember markers by that source identity too, so packing and
        # hashing the shared nodes/triangles is also a once-per-payload cost.
        self._source: Dict[tuple[int, str, tuple[int, ...]], tuple[Any, str]] = {}

    def add(self, values: Sequence[float], dtype: str, shape: Sequence[int]) -> str:
        raw = _le_bytes(values, dtype)
        digest = _digest(raw)
        if digest not in self.table:
            self.table[digest] = {
                "dtype": dtype,
                "shape": [int(s) for s in shape],
                "data": base64.b64encode(raw).decode("ascii"),
            }
        return digest

    def block_marker(self, values: Sequence[float], dtype: str, shape: Sequence[int]) -> Dict[str, str]:
        return {"__block__": self.add(values, dtype, shape)}

    def source_marker(
        self,
        source: Sequence[Any],
        dtype: str,
        shape: Sequence[int],
        build_values: Callable[[], Sequence[float]],
    ) -> Dict[str, str]:
        """Marker for a normalized source array, packed once by identity."""
        key = (id(source), dtype, tuple(int(s) for s in shape))
        prior = self._source.get(key)
        if prior is not None and prior[0] is source:
            return {"__block__": prior[1]}
        digest = self.add(build_values(), dtype, shape)
        self._source[key] = (source, digest)
        return {"__block__": digest}

    def csr_marker(self, polylines: Sequence[Sequence[Sequence[float]]]) -> Dict[str, Any]:
        """A ``__csr__`` marker for a set of variable-length ``[x, y]`` polylines."""
        coords: List[float] = []
        offsets: List[int] = [0]
        for line in polylines:
            for pt in line:
                coords.append(float(pt[0]))
                coords.append(float(pt[1]))
            offsets.append(offsets[-1] + len(line))
        n_pts = offsets[-1]
        return {
            "__csr__": {
                "coords": self.add(coords, "f32", [n_pts, 2]),
                "offsets": self.add(offsets, "u32", [len(offsets)]),
            }
        }


def _nan_if_none(v: Any) -> float:
    """A fill/point value: ``None`` (JSON null / missing) becomes the canonical
    NaN so it round-trips through an ``f32`` block exactly as the JSON path's
    ``null`` (both render as a hole / non-finite)."""
    if v is None:
        return NAN_F32
    v = float(v)
    return v if v == v else NAN_F32  # a Python nan stays nan


def _map_bulk_bytes(m: Dict[str, Any]) -> int:
    """Estimate the map's bulk-array size in value bytes (4 B per f32/u32)."""
    total = 0
    total += len(m.get("points") or []) * 3
    for f in m.get("fills") or []:
        total += len(f.get("nodes") or []) * 2
        total += len(f.get("triangles") or []) * 3
        total += len(f.get("values") or [])
        lod = f.get("lod")
        if lod:
            total += len(lod.get("nodes") or []) * 2
            total += len(lod.get("triangles") or []) * 3
            total += len(lod.get("values") or [])
    for line in m.get("grid_lines") or []:
        total += len(line) * 2
    for line in m.get("grid_lines_lod") or []:
        total += len(line) * 2
    for c in m.get("contours") or []:
        for line in c.get("lines") or []:
            total += len(line) * 2
        for line in c.get("lines_lod") or []:
            total += len(line) * 2
    byte_total = total * 4
    for contact in m.get("contacts") or []:
        byte_total += len(contact.get("crossing") or [])
    return byte_total


def encode_map(m: Dict[str, Any], *, threshold_bytes: int = DEFAULT_THRESHOLD_BYTES) -> bool:
    """Encode the map's bulk arrays as typed blocks *in place*; return whether it
    did. A map below ``threshold_bytes`` of bulk data is left as plain JSON (the
    ``encoding="json"`` shape). Only non-empty bulk fields become markers; a
    ``map["blocks"]`` digest table is attached carrying every distinct block.

    The encoded fields: ``points`` (``f32 [n, 3]``, NaN z allowed), each
    ``fills[i]`` ``nodes`` (``f32 [n, 2]``) / ``triangles`` (``u32 [n, 3]``) /
    ``values`` (``f32 [n]``, null -> NaN), ``grid_lines`` (CSR), and each
    ``contours[i].lines`` (CSR), and contact ``crossing`` masks (``u8 [n]``).
    The additive stride-ladder LOD rings encode the
    same way — each ``fills[i].lod`` ``nodes``/``triangles``/``values``,
    ``grid_lines_lod`` (CSR), and each ``contours[i].lines_lod`` (CSR).
    """
    if _map_bulk_bytes(m) < threshold_bytes:
        return False

    tbl = BlockTable()

    points = m.get("points") or []
    if points:
        flat: List[float] = []
        for p in points:
            flat.append(float(p[0]))
            flat.append(float(p[1]))
            flat.append(_nan_if_none(p[2]) if len(p) > 2 else NAN_F32)
        m["points"] = tbl.block_marker(flat, "f32", [len(points), 3])

    for f in m.get("fills") or []:
        _encode_fill_arrays(tbl, f)
        # The coarse LOD ring (additive; ``view2d(lod=...)``) block-encodes its
        # own ``nodes``/``triangles``/``values`` — content-addressed, so a ring
        # identical to another block ships once.
        if f.get("lod"):
            _encode_fill_arrays(tbl, f["lod"])

    grid_lines = m.get("grid_lines") or []
    if grid_lines:
        m["grid_lines"] = tbl.csr_marker(grid_lines)
    grid_lines_lod = m.get("grid_lines_lod") or []
    if grid_lines_lod:
        m["grid_lines_lod"] = tbl.csr_marker(grid_lines_lod)

    for c in m.get("contours") or []:
        lines = c.get("lines") or []
        if lines:
            c["lines"] = tbl.csr_marker(lines)
        lines_lod = c.get("lines_lod") or []
        if lines_lod:
            c["lines_lod"] = tbl.csr_marker(lines_lod)

    # Large contact masks are byte-valued truth tables.  u8 keeps a 1M-cell
    # mask compact and worker-decodable while the forced-JSON path remains the
    # historical bool array.
    for contact in m.get("contacts") or []:
        crossing = contact.get("crossing") or []
        if crossing:
            contact["crossing"] = tbl.source_marker(
                crossing, "u8", [len(crossing)],
                lambda crossing=crossing: [1 if value else 0 for value in crossing],
            )

    m["blocks"] = tbl.table
    return True


def _encode_fill_arrays(tbl: "BlockTable", f: Dict[str, Any]) -> None:
    """Block-encode a fill's (or a fill LOD ring's) ``nodes``/``triangles``/
    ``values`` in place — the shared shape of a full and a coarse ring."""
    nodes = f.get("nodes") or []
    if nodes:
        def node_values() -> List[float]:
            nf: List[float] = []
            for nd in nodes:
                nf.append(float(nd[0]))
                nf.append(float(nd[1]))
            return nf
        f["nodes"] = tbl.source_marker(nodes, "f32", [len(nodes), 2], node_values)
    tris = f.get("triangles") or []
    if tris:
        def triangle_values() -> List[int]:
            tf: List[int] = []
            for t in tris:
                tf.extend((int(t[0]), int(t[1]), int(t[2])))
            return tf
        f["triangles"] = tbl.source_marker(
            tris, "u32", [len(tris), 3], triangle_values
        )
    vals = f.get("values")
    if vals:
        f["values"] = tbl.source_marker(
            vals, "f32", [len(vals)], lambda vals=vals: [_nan_if_none(v) for v in vals]
        )
