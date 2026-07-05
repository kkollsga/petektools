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
    "zone_averages", "k_slices", "contacts", "wells",
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
