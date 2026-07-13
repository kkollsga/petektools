"""Synthetic asset package tests.

The full cross-library parity gate lives in petekSim. These tests pin the
petekTools side: public API shape, single-asset writer format markers, and a
small deterministic composer smoke.
"""

from __future__ import annotations

import petektools as pt


def test_public_api_lock():
    assert sorted(pt.__all__) == [
        "AnisotropicVariogram",
        "Clamped",
        "CorrelationTemplate",
        "CorrelationTrack",
        "ExperimentalVariogram",
        "Georef",
        "Lattice",
        "PetroZoneSpec",
        "ReservoirSummary",
        "Rng",
        "Sampler",
        "Variogram",
        "WellLabelStyle",
        "WellMarkerStyle",
        "WellPathStyle",
        "WellStyle",
        "WorkspaceSession",
        "ZoneSpec",
        "__version__",
        "aggregate",
        "bcm_to_m3",
        "closure_outline",
        "evaluate_formula",
        "experimental_variogram",
        "format_volume",
        "formula_info",
        "interp1d",
        "km2_to_m2",
        "local_kriging_grid",
        "local_kriging_grid_flat",
        "m2_to_km2",
        "m3_to_bcm",
        "m3_to_mcm",
        "m3_to_msm3",
        "max_dogleg_severity",
        "mcm_to_m3",
        "mean",
        "median",
        "msm3_to_m3",
        "ntg_curve",
        "percentile",
        "place_wells",
        "place_wells_in_polygon",
        "resample",
        "resample_flat",
        "reservoir_summary",
        "scf_to_sm3",
        "sgs",
        "sgs_flat",
        "sm3_to_scf",
        "sm3_to_stb",
        "stb_to_sm3",
        "std",
        "study_area_outline",
        "synth_asset",
        "synth_dome_surface",
        "synth_dome_surface_flat",
        "synth_facies_series",
        "synth_isochore",
        "synth_isochore_flat",
        "synth_log_series",
        "synth_petro_curves",
        "synth_por_with_facies",
        "synth_trajectory",
        "synth_trajectory_profile",
        "synth_trend_map",
        "synth_trend_map_flat",
        "tops_from_surface",
        "variance",
        "view",
        "view2d",
        "view2d_payload",
        "view3d",
        "view3d_payload",
        "weighted_mean",
        "weighted_percentile",
        "weighted_std",
        "weighted_variance",
        "write_cps3_grid",
        "write_cps3_lines",
        "write_earthvision_grid",
        "write_irap_grid",
        "write_irap_points",
        "write_las2",
        "write_petrel_tops",
        "write_wellpath",
        "zone_sample_counts",
    ]


def test_single_asset_writers_emit_format_markers(tmp_path):
    lat = pt.Lattice(1000.0, 2000.0, 10.0, 20.0, 3, 2)
    field = [[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]]

    irap = tmp_path / "one.irap"
    cps = tmp_path / "one.CPS3grid"
    points = tmp_path / "one.IrapClassicPoints"
    ev = tmp_path / "one.EarthVisionGrid"
    pt.write_irap_grid(irap, field, lat, negate=True)
    pt.write_cps3_grid(cps, field, lat, negate=True)
    pt.write_irap_points(points, field, lat)
    pt.write_earthvision_grid(ev, field, lat)

    assert irap.read_text().splitlines()[0].startswith("-996 2")
    assert cps.read_text().splitlines()[0].startswith("FSASCI")
    assert points.read_text().splitlines()[0].split() == ["1000.000", "2000.000", "-1.0000"]
    assert "EarthVision" in ev.read_text().splitlines()[0]


def test_synth_asset_small_tree_is_deterministic(tmp_path):
    a = pt.synth_asset(tmp_path / "a", seed=21, n_wells=4, ncol=13)
    b = pt.synth_asset(tmp_path / "b", seed=21, n_wells=4, ncol=13)

    assert a["asset_version"] == b["asset_version"] == 2
    assert a["aliases"] == b["aliases"]
    assert a["horizons"] == b["horizons"]
    assert (tmp_path / "a" / "Surfaces" / "H0.irap").exists()
    assert (tmp_path / "a" / "Polygons" / "ModelEdge.CPS3lines").exists()
    assert (tmp_path / "a" / "WellTops" / "FieldWellTops").exists()

    assert a["root"] == str(tmp_path / "a")
    assert a["crs"] == "SYNTHETIC / ED50 UTM zone 31N"
