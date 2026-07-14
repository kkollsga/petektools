"""petektools wheel smoke + parity tests.

Runs as a pytest suite *and* as a plain script (``python test_petektools.py``).
Proves: seeded reproducibility (incl. the cross-language parity vectors that the
Rust ``tests/parity.rs`` pins bit-for-bit), the type-7 percentile, the P90=low
``reservoir_summary`` convention, truncated-normal bounds, aggregate, and a tiny
end-to-end geostat (experimental variogram -> fit -> local kriging -> SGS).
"""

import math

import petektools as pt

# The seed + params shared with the Rust engine (tests/parity.rs). Golden values
# are the exact draw stream — a mismatch means the Rust RNG path or the PyO3
# marshalling drifted.
SEED = 20260703
PARITY = {
    "uniform": (
        pt.Sampler.uniform(0.0, 1.0),
        5,
        [0.33443602974759323, 0.009958944617155074, 0.5658402900563928,
         0.4914127600800473, 0.15156206470701195],
    ),
    "normal": (
        pt.Sampler.normal(0.0, 1.0),
        5,
        [-0.2141390202029558, -0.8558773516768997, 0.3154728438139085,
         -0.02578857523830222, -1.0136631546527357],
    ),
    "triangular": (
        pt.Sampler.triangular(0.0, 1.0, 2.0),
        3,
        [0.8178459876377621, 0.14113075226296412, 1.0681634156746074],
    ),
    "lognormal": (
        pt.Sampler.lognormal(0.0, 0.25),
        3,
        [0.9478729970572154, 0.8073731403836002, 1.0820617087922064],
    ),
    "truncated_normal": (
        pt.Sampler.truncated_normal(0.0, 1.0, -1.0, 1.0),
        3,
        [-0.2872218793831341, -0.9722860907259094, 0.11290855771814236],
    ),
}


def test_cross_language_parity_vectors():
    """Every sampler reproduces the exact stream pinned by the Rust engine."""
    for name, (sampler, n, want) in PARITY.items():
        got = sampler.sample_n_seeded(n, SEED)
        assert got == want, f"{name} parity drift: {got} != {want}"


def test_seeded_reproducibility():
    """Same seed -> identical stream (object path *and* seed-arg path agree)."""
    s = pt.Sampler.normal(10.0, 2.0)
    a = s.sample_n(100, pt.Rng(42))
    b = s.sample_n(100, pt.Rng(42))
    assert a == b
    assert s.sample_n_seeded(100, 42) == a  # convenience == fresh-Rng path
    assert s.sample_n(100, pt.Rng(43)) != a  # a different seed differs


def test_percentile_type7():
    assert pt.percentile([1, 2, 3, 4, 5], 25) == 2.0
    assert pt.median([1, 2, 3, 4, 5]) == 3.0
    assert pt.mean([1, 2, 3, 4]) == 2.5


def test_weighted_family():
    # Equal weights reduce to the unweighted mean.
    assert pt.weighted_mean([1.0, 3.0], [1.0, 1.0]) == 2.0
    assert pt.weighted_mean([1.0, 3.0], [3.0, 1.0]) == 1.5


def test_reservoir_summary_convention():
    """P90=low: p90 <= p50 <= p10 (industry exceedance convention)."""
    data = [float(v) for v in range(1, 12)]  # 1..=11
    s = pt.reservoir_summary(data)
    assert s.p90 == 2.0 and s.p50 == 6.0 and s.p10 == 10.0 and s.mean == 6.0
    assert s.p90 <= s.p50 <= s.p10
    assert s.to_dict() == {"p90": 2.0, "p50": 6.0, "p10": 10.0, "mean": 6.0}


def test_truncated_normal_bounds():
    s = pt.Sampler.truncated_normal(0.0, 1.0, -0.5, 0.5)
    draws = s.sample_n(5000, pt.Rng(11))
    assert all(-0.5 <= v <= 0.5 for v in draws), "truncated draw escaped bounds"


def test_clamped_piles_mass_at_bounds():
    clamped = pt.Sampler.normal(0.0, 1.0).clamped(-0.25, 0.25)
    draws = clamped.sample_n(2000, pt.Rng(5))
    at_bound = sum(1 for v in draws if abs(abs(v) - 0.25) < 1e-12)
    assert at_bound > 100, "clamping should pile tail mass at the bounds"


def test_aggregate():
    a = [1.0, 2.0, 3.0]
    b = [10.0, 20.0, 30.0]
    assert pt.aggregate([a, b], "independent") == [11.0, 22.0, 33.0]
    # comonotonic sorts each segment ascending, then sums rank-for-rank.
    assert pt.aggregate([[3.0, 1.0, 2.0], [30.0, 10.0, 20.0]], "comonotonic") == [11.0, 22.0, 33.0]


def test_geostat_end_to_end():
    """experimental variogram -> fit -> local kriging -> SGS on a tiny set."""
    # A small spatially-structured set: value tracks x.
    coords = [[float(x), float(y), float(x)] for x in range(6) for y in range(6)]
    exp = pt.experimental_variogram(coords, lag=1.0, n_lags=6)
    assert len(exp.lags) == len(exp.semivariances) == len(exp.counts) >= 1
    vg = pt.Variogram.fit("spherical", exp)
    assert vg.nugget >= 0.0 and vg.range > 0.0

    lat = pt.Lattice(0.0, 0.0, 1.0, 1.0, 5, 5)
    est, var = pt.local_kriging_grid(coords, lat, vg, max_neighbours=8, radius=3.0)
    assert len(est) == 5 and len(est[0]) == 5
    # An interior node should recover roughly its x-coordinate (value == x).
    assert abs(est[2][2] - 2.0) < 0.75, est[2][2]
    assert all(v >= 0.0 or math.isnan(v) for row in var for v in row)

    # SGS is seeded/reproducible and conditioned; a normal-score-scale variogram.
    vg_ns = pt.Variogram("spherical", 0.0, 1.0, 3.0)
    f1 = pt.sgs(coords, lat, vg_ns, max_neighbours=8, radius=5.0, seed=7)
    f2 = pt.sgs(coords, lat, vg_ns, max_neighbours=8, radius=5.0, seed=7)
    assert f1 == f2, "SGS must be bit-reproducible for a fixed seed"
    assert len(f1) == 5 and len(f1[0]) == 5


def test_anisotropic_variogram_validation_and_directional_distance():
    vg = pt.AnisotropicVariogram(
        "spherical", major=1500.0, minor=700.0, vertical=20.0, azimuth=395.0, sill=1.0, nugget=0.05
    )
    assert vg.major == 1500.0
    assert vg.minor == 700.0
    assert vg.vertical == 20.0
    assert abs(vg.azimuth - 35.0) < 1e-12
    assert vg.sill == 1.0
    assert vg.nugget == 0.05

    # Azimuth 90 means the major axis is +x; the same physical lag has lower
    # semivariance along major than minor.
    directional = pt.AnisotropicVariogram("spherical", 100.0, 25.0, 10.0, 90.0)
    assert directional.gamma_offset(30.0, 0.0) < directional.gamma_offset(0.0, 30.0)

    try:
        pt.AnisotropicVariogram("spherical", major=0.0, minor=700.0, vertical=20.0, azimuth=35.0)
        assert False, "expected invalid major range"
    except ValueError as e:
        assert "ranges must be positive" in str(e)


def test_anisotropic_sgs_accepts_isotropic_equivalent():
    coords = [[float(x), float(y), float(x + y)] for x in range(4) for y in range(4)]
    lat = pt.Lattice(0.0, 0.0, 1.0, 1.0, 5, 5)
    scalar = pt.Variogram("spherical", 0.0, 1.0, 4.0)
    aniso = pt.AnisotropicVariogram.isotropic("spherical", 0.0, 1.0, 4.0)
    f_scalar = pt.sgs(coords, lat, scalar, max_neighbours=8, radius=6.0, seed=23)
    f_aniso = pt.sgs(coords, lat, aniso, max_neighbours=8, radius=6.0, seed=23)
    max_abs = max(abs(a - b) for ca, cb in zip(f_scalar, f_aniso) for a, b in zip(ca, cb))
    assert max_abs < 1e-10


def test_resample_grid_to_grid():
    """Grid → grid resample honours world coords; bilinear exact on a plane."""
    # Affine source field z = 3 + 0.5x - 0.25y on a 5×5 lattice (spacing 10).
    src_lat = pt.Lattice(0.0, 0.0, 10.0, 10.0, 5, 5)
    src = [[3.0 + 0.5 * (10 * i) - 0.25 * (10 * j) for j in range(5)] for i in range(5)]

    # Identity resample is bit-equal (bilinear and nearest).
    same = pt.resample(src, src_lat, src_lat, "nearest")
    assert same == src

    # 2× refinement — bilinear reproduces the plane exactly at every new node.
    fine = pt.Lattice(0.0, 0.0, 5.0, 5.0, 9, 9)
    out = pt.resample(src, src_lat, fine, "bilinear")
    assert len(out) == 9 and len(out[0]) == 9
    for i in range(9):
        for j in range(9):
            expect = 3.0 + 0.5 * (5 * i) - 0.25 * (5 * j)
            assert abs(out[i][j] - expect) < 1e-9, (i, j, out[i][j])

    # Outside the source extent → NaN (never extrapolate).
    off = pt.Lattice(-100.0, 0.0, 10.0, 10.0, 2, 1)
    edge = pt.resample(src, src_lat, off, "bilinear")
    assert math.isnan(edge[0][0])


def test_rotated_lattice_frame_and_resample_are_exact():
    src_lat = pt.Lattice(
        431000.0, 6521000.0, 10.0, 12.0, 5, 5,
        rotation_deg=390.0, yflip=True,
    )
    assert src_lat.rotation_deg == 30.0 and src_lat.yflip is True
    assert "rotation_deg=30" in repr(src_lat)
    x, y = src_lat.intrinsic_to_world(1.25, 2.5)
    fi, fj = src_lat.world_to_intrinsic(x, y)
    assert abs(fi - 1.25) < 1e-10 and abs(fj - 2.5) < 1e-10
    assert src_lat.xy_to_ij(x, y) == (fi, fj)

    def plane(wx, wy):
        return 3.0 + 0.5 * wx - 0.25 * wy
    src = [
        [plane(*src_lat.node_xy(i, j)) for j in range(src_lat.nrow)]
        for i in range(src_lat.ncol)
    ]
    target = pt.Lattice(
        431000.0, 6521000.0, 5.0, 6.0, 9, 9,
        rotation_deg=30.0, yflip=True,
    )
    out = pt.resample(src, src_lat, target, "bilinear")
    for i in range(target.ncol):
        for j in range(target.nrow):
            assert abs(out[i][j] - plane(*target.node_xy(i, j))) < 1e-8

    g = pt.Georef(431000.0, 6521000.0)
    framed = g.lattice(10.0, 12.0, 5, 5, rotation_deg=30.0, yflip=True)
    assert framed.step_vectors() == src_lat.step_vectors()
    placed = g.place_intrinsic([12.5, 30.0], rotation_deg=30.0, yflip=True)
    assert abs(placed[0] - x) < 1e-10 and abs(placed[1] - y) < 1e-10
    try:
        pt.Lattice(0.0, 0.0, 1.0, 1.0, 2, 2, rotation_deg=float("nan"))
    except ValueError as exc:
        assert "rotation_deg must be finite" in str(exc)
    else:
        raise AssertionError("expected non-finite rotation to fail")


def test_interp1d_methods_and_natural_cubic():
    x = [0.0, 1.0, 2.0, 4.0]
    y = [0.0, 2.0, 1.0, 3.0]

    assert pt.interp1d(x, y, x, "cubic") == y
    assert pt.interp1d([0.0, 2.0], [10.0, 20.0], [1.0], "spline") == [15.0]
    assert pt.interp1d(x, y, [0.4, 1.6, 4.0], "previous") == [0.0, 2.0, 3.0]
    assert pt.interp1d(x, y, [0.4, 1.6, 4.0], "next") == [2.0, 1.0, 3.0]
    assert pt.interp1d(x, y, [0.4, 1.6, 3.5], "nearest") == [0.0, 1.0, 3.0]

    out = pt.interp1d(x, y, [-1.0, 0.5, 5.0], "linear")
    assert math.isnan(out[0])
    assert out[1] == 1.0
    assert math.isnan(out[2])

    ext = pt.interp1d([0.0, 1.0], [1.0, 3.0], [-1.0, 2.0], "linear", extrapolate=True)
    assert ext == [-1.0, 5.0]


def test_units_si_reporting():
    """SI reporting scales + scf/stb ↔ Sm³ conversions + format_volume."""
    assert pt.m3_to_mcm(2.5e6) == 2.5
    assert pt.mcm_to_m3(2.5) == 2.5e6
    assert pt.m3_to_msm3(3.0e6) == 3.0
    assert pt.m3_to_bcm(4.0e9) == 4.0
    assert abs(pt.sm3_to_scf(1.0) - 35.31466672148859) < 1e-9
    assert abs(pt.scf_to_sm3(pt.sm3_to_scf(123.4)) - 123.4) < 1e-9
    assert abs(pt.stb_to_sm3(1.0) - 0.158987294928) < 1e-15
    assert abs(pt.sm3_to_stb(pt.stb_to_sm3(1000.0)) - 1000.0) < 1e-9
    assert pt.km2_to_m2(2.5) == 2.5e6
    assert pt.m2_to_km2(2.5e6) == 2.5
    assert pt.format_volume(12.4e6) == "12.4 mcm"


def _mean(xs):
    return sum(xs) / len(xs)


def _std(xs):
    m = _mean(xs)
    return (sum((x - m) ** 2 for x in xs) / len(xs)) ** 0.5


def test_synth_log_series_moments_and_bounds():
    """A zone log hits its {mean,std} in bounds and is bit-reproducible."""
    zones = [pt.ZoneSpec(200.0, 0.24, 0.04, 8.0)]
    a = pt.synth_log_series(zones, 0.5, 0, 7)
    b = pt.synth_log_series(zones, 0.5, 0, 7)
    assert a == b  # seeded
    assert all(0.0 < v < 1.0 for v in a)  # bounds never violated
    assert abs(_mean(a) - 0.24) < 0.02
    assert abs(_std(a) - 0.04) < 0.02


def test_synth_facies_proportion_matches_ntg():
    fac = pt.synth_facies_series(4000, 0.25, 0.65, 2.5, 3)
    assert set(fac) <= {0, 1}
    assert abs(sum(fac) / len(fac) - 0.65) < 0.03
    # facies-composed porosity: sand mean clearly above shale mean.
    por = pt.synth_por_with_facies(fac, 0.25, 0.27, 0.03, 0.07, 0.02, 1.5, 3)
    assert all(0.0 < v < 1.0 for v in por)
    sand = [p for p, f in zip(por, fac) if f]
    shale = [p for p, f in zip(por, fac) if not f]
    assert _mean(sand) > _mean(shale) + 0.1


def test_synth_petro_curves_coupled_ntg():
    """Coupled petrophysics: net flag is derived from phie by the cutoff, and the
    realized series hits ntg_target + the net-rock moments."""
    zone = pt.PetroZoneSpec(
        0.6,  # ntg_target
        0.24,  # net_por_mean
        0.04,  # net_por_std
        0.06,  # nonnet_por_mean
        0.015,  # nonnet_por_std
        2.0,  # bed_scale_m
        1.5,  # correlation_len_m
    )
    assert zone.net_cutoff == 0.10  # default cutoff
    a = pt.synth_petro_curves(zone, 0.25, 20000, 5)
    b = pt.synth_petro_curves(zone, 0.25, 20000, 5)
    assert a["phie"] == b["phie"] and a["net_flag"] == b["net_flag"]  # seeded
    phie, flag = a["phie"], a["net_flag"]
    assert len(phie) == len(flag) == 20000
    # net flag is EXACTLY the cutoff of phie.
    assert all((f == 1.0) == (p >= 0.10) for p, f in zip(phie, flag))
    assert all(0.0 < p < 1.0 for p in phie)
    # realized NTG hits target; net-conditioned mean/std hit net_por.
    assert abs(sum(flag) / len(flag) - 0.6) < 0.02
    net = [p for p, f in zip(phie, flag) if f]
    assert abs(_mean(net) - 0.24) < 0.02
    assert abs(_std(net) - 0.04) < 0.02
    # NTG display curve tracks the flag density.
    ntg = pt.ntg_curve(flag, 0.25, 8.0)
    assert len(ntg) == len(flag)
    assert all(0.0 <= v <= 1.0 for v in ntg)
    # an infeasible spec raises (net-std floor imposed by a fat shale leak).
    fat = pt.PetroZoneSpec(0.5, 0.22, 0.035, 0.085, 0.03, 2.0, 1.5)
    try:
        pt.synth_petro_curves(fat, 0.25, 1000, 1)
        assert False, "expected an infeasibility error"
    except ValueError as e:
        assert "floor" in str(e)


def test_synth_dome_closure_and_trajectory():
    lat = pt.Lattice(0.0, 0.0, 50.0, 50.0, 40, 40)
    vg = pt.Variogram("spherical", 0.0, 1.0, 800.0)
    dome = pt.synth_dome_surface(lat, 100.0, 1.5, 20.0, 0.0, vg, 3)
    # crest interior and near relief; a corner is a flank.
    crest = max(max(c) for c in dome)
    assert crest > 80.0
    ring = pt.closure_outline(dome, lat, 50.0)
    assert len(ring) >= 8  # closed ring resolved
    # empty above the crest.
    assert pt.closure_outline(dome, lat, 500.0) == []
    # vertical trajectory columnar dict.
    traj = pt.synth_trajectory([500.0, 900.0], 30.0, 2500.0, 100.0, 1)
    assert set(traj) == {"md", "x", "y", "z", "tvd", "incl", "azim"}
    assert traj["md"] == traj["tvd"]
    assert traj["md"][-1] == 2500.0
    assert all(v == 0.0 for v in traj["incl"])


def test_synth_trend_map_recovers_correlation():
    lat = pt.Lattice(0.0, 0.0, 50.0, 50.0, 40, 40)
    vg = pt.Variogram("spherical", 0.0, 1.0, 900.0)
    base = pt.synth_isochore(lat, 20.0, 5.0, vg, 11)
    trend = pt.synth_trend_map(lat, vg, 22, (base, 0.8))
    assert all(0.0 <= v <= 1.0 for row in trend for v in row)
    # rank-ish correlation between flattened trend and base should be positive/high.
    tb = [v for row in trend for v in row]
    bb = [v for row in base for v in row]
    r = (
        sum((t - _mean(tb)) * (b - _mean(bb)) for t, b in zip(tb, bb))
        / (len(tb) * _std(tb) * _std(bb))
    )
    assert r > 0.4


def test_synth_trajectory_profile_build_hold():
    # A build-and-hold deviated bore heading due east (azimuth 90).
    wh = [431000.0, 6521000.0]
    traj = pt.synth_trajectory_profile(
        wh, 25.0, 2600.0, 15.0, 1,
        "build_hold", kickoff_md=800.0, build_rate_deg_per_30m=3.0,
        hold_incl_deg=45.0, azimuth_deg=90.0,
    )
    assert set(traj) == {"md", "x", "y", "z", "tvd", "incl", "azim"}
    # last station: at the hold inclination, moved east, shallower TVD than MD.
    assert abs(traj["incl"][-1] - 45.0) < 1e-6
    assert traj["x"][-1] - wh[0] > 400.0          # walked east
    assert abs(traj["y"][-1] - wh[1]) < 1e-6       # not north
    assert traj["tvd"][-1] < traj["md"][-1] - 100.0
    # dogleg severity ~ the build rate, and believable.
    dls = pt.max_dogleg_severity(traj["md"], traj["incl"], traj["azim"])
    assert abs(dls - 3.0) < 0.2
    # deterministic pass-through.
    again = pt.synth_trajectory_profile(
        wh, 25.0, 2600.0, 15.0, 1,
        "build_hold", kickoff_md=800.0, build_rate_deg_per_30m=3.0,
        hold_incl_deg=45.0, azimuth_deg=90.0,
    )
    assert traj == again
    # vertical variant equals the classic builder.
    v_profile = pt.synth_trajectory_profile(wh, 30.0, 2500.0, 25.0, 7, "vertical")
    v_plain = pt.synth_trajectory(wh, 30.0, 2500.0, 25.0, 7)
    assert v_profile == v_plain


def test_synth_trajectory_profile_build_hold_drop():
    traj = pt.synth_trajectory_profile(
        [431000.0, 6521000.0], 20.0, 2800.0, 15.0, 1,
        "build_hold_drop", kickoff_md=700.0, build_rate_deg_per_30m=3.0,
        hold_incl_deg=60.0, azimuth_deg=30.0,
        drop_start_md=1800.0, drop_rate_deg_per_30m=3.0, final_incl_deg=20.0,
    )
    peak = max(traj["incl"])
    assert abs(peak - 60.0) < 1e-6                 # hit the hold
    assert abs(traj["incl"][-1] - 20.0) < 1e-6      # dropped back
    # a bad profile name is a ValueError (pass-through of the typed error).
    try:
        pt.synth_trajectory_profile([0.0, 0.0], 20.0, 1000.0, 15.0, 1, "banana")
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for unknown profile")


def test_georef_world_frame_round_trip():
    # Build a world surface at a fictional origin; a deviated well's reservoir
    # crossing top must land at the trajectory's (x,y), not the wellhead's.
    g = pt.Georef()  # fictional origin
    assert g.origin() == [431000.0, 6521000.0]
    lat = g.lattice(50.0, 50.0, 100, 100)
    x0, y0 = g.east0, g.north0
    a, b, c = 0.04, -0.02, 2000.0
    surface = [[c + a * (x0 + i * 50.0 - x0) + b * (y0 + j * 50.0 - y0)
                for j in range(100)] for i in range(100)]
    wh = g.place_point([800.0, 800.0])
    traj = pt.synth_trajectory_profile(
        wh, 25.0, 3000.0, 15.0, 1,
        "build_hold", kickoff_md=700.0, build_rate_deg_per_30m=3.0,
        hold_incl_deg=50.0, azimuth_deg=60.0,
    )
    # station nearest 2000 m TVD.
    k = min(range(len(traj["tvd"])), key=lambda i: abs(traj["tvd"][i] - 2000.0))
    cross = [traj["x"][k], traj["y"][k]]
    offset = math.hypot(cross[0] - wh[0], cross[1] - wh[1])
    assert offset > 300.0
    resid = pt.Sampler.uniform(-1e-9, 1e-9)
    tops = pt.tops_from_surface(surface, lat, [cross, wh], resid, 3)
    analytic = lambda x, y: c + a * (x - x0) + b * (y - y0)
    assert abs(tops[0] - analytic(cross[0], cross[1])) < 1e-2
    assert abs(tops[0] - tops[1]) > 5.0            # not the wellhead value


def _main():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  ok  {fn.__name__}")
    print(f"\n{len(fns)} smoke checks passed — petektools {pt.__version__}")


if __name__ == "__main__":
    _main()
