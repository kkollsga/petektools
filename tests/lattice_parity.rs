//! Golden parity test: `Lattice` ⇄ petekio `GridGeometry`.
//!
//! petekio can later delegate its gridding here by mapping `GridGeometry` →
//! [`petektools::Lattice`] 1:1, but *only* if the two agree numerically on
//! `node_xy` / `xy_to_ij`. `transfer/geometry.rs` (the upstream reference) is
//! retired once the kernels are ported, so this test pins the contract two ways:
//!
//! 1. against `ref_*` functions transcribed verbatim from petekio 0.2.0
//!    `GridGeometry` (the algorithm, independent of `Lattice`'s own code), and
//! 2. against hard-coded absolute golden values.
//!
//! Both must hold across the rotated and y-flipped cases that exercise every
//! term of the transform.

use petektools::Lattice;

// --- Upstream reference: petekio 0.2.0 GridGeometry, transcribed verbatim. ---

fn ref_yflip_factor(yflip: bool) -> f64 {
    if yflip {
        -1.0
    } else {
        1.0
    }
}

fn ref_node_xy(g: &Lattice, i: usize, j: usize) -> (f64, f64) {
    let (s, c) = g.rotation_deg.to_radians().sin_cos();
    let di = i as f64 * g.xinc;
    let dj = j as f64 * g.yinc * ref_yflip_factor(g.yflip);
    (g.xori + di * c - dj * s, g.yori + di * s + dj * c)
}

fn ref_xy_to_ij(g: &Lattice, x: f64, y: f64) -> Option<(f64, f64)> {
    if g.xinc == 0.0 || g.yinc == 0.0 {
        return None;
    }
    let (s, c) = g.rotation_deg.to_radians().sin_cos();
    let dx = x - g.xori;
    let dy = y - g.yori;
    let u = dx * c + dy * s;
    let v = -dx * s + dy * c;
    Some((u / g.xinc, v / (g.yinc * ref_yflip_factor(g.yflip))))
}

// --- Test cases spanning unrotated, rotated, flipped, and combined. ---

fn cases() -> Vec<Lattice> {
    let mut rotated = Lattice::regular(1000.0, 2000.0, 25.0, 50.0, 10, 8);
    rotated.rotation_deg = 30.0;

    let mut flipped = Lattice::regular(500.0, 750.0, 10.0, 20.0, 6, 6);
    flipped.yflip = true;

    let mut both = Lattice::regular(-100.0, 40.0, 12.5, 12.5, 7, 9);
    both.rotation_deg = 47.3;
    both.yflip = true;

    vec![
        Lattice::regular(0.0, 0.0, 1.0, 1.0, 5, 5),
        rotated,
        flipped,
        both,
    ]
}

#[test]
fn node_xy_matches_upstream_gridgeometry() {
    for g in cases() {
        for j in 0..g.nrow {
            for i in 0..g.ncol {
                let (gx, gy) = g.node_xy(i, j);
                let (rx, ry) = ref_node_xy(&g, i, j);
                assert!(
                    (gx - rx).abs() < 1e-12 && (gy - ry).abs() < 1e-12,
                    "node_xy parity broke at ({i},{j}) for {g:?}: lattice=({gx},{gy}) ref=({rx},{ry})"
                );
            }
        }
    }
}

#[test]
fn xy_to_ij_matches_upstream_gridgeometry() {
    for g in cases() {
        // Probe each node's world position plus some off-node points.
        for j in 0..g.nrow {
            for i in 0..g.ncol {
                let (x, y) = g.node_xy(i, j);
                for (dx, dy) in [(0.0, 0.0), (0.3, -0.7), (-1.1, 2.2)] {
                    let (px, py) = (x + dx, y + dy);
                    let lat = g.xy_to_ij(px, py);
                    let rf = ref_xy_to_ij(&g, px, py);
                    match (lat, rf) {
                        (Some((li, lj)), Some((ri, rj))) => assert!(
                            (li - ri).abs() < 1e-12 && (lj - rj).abs() < 1e-12,
                            "xy_to_ij parity broke for {g:?} at ({px},{py})"
                        ),
                        (None, None) => {}
                        _ => panic!("xy_to_ij definedness disagrees for {g:?} at ({px},{py})"),
                    }
                }
            }
        }
    }
}

#[test]
fn absolute_golden_values() {
    // A 30°-rotated lattice: node (1,0) is xinc along the rotated I-axis from
    // the origin. xinc = 25, so (Δx, Δy) = (25·cos30°, 25·sin30°).
    let mut g = Lattice::regular(1000.0, 2000.0, 25.0, 50.0, 10, 8);
    g.rotation_deg = 30.0;
    let (x, y) = g.node_xy(1, 0);
    assert!((x - (1000.0 + 25.0 * 30f64.to_radians().cos())).abs() < 1e-9);
    assert!((y - (2000.0 + 25.0 * 30f64.to_radians().sin())).abs() < 1e-9);

    // node (0,1) on the same lattice: yinc = 50 along the rotated J-axis,
    // i.e. (−50·sin30°, 50·cos30°) from the origin.
    let (x, y) = g.node_xy(0, 1);
    assert!((x - (1000.0 - 50.0 * 30f64.to_radians().sin())).abs() < 1e-9);
    assert!((y - (2000.0 + 50.0 * 30f64.to_radians().cos())).abs() < 1e-9);

    // y-flip inverts the J-axis: node (0,1) sits below the origin in world y.
    let mut f = Lattice::regular(0.0, 0.0, 10.0, 20.0, 4, 4);
    f.yflip = true;
    assert_eq!(f.node_xy(0, 1), (0.0, -20.0));
    // round-trips back to fractional (0, 1).
    let (fi, fj) = f.xy_to_ij(0.0, -20.0).unwrap();
    assert!((fi - 0.0).abs() < 1e-12 && (fj - 1.0).abs() < 1e-12);
}
