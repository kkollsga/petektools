"""WellLogBundle (kind ``wells_logs``, SCHEMA_VERSION 4) — the correlation-view wire.

The viewer's **Wells** tab renders a ``WellLogBundle``: N wells side-by-side, a
shared inverted depth axis, per-well track sets (a flag strip, PHIE with a cutoff
fill, a derived NTG curve, SW), tops as cross-track lines, and two hanging modes
(TVD / flatten-on-pick). The producers of this bundle are peteksim (model context)
and petekio (standalone ``well.view()``); neither exists yet, so this module is the
**reference fixture** — the round-trip contract test the producers must satisfy.

Two pieces, mirroring :mod:`._v3`:

- :func:`encode_lane` — one f32 lane as a v3-style binary block (little-endian,
  base64, ``NaN`` = the canonical ``0x7FC00000``). Reuses ``_v3._le_bytes`` — the
  *same* lane machinery the volume blocks use, so the log lanes decode on the
  viewer's existing decode path (they are tiny; no special casing).
- :func:`build_well_log_bundle` — hand-authored, deterministic, believable
  multi-well logs: sandy / shaly / mixed zones with coupled PHIE·NTG·SW·facies
  shapes, tops + a flatten pick, and one well deliberately missing a pick.

Nothing here reproduces engine code — it emits the *documented seam format*
(``dev-docs/designs/well-log-bundle-seam.md``) so a producer round-trip is
provable without the Rust build.
"""

from __future__ import annotations

import base64
import random
from typing import Any, Dict, List, Sequence

from ._v3 import NAN_F32, _le_bytes


def encode_lane(values: Sequence[float]) -> Dict[str, Any]:
    """Encode one f32 lane as a v3-style base64 binary block ``{dtype, shape, data}``.

    ``None``/non-finite entries pack as the canonical quiet-NaN ``0x7FC00000`` (the
    viewer reads ``NaN`` as null). This is the exact block shape the volume decode
    kernel already consumes, so a log lane rides the same path.
    """
    clean = [NAN_F32 if (v is None) else float(v) for v in values]
    raw = _le_bytes(clean, "f32")
    return {"dtype": "f32", "shape": [len(clean)], "data": base64.b64encode(raw).decode("ascii")}


# Per-zone character. `cutoff` is the PHIE net cutoff (net_flag = phie >= cutoff),
# mirroring the coupled synth petro generator (NTG derived from porosity by a
# cutoff); SW is anti-correlated with PHIE within a zone. Believable, self-
# consistent shapes — a sandy zone reads clean/wet-low, a shaly zone tight/wet-high.
_ZONE_PRESETS: Dict[str, Dict[str, float]] = {
    "sand": dict(phie_mean=0.235, phie_sd=0.028, cutoff=0.12, sw_mean=0.30, sw_sd=0.05, sw_slope=1.4),
    "shale": dict(phie_mean=0.075, phie_sd=0.020, cutoff=0.12, sw_mean=0.82, sw_sd=0.06, sw_slope=0.6),
    "mixed": dict(phie_mean=0.165, phie_sd=0.045, cutoff=0.12, sw_mean=0.48, sw_sd=0.08, sw_slope=1.1),
}


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def _zone_curves(kind: str, n: int, rng: random.Random) -> Dict[str, List[float]]:
    """Deterministic, believable PHIE / NET / SW samples for one zone (``n`` steps).

    PHIE is an AR(1) bed process around the zone mean; the net flag is ``phie >=
    cutoff`` (coupled, per the synth generator); SW is the zone's wetness minus a
    slope·(phie − mean) term (higher porosity → lower water), plus a little noise.
    """
    p = _ZONE_PRESETS[kind]
    phie: List[float] = []
    net: List[float] = []
    sw: List[float] = []
    x = p["phie_mean"]
    for _ in range(n):
        # AR(1) with bedding: pull toward the mean, add a correlated shock.
        x = 0.72 * x + 0.28 * p["phie_mean"] + rng.gauss(0.0, p["phie_sd"])
        phi = _clamp(x, 0.0, 0.4)
        phie.append(round(phi, 4))
        net.append(1.0 if phi >= p["cutoff"] else 0.0)
        w = p["sw_mean"] - p["sw_slope"] * (phi - p["phie_mean"]) + rng.gauss(0.0, p["sw_sd"])
        sw.append(round(_clamp(w, 0.02, 1.0), 4))
    return {"phie": phie, "net": net, "sw": sw}


def _ntg_curve(net: Sequence[float], window: int) -> List[float]:
    """Derived NTG: a centred moving average of the net flag over ``window`` samples."""
    n = len(net)
    half = max(1, window // 2)
    out: List[float] = []
    for i in range(n):
        lo, hi = max(0, i - half), min(n, i + half + 1)
        seg = net[lo:hi]
        out.append(round(sum(seg) / len(seg), 4))
    return out


# One well's plan: its label, world (x, y), KB/RT datum (family z is negative-down,
# so a rig-floor elevation is a small POSITIVE number here), and the stacked zones
# it penetrates (kind + thickness in m). `missing_pick` names a horizon whose top
# is deliberately dropped from this well's tops[] (an unpicked / faulted-out marker)
# so the flatten-on-pick path is exercised against a well with no pick.
_WELLS_PLAN = [
    dict(id="99/3-1", x=458_200.0, y=6_782_400.0, datum=28.0,
         zones=[("sand", 34.0), ("shale", 22.0), ("mixed", 40.0)], missing_pick=None),
    dict(id="99/3-2", x=459_050.0, y=6_782_050.0, datum=31.0,
         zones=[("sand", 30.0), ("shale", 26.0), ("mixed", 44.0)], missing_pick=None),
    dict(id="99/3-A", x=458_650.0, y=6_781_700.0, datum=26.0,
         zones=[("sand", 38.0), ("shale", 18.0), ("mixed", 36.0)], missing_pick=None),
    dict(id="99/6-1", x=460_100.0, y=6_780_900.0, datum=33.0,
         zones=[("sand", 26.0), ("shale", 30.0), ("mixed", 48.0)], missing_pick="TopShale"),
]

# Zone → (name, the framework horizon that tops it). Top→down.
_ZONE_HORIZON = [("Upper Sand", "TopSand"), ("Mid Shale", "TopShale"), ("Lower Mixed", "TopMixed")]
_BASE_HORIZON = "BaseReservoir"


def build_well_log_bundle(
    *,
    step_m: float = 0.5,
    seed: int = 7,
    flatten_default: str = "TopShale",
    template: Any = None,
) -> Dict[str, Any]:
    """A believable multi-well ``WellLogBundle`` fixture (kind ``wells_logs``, v4).

    Four fictional wells (``99/…`` naming, fictional coords), three zones each with
    distinct character (a sandy, a shaly, a mixed zone), coupled PHIE·NTG·SW·facies
    curves (f32 lanes), tops + zones, per-well tie residuals, and a declared default
    flatten pick. One well (``99/6-1``) is missing the ``TopShale`` pick so the
    viewer's flatten-on-pick "no pick" handling is covered by the fixture.

    Every curve array is a base64 f32 lane (:func:`encode_lane`); the header carries
    the mnemonics, display names, units, per-curve ranges and (for PHIE) the net
    ``cutoff`` so the view draws the cutoff line + fill without recomputing anything.
    """
    rng = random.Random(seed)
    wells: List[Dict[str, Any]] = []

    for wi, wp in enumerate(_WELLS_PLAN):
        datum = float(wp["datum"])
        # Reservoir starts a little below rig floor; TVD (SS, positive-down) begins
        # here. A mild, DETERMINISTIC per-well structural offset (index-derived, not
        # a randomized str hash) makes flattening visibly move wells run-to-run.
        top_tvd = 1820.0 + wi * 11.0
        md_m: List[float] = []
        tvd_m: List[float] = []
        phie: List[float] = []
        net: List[float] = []
        sw: List[float] = []
        facies: List[float] = []
        tops: List[Dict[str, Any]] = []
        zones: List[Dict[str, Any]] = []

        z = top_tvd
        for (kind, thick), (zone_name, horizon) in zip(wp["zones"], _ZONE_HORIZON):
            n = max(2, int(round(thick / step_m)))
            zc = _zone_curves(kind, n, rng)
            z_top = z
            for s in range(n):
                zz = z + s * step_m
                tvd_m.append(round(zz, 3))
                md_m.append(round(zz + datum, 3))  # vertical well: MD = TVD-SS + datum
                phie.append(zc["phie"][s])
                net.append(zc["net"][s])
                sw.append(zc["sw"][s])
                facies.append(zc["net"][s])  # facies strip: 0 = shale/non-net, 1 = net sand
            z_base = z + n * step_m
            # A top is dropped for the well that "loses" this pick (unpicked marker).
            if wp["missing_pick"] != horizon:
                tops.append({"horizon": horizon, "tvd_m": round(z_top, 2)})
            zones.append({"name": zone_name, "top_tvd_m": round(z_top, 2), "base_tvd_m": round(z_base, 2)})
            z = z_base
        tops.append({"horizon": _BASE_HORIZON, "tvd_m": round(z, 2)})

        ntg = _ntg_curve(net, window=max(3, int(round(5.0 / step_m))))

        curves = [
            {"mnemonic": "FACIES", "display_name": "Facies (net)", "unit": "",
             "kind": "flag", "codes": {"0": "shale", "1": "net sand"},
             "values": encode_lane(facies)},
            {"mnemonic": "PHIE", "display_name": "Effective porosity", "unit": "v/v",
             "kind": "continuous", "range": {"min": 0.0, "max": 0.35},
             "cutoff": _ZONE_PRESETS["sand"]["cutoff"],
             "values": encode_lane(phie)},
            {"mnemonic": "NTG", "display_name": "Net-to-gross", "unit": "v/v",
             "kind": "continuous", "range": {"min": 0.0, "max": 1.0},
             "values": encode_lane(ntg)},
            {"mnemonic": "SW", "display_name": "Water saturation", "unit": "v/v",
             "kind": "continuous", "range": {"min": 0.0, "max": 1.0},
             "values": encode_lane(sw)},
        ]
        # Tie residuals: pick − surface (m), a small believable spread per well.
        ties = [
            {"horizon": "TopSand", "residual_m": round(rng.uniform(-6.0, 6.0), 2)},
            {"horizon": "TopMixed", "residual_m": round(rng.uniform(-4.0, 4.0), 2)},
        ]

        wells.append({
            "id": wp["id"],
            "display_name": wp["id"],
            "x": wp["x"], "y": wp["y"],
            "datum_m": datum,
            "md_m": encode_lane(md_m),
            "tvd_m": encode_lane(tvd_m),
            "curves": curves,
            "tops": tops,
            "zones": zones,
            "ties": ties,
        })

    bundle = {
        "kind": "wells_logs",
        "schema_version": 4,
        "flatten_default": flatten_default,
        "wells": wells,
    }
    if template is None:
        return bundle
    from ._correlation import CorrelationTemplate

    spec = (
        template
        if isinstance(template, CorrelationTemplate)
        else CorrelationTemplate.from_dict(template)
    )
    return spec.apply(bundle)
