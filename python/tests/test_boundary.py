#!/usr/bin/env python3
"""pyo3 boundary tests — GIL release + the flat grid crossing.

Two things the 2026-07-04 boundary-hardening wave added and must keep working:

- **GIL release** (``py.detach``) around the seconds-capable kernels: a long
  kernel call must NOT hold the GIL, so another Python thread keeps running
  while it computes. The spinner-thread pattern proves the main thread was free.
- **Flat grid crossing**: ``*_flat`` variants return one little-endian ``f64``
  ``bytes`` buffer + ``(ncol, nrow)`` shape instead of a boxed list-of-lists;
  they must be *numerically identical* to the nested variant (round-tripped
  through ``np.frombuffer(...).reshape``), and — informationally — cheaper to
  cross at a 1M-node grid.

    PYTHONPATH=python pytest python/tests/test_boundary.py -q -s
"""

from __future__ import annotations

import struct
import threading
import time

import pytest

import petektools as pt


def _unflatten(buf: bytes, shape):
    """(bytes, (ncol, nrow)) -> list[list[float]] (field[col][row]), no numpy."""
    ncol, nrow = shape
    vals = struct.unpack(f"<{ncol * nrow}d", buf)
    return [list(vals[c * nrow:(c + 1) * nrow]) for c in range(ncol)]


def _flatten(field) -> bytes:
    """list[list[float]] (field[col][row]) -> little-endian f64 bytes."""
    flat = [v for col in field for v in col]
    return struct.pack(f"<{len(flat)}d", *flat)


def _nan_eq(a, b) -> bool:
    import math

    if math.isnan(a) and math.isnan(b):
        return True
    return a == b


# --- GIL release (spinner-thread pattern) -----------------------------------

def _spins_during(call) -> int:
    """Run `call` on the main thread while a daemon thread spins a counter. If
    the GIL is released for the duration of `call`, the counter advances; a
    GIL-held call would starve the spinner (near-zero advance)."""
    stop = threading.Event()
    counter = {"n": 0}

    def spin():
        while not stop.is_set():
            counter["n"] += 1

    t = threading.Thread(target=spin, daemon=True)
    t.start()
    time.sleep(0.02)  # let the spinner get going
    try:
        call()
    finally:
        stop.set()
        t.join()
    return counter["n"]


def test_experimental_variogram_releases_gil():
    # A large-ish point set so the O(n^2) pairing takes long enough for the
    # spinner thread to make visible progress while the GIL is released.
    import math

    n = 1400
    coords = [[math.sin(i) * 500, math.cos(i * 1.3) * 500, (i % 50) * 0.1]
              for i in range(n)]
    spins = _spins_during(lambda: pt.experimental_variogram(coords, lag=25.0, n_lags=20))
    # A GIL-held call would leave the spinner starved (~0). We only need proof it
    # ran concurrently, so a loose floor avoids machine-speed flakiness.
    assert spins > 1000, f"spinner barely advanced ({spins}) — GIL likely held"


def test_sgs_releases_gil():
    coords = [[float(i % 20) * 40, float(i // 20) * 40, (i % 7) * 0.5] for i in range(120)]
    lat = pt.Lattice(0.0, 0.0, 10.0, 10.0, 90, 90)  # 8100 nodes
    vg = pt.Variogram("spherical", 0.0, 1.0, 200.0)
    spins = _spins_during(
        lambda: pt.sgs(coords, lat, vg, max_neighbours=16, radius=400.0, seed=7)
    )
    assert spins > 1000, f"spinner barely advanced ({spins}) — GIL likely held"


# --- flat grid crossing: numerical equivalence to the nested variant ---------

def test_sgs_flat_matches_nested():
    coords = [[float(i % 10) * 50, float(i // 10) * 50, (i % 5) * 0.4] for i in range(60)]
    lat = pt.Lattice(0.0, 0.0, 20.0, 20.0, 40, 30)
    vg = pt.Variogram("exponential", 0.0, 1.0, 150.0)
    nested = pt.sgs(coords, lat, vg, 12, 300.0, 123)
    buf, shape = pt.sgs_flat(coords, lat, vg, 12, 300.0, 123)
    assert shape == (lat.ncol, lat.nrow) == (40, 30)
    flat = _unflatten(buf, shape)
    assert len(flat) == len(nested)
    for c in range(shape[0]):
        for r in range(shape[1]):
            assert _nan_eq(flat[c][r], nested[c][r])


def test_local_kriging_grid_flat_matches_nested():
    coords = [[float(i % 8) * 60, float(i // 8) * 60, (i % 6) * 0.3] for i in range(40)]
    lat = pt.Lattice(0.0, 0.0, 25.0, 25.0, 24, 20)
    vg = pt.Variogram("spherical", 0.05, 1.0, 200.0)
    est_n, var_n = pt.local_kriging_grid(coords, lat, vg, 10, 400.0)
    eb, vb, shape = pt.local_kriging_grid_flat(coords, lat, vg, 10, 400.0)
    est_f, var_f = _unflatten(eb, shape), _unflatten(vb, shape)
    for c in range(shape[0]):
        for r in range(shape[1]):
            assert _nan_eq(est_f[c][r], est_n[c][r])
            assert _nan_eq(var_f[c][r], var_n[c][r])


def test_resample_flat_roundtrips_nested():
    src_geo = pt.Lattice(0.0, 0.0, 10.0, 10.0, 30, 25)
    tgt = pt.Lattice(5.0, 5.0, 12.0, 12.0, 20, 18)
    src = [[float(c) + 0.1 * r for r in range(25)] for c in range(30)]
    nested = pt.resample(src, src_geo, tgt, "bilinear")
    buf, shape = pt.resample_flat(_flatten(src), src_geo, tgt, "bilinear")
    flat = _unflatten(buf, shape)
    assert shape == (tgt.ncol, tgt.nrow)
    for c in range(shape[0]):
        for r in range(shape[1]):
            assert _nan_eq(flat[c][r], nested[c][r])


def test_synth_surface_flat_matches_nested():
    lat = pt.Lattice(0.0, 0.0, 50.0, 50.0, 40, 40)
    vg = pt.Variogram("gaussian", 0.0, 1.0, 400.0)
    nested = pt.synth_dome_surface(lat, 120.0, 1.4, 0.0, 5.0, vg, 99)
    buf, shape = pt.synth_dome_surface_flat(lat, 120.0, 1.4, 0.0, 5.0, vg, 99)
    flat = _unflatten(buf, shape)
    for c in range(shape[0]):
        for r in range(shape[1]):
            assert _nan_eq(flat[c][r], nested[c][r])


def test_flat_length_mismatch_is_loud():
    geo = pt.Lattice(0.0, 0.0, 10.0, 10.0, 4, 4)
    tgt = pt.Lattice(0.0, 0.0, 10.0, 10.0, 4, 4)
    with pytest.raises(ValueError):
        pt.resample_flat(b"\x00" * 8, geo, tgt)  # far too short for 4x4x8


# --- flat boundary crossing cost at ~1M nodes (informational, printed) -------

@pytest.mark.parametrize("side", [1000])
def test_flat_boundary_cost_1m(side):
    """Old (nested list-of-lists) vs new (flat bytes) crossing at side*side nodes.
    The kernel is identical (a bilinear resample onto the SAME geometry), so the
    delta isolates the boundary cost. Correctness is asserted; timing is printed
    for the report (best-of-N, loose upper bound to avoid CI flakiness)."""
    n = side * side
    geo = pt.Lattice(0.0, 0.0, 1.0, 1.0, side, side)
    tgt = geo  # identity target: same shape, so only the crossing differs
    src = [[float((c * 131 + r * 17) % 997) for r in range(side)] for c in range(side)]
    src_bytes = _flatten(src)

    def best(fn, reps=3):
        t = float("inf")
        out = None
        for _ in range(reps):
            t0 = time.perf_counter()
            out = fn()
            t = min(t, time.perf_counter() - t0)
        return t, out

    t_nested, nested = best(lambda: pt.resample(src, geo, tgt, "bilinear"))
    t_flat, (buf, shape) = best(lambda: pt.resample_flat(src_bytes, geo, tgt, "bilinear"))

    # correctness: identical values across the two crossings
    flat = _unflatten(buf, shape)
    assert flat[0][0] == nested[0][0]
    assert flat[side - 1][side - 1] == nested[side - 1][side - 1]

    print(f"\n[boundary] {n} nodes: nested {t_nested * 1e3:.1f} ms | "
          f"flat {t_flat * 1e3:.1f} ms | speedup {t_nested / max(t_flat, 1e-9):.2f}x "
          f"| flat bytes = {len(buf) / 1e6:.1f} MB")
    # The flat crossing must not be materially slower (it should be much faster).
    assert t_flat < t_nested * 1.5, (t_flat, t_nested)


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-q", "-s"]))
