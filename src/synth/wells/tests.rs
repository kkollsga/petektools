//! Tests for the `wells` submodules (placement, tops, trajectory).

use super::placement::point_in_polygon;
use super::*;
use crate::foundation::{BBox, Lattice};
use crate::sampling::Sampler;
use ndarray::Array2;

fn extent() -> BBox {
    BBox {
        xmin: 0.0,
        ymin: 0.0,
        xmax: 100.0,
        ymax: 200.0,
    }
}

#[test]
fn place_wells_in_extent_and_reproducible() {
    let e = extent();
    let a = place_wells(&e, 25, 42).unwrap();
    let b = place_wells(&e, 25, 42).unwrap();
    assert_eq!(a, b);
    assert_eq!(a.len(), 25);
    for w in &a {
        assert!(w[0] >= e.xmin && w[0] < e.xmax && w[1] >= e.ymin && w[1] < e.ymax);
    }
    assert!(place_wells(&e, 0, 1).unwrap().is_empty());
}

#[test]
fn degenerate_extent_errors() {
    let bad = BBox {
        xmin: 1.0,
        ymin: 0.0,
        xmax: 1.0,
        ymax: 10.0,
    };
    assert!(place_wells(&bad, 5, 1).is_err());
}

#[test]
fn polygon_placement_stays_inside() {
    // A triangle.
    let poly = [[0.0, 0.0], [100.0, 0.0], [0.0, 100.0]];
    let ws = place_wells_in_polygon(&poly, 40, 7).unwrap();
    assert_eq!(ws.len(), 40);
    for w in &ws {
        assert!(point_in_polygon(w[0], w[1], &poly), "point outside polygon");
    }
    // reproducible
    let ws2 = place_wells_in_polygon(&poly, 40, 7).unwrap();
    assert_eq!(ws, ws2);
}

#[test]
fn polygon_needs_three_vertices() {
    assert!(place_wells_in_polygon(&[[0.0, 0.0], [1.0, 1.0]], 3, 1).is_err());
}

#[test]
fn tops_sample_and_add_residual() {
    // A planar surface z = x (so the top at (x,y) ≈ x before residual).
    let lat = Lattice::regular(0.0, 0.0, 10.0, 10.0, 11, 11);
    let surface = Array2::from_shape_fn((11, 11), |(i, _j)| lat.node_xy(i, 0).0);
    let wells = vec![[15.0, 20.0], [55.0, 80.0]];
    // Zero-width residual via a tiny uniform (deterministic-ish center 0).
    let resid = Sampler::new_uniform(-1e-9, 1e-9).unwrap();
    let tops = tops_from_surface(&surface, &lat, &wells, &resid, 3);
    assert!((tops[0] - 15.0).abs() < 1e-3, "top0 {}", tops[0]);
    assert!((tops[1] - 55.0).abs() < 1e-3, "top1 {}", tops[1]);
}

#[test]
fn tops_outside_extent_are_nan() {
    let lat = Lattice::regular(0.0, 0.0, 10.0, 10.0, 11, 11);
    let surface = Array2::from_elem((11, 11), 5.0);
    let wells = vec![[1000.0, 1000.0]];
    let resid = Sampler::new_normal(0.0, 1.0).unwrap();
    let tops = tops_from_surface(&surface, &lat, &wells, &resid, 1);
    assert!(tops[0].is_nan());
}

#[test]
fn tops_residual_reproducible() {
    let lat = Lattice::regular(0.0, 0.0, 10.0, 10.0, 11, 11);
    let surface = Array2::from_elem((11, 11), 50.0);
    let wells = vec![[15.0, 20.0], [55.0, 80.0]];
    let resid = Sampler::new_normal(0.0, 10.0).unwrap();
    let a = tops_from_surface(&surface, &lat, &wells, &resid, 99);
    let b = tops_from_surface(&surface, &lat, &wells, &resid, 99);
    assert_eq!(a, b);
    assert!(
        a.iter().any(|&v| (v - 50.0).abs() > 1e-6),
        "residual not applied"
    );
}

#[test]
fn vertical_trajectory_is_well_formed() {
    let t = synth_trajectory([500.0, 900.0], 30.0, 2500.0, 100.0, 1).unwrap();
    // top and TD present, monotone MD, MD==TVD, constant xy, zero angles.
    assert_eq!(t.stations.first().unwrap().md, 0.0);
    assert!((t.stations.last().unwrap().tvd - 2500.0).abs() < 1e-9);
    for s in &t.stations {
        assert_eq!(s.x, 500.0);
        assert_eq!(s.y, 900.0);
        assert_eq!(s.md, s.tvd);
        assert_eq!(s.incl, 0.0);
        assert_eq!(s.azim, 0.0);
        assert!((s.z - (30.0 - s.tvd)).abs() < 1e-9);
    }
    // strictly increasing MD
    for w in t.stations.windows(2) {
        assert!(w[1].md > w[0].md);
    }
}

#[test]
fn trajectory_bad_args_error() {
    assert!(synth_trajectory([0.0, 0.0], 0.0, 0.0, 100.0, 1).is_err());
    assert!(synth_trajectory([0.0, 0.0], 0.0, 1000.0, 0.0, 1).is_err());
    assert!(synth_trajectory([f64::NAN, 0.0], 0.0, 1000.0, 100.0, 1).is_err());
}

// ---- deviated trajectories --------------------------------------------

fn build_hold(kickoff: f64, rate: f64, hold: f64, az: f64) -> WellProfile {
    WellProfile::BuildHold(BuildHold::new(kickoff, rate, hold, az).unwrap())
}

#[test]
fn vertical_profile_equals_synth_trajectory() {
    // The Vertical variant must be bit-identical to the classic builder.
    let a = synth_trajectory([431_500.0, 6_521_900.0], 30.0, 2500.0, 25.0, 7).unwrap();
    let b = synth_trajectory_profile(
        [431_500.0, 6_521_900.0],
        30.0,
        2500.0,
        25.0,
        &WellProfile::Vertical,
        7,
    )
    .unwrap();
    assert_eq!(a, b);
}

#[test]
fn build_hold_matches_the_analytic_profile() {
    // Kickoff 800 m, build 3°/30 m to a 45° hold on azimuth 90° (due east).
    let (kickoff, rate, hold, az) = (800.0, 3.0, 45.0, 90.0);
    let wh = [431_000.0, 6_521_000.0];
    let t = synth_trajectory_profile(
        wh,
        25.0,
        2600.0,
        10.0,
        &build_hold(kickoff, rate, hold, az),
        1,
    )
    .unwrap();

    // Above the kickoff: still vertical — MD == TVD, no horizontal move.
    for s in t.stations.iter().filter(|s| s.md < kickoff - 1e-9) {
        assert_eq!(s.incl, 0.0, "incl before kickoff");
        assert!((s.tvd - s.md).abs() < 1e-6, "tvd!=md before kickoff");
        assert!(
            (s.x - wh[0]).abs() < 1e-6 && (s.y - wh[1]).abs() < 1e-6,
            "moved before kickoff"
        );
    }
    // In the build section: inclination is linear in (MD − kickoff).
    let build_len = hold / (rate / 30.0); // 450 m
    for s in t.stations.iter() {
        if s.md > kickoff + 1e-6 && s.md < kickoff + build_len - 1e-6 {
            let expect = (s.md - kickoff) * (rate / 30.0);
            assert!(
                (s.incl - expect).abs() < 1e-9,
                "build incl {} vs {}",
                s.incl,
                expect
            );
        }
    }
    // Past the build: the hold inclination on the target azimuth.
    let last = t.stations.last().unwrap();
    assert!((last.incl - hold).abs() < 1e-9, "hold incl {}", last.incl);
    assert!((last.azim - az).abs() < 1e-9, "hold azim {}", last.azim);
    // Azimuth 90° ⇒ displacement is (almost) pure +x (east); +y ~ 0.
    assert!(
        last.x - wh[0] > 400.0,
        "no eastward reach: {}",
        last.x - wh[0]
    );
    assert!(
        (last.y - wh[1]).abs() < 1e-6,
        "unexpected northing move: {}",
        last.y - wh[1]
    );
    // A deviated bore reaches a shallower TVD than its MD.
    assert!(
        last.tvd < last.md - 100.0,
        "tvd {} not shallower than md {}",
        last.tvd,
        last.md
    );
}

#[test]
fn build_hold_is_bit_deterministic() {
    let p = build_hold(700.0, 2.5, 55.0, 210.0);
    let a = synth_trajectory_profile([431_000.0, 6_521_000.0], 30.0, 2800.0, 15.0, &p, 4).unwrap();
    let b = synth_trajectory_profile([431_000.0, 6_521_000.0], 30.0, 2800.0, 15.0, &p, 4).unwrap();
    assert_eq!(a, b);
}

#[test]
fn dogleg_severity_is_bounded_and_believable() {
    // The build section's dogleg severity equals the build rate; hold/vertical
    // sections add none, so max DLS ≈ the rate and stays under the ceiling.
    let rate = 3.0;
    let p = build_hold(600.0, rate, 60.0, 45.0);
    let t = synth_trajectory_profile([431_000.0, 6_521_000.0], 20.0, 2600.0, 20.0, &p, 1).unwrap();
    let dls = max_dogleg_severity(&t);
    assert!(
        (dls - rate).abs() < 0.15,
        "max DLS {dls} not ~= build rate {rate}"
    );
    assert!(
        dls <= MAX_BUILD_RATE_DEG_PER_30M + 1e-9,
        "DLS {dls} over ceiling"
    );
    // A vertical well has zero dogleg.
    let v = synth_trajectory([431_000.0, 6_521_000.0], 20.0, 2000.0, 50.0, 1).unwrap();
    assert_eq!(max_dogleg_severity(&v), 0.0);
}

#[test]
fn build_hold_drop_returns_toward_vertical() {
    let bh = BuildHold::new(700.0, 3.0, 60.0, 30.0).unwrap();
    // Hold 60° until 1800 m MD, then drop at 3°/30 m back to 20°.
    let bhd = BuildHoldDrop::new(bh, 1800.0, 3.0, 20.0).unwrap();
    let t = synth_trajectory_profile(
        [431_000.0, 6_521_000.0],
        20.0,
        2800.0,
        10.0,
        &WellProfile::BuildHoldDrop(bhd),
        1,
    )
    .unwrap();
    // Peak inclination is the hold; the last station has dropped below it.
    let peak = t.stations.iter().map(|s| s.incl).fold(0.0, f64::max);
    assert!((peak - 60.0).abs() < 1e-6, "peak incl {peak}");
    let last = t.stations.last().unwrap();
    assert!(
        (last.incl - 20.0).abs() < 1e-6,
        "final incl {} not the drop target",
        last.incl
    );
    // Still believable dogleg through the S.
    assert!(max_dogleg_severity(&t) <= MAX_BUILD_RATE_DEG_PER_30M + 1e-9);
}

#[test]
fn deviated_bore_sweeps_many_columns_at_reservoir_depth() {
    // A 55° hold; by ~2000 m TVD the swept easting should span many 100 m columns.
    let p = build_hold(700.0, 3.0, 55.0, 90.0);
    let t = synth_trajectory_profile([431_000.0, 6_521_000.0], 20.0, 3200.0, 20.0, &p, 1).unwrap();
    let reservoir: Vec<&Station> = t.stations.iter().filter(|s| s.tvd >= 1800.0).collect();
    assert!(reservoir.len() >= 5, "too few reservoir stations");
    let x0 = reservoir.first().unwrap().x;
    let x1 = reservoir.last().unwrap().x;
    let cols = ((x1 / 100.0).floor() - (x0 / 100.0).floor()).abs();
    assert!(
        cols >= 3.0,
        "reservoir section crosses only {cols} 100 m columns"
    );
}

#[test]
fn profile_builders_validate() {
    // build rate out of the believable band, non-finite, degenerate incl.
    assert!(BuildHold::new(-1.0, 3.0, 45.0, 0.0).is_err());
    assert!(BuildHold::new(500.0, 0.0, 45.0, 0.0).is_err());
    assert!(BuildHold::new(500.0, 99.0, 45.0, 0.0).is_err());
    assert!(BuildHold::new(500.0, 3.0, 0.0, 0.0).is_err());
    assert!(BuildHold::new(500.0, 3.0, 90.0, 0.0).is_err());
    assert!(BuildHold::new(500.0, 3.0, 45.0, f64::NAN).is_err());
    // azimuth normalized into [0, 360).
    assert!((BuildHold::new(500.0, 3.0, 45.0, -90.0).unwrap().azimuth_deg - 270.0).abs() < 1e-9);
    // drop must start at/after the build ends, and land within [0, hold].
    let bh = BuildHold::new(700.0, 3.0, 60.0, 0.0).unwrap();
    assert!(BuildHoldDrop::new(bh, 500.0, 3.0, 20.0).is_err()); // before build end
    assert!(BuildHoldDrop::new(bh, 2000.0, 3.0, 70.0).is_err()); // final > hold
    assert!(BuildHoldDrop::new(bh, 2000.0, 99.0, 20.0).is_err()); // drop rate too high
    assert!(BuildHoldDrop::new(bh, 2000.0, 3.0, 20.0).is_ok());
}

#[test]
fn deviated_bad_args_error() {
    let p = build_hold(500.0, 3.0, 45.0, 0.0);
    assert!(synth_trajectory_profile([0.0, 0.0], 0.0, 0.0, 10.0, &p, 1).is_err());
    assert!(synth_trajectory_profile([0.0, 0.0], 0.0, 1000.0, 0.0, &p, 1).is_err());
    assert!(synth_trajectory_profile([f64::NAN, 0.0], 0.0, 1000.0, 10.0, &p, 1).is_err());
}

// ---- world-frame round-trip (testing doctrine R1) ---------------------

#[test]
fn world_frame_top_lands_at_the_deviated_reservoir_crossing_not_the_wellhead() {
    use crate::synth::Georef;

    // A world surface at a fictional origin: a plane depth = c + a·(x−x0) + b·(y−y0),
    // so its exact value at ANY world (X,Y) inside the extent is known (bilinear is
    // exact on a linear field). Node (0,0) sits at the fictional origin.
    let g = Georef::fictional();
    let (x0, y0) = (g.east0, g.north0);
    let lat = g.lattice(50.0, 50.0, 100, 100); // 5000 m × 5000 m
    let (a, b, c) = (0.04_f64, -0.02_f64, 2000.0_f64);
    let surface = Array2::from_shape_fn((100, 100), |(i, j)| {
        let (x, y) = lat.node_xy(i, j);
        c + a * (x - x0) + b * (y - y0)
    });
    let analytic = |x: f64, y: f64| c + a * (x - x0) + b * (y - y0);

    // A deviated well: wellhead well inside the extent, building to a 50° hold on
    // azimuth 60° so it walks a long way in world x/y before the reservoir.
    let wellhead = [x0 + 800.0, y0 + 800.0];
    let p = build_hold(700.0, 3.0, 50.0, 60.0);
    let t = synth_trajectory_profile(wellhead, 25.0, 3000.0, 15.0, &p, 1).unwrap();

    // Reservoir crossing: the station nearest 2000 m TVD.
    let cross = t
        .stations
        .iter()
        .min_by(|u, v| {
            (u.tvd - 2000.0)
                .abs()
                .partial_cmp(&(v.tvd - 2000.0).abs())
                .unwrap()
        })
        .unwrap();
    // The crossing has genuinely walked away from the wellhead (many 100 m columns)
    // yet stays inside the surface extent.
    let bb = lat.bbox();
    assert!(cross.x > bb.xmin && cross.x < bb.xmax && cross.y > bb.ymin && cross.y < bb.ymax);
    let offset = ((cross.x - wellhead[0]).powi(2) + (cross.y - wellhead[1]).powi(2)).sqrt();
    assert!(
        offset > 300.0,
        "crossing barely moved from the wellhead: {offset} m"
    );

    // Sample the world surface at the crossing (x,y) and at the wellhead (x,y).
    let resid = Sampler::new_uniform(-1e-9, 1e-9).unwrap();
    let tops = tops_from_surface(
        &surface,
        &lat,
        &[[cross.x, cross.y], [wellhead[0], wellhead[1]]],
        &resid,
        3,
    );
    // The pick at the crossing matches the surface at the TRAJECTORY'S (x,y) …
    assert!(
        (tops[0] - analytic(cross.x, cross.y)).abs() < 1e-3,
        "crossing top {} != analytic {}",
        tops[0],
        analytic(cross.x, cross.y)
    );
    // … and is clearly NOT the wellhead value (that was the whole escape).
    assert!(
        (tops[0] - tops[1]).abs() > 5.0,
        "crossing top == wellhead top ({} vs {}): frame not honoured",
        tops[0],
        tops[1]
    );
    assert!((tops[1] - analytic(wellhead[0], wellhead[1])).abs() < 1e-3);
}
