//! Sub-node scatter conditioning audit (`task_petektools_scatter_conditioning`).
//!
//! Mirrors petekStatic's structure-fidelity fixture shape: **dense off-node
//! scatter** (~0.65× node spacing) over a known analytic truth (a regional plane
//! plus a smooth dome), gridded by minimum curvature. The historical
//! [`Conditioning::NearestNode`] path snap-averages each sample onto its nearest
//! node — a metres-level misfit AT the data on the dipping/curved flank. The new
//! [`Conditioning::Bilinear`] path honours each off-node sample through the
//! bilinear interpolation of its four surrounding nodes (a least-squares fit
//! folded into the solve), so the *interpolated* surface passes through the
//! datum. We measure the on-scatter rms/max both ways and pin the improvement.
//!
//! Truth is fully synthetic (a fictional dipping plane + Gaussian dome at a
//! fictional coordinate window); no dataset content. A world-scale georef variant
//! (large origin + real spacing) is included per doctrine R1.

use ndarray::Array2;
use petektools::{grid_min_curvature_conditioned, Conditioning, Lattice};

const N: usize = 21; // 21×21 nodes = 20×20 cells
const SPACING: f64 = 100.0; // 100 m lattice
const EXTENT: f64 = (N - 1) as f64 * SPACING; // 2000 m
const MARGIN: f64 = 20.0; // keep the scatter a touch inside the extent
const SCATTER_STEP: f64 = 65.0; // ≈ 0.65× spacing → off-node by construction
const REGIONAL: f64 = 2000.0;
const DIP_X: f64 = 0.02; // 2 m per 100 m — a real regional dip
const DIP_Y: f64 = -0.015;
const DOME_AMP: f64 = 60.0;
const DOME_X: f64 = 1100.0;
const DOME_Y: f64 = 900.0;
const DOME_SIGMA: f64 = 300.0;
const ORIGIN_X: f64 = 700_000.0; // fictional world window (doctrine R1 variant)
const ORIGIN_Y: f64 = 7_100_000.0;

/// Analytic truth depth: a regional dipping plane minus a smooth Gaussian dome
/// (defined in lattice-LOCAL coordinates, 0-origin).
fn truth(x: f64, y: f64) -> f64 {
    let (dx, dy) = ((x - DOME_X) / DOME_SIGMA, (y - DOME_Y) / DOME_SIGMA);
    REGIONAL + DIP_X * x + DIP_Y * y - DOME_AMP * (-(dx * dx + dy * dy)).exp()
}

/// Dense scatter over `[lo, hi]²` at 65 m, offset so points never sit on nodes.
fn scatter_xy(lo: f64, hi: f64) -> Vec<(f64, f64)> {
    let mut pts = Vec::new();
    let mut y = lo + 13.0;
    while y <= hi {
        let mut x = lo + 17.0;
        while x <= hi {
            pts.push((x, y));
            x += SCATTER_STEP;
        }
        y += SCATTER_STEP;
    }
    pts
}

/// Bilinear read of a solved node field at LOCAL `(x, y)` on a lattice whose
/// origin is `(ox, oy)` — the "surface value at a point" the audit uses.
fn eval_local(field: &Array2<f64>, lattice: &Lattice, x: f64, y: f64) -> f64 {
    let (nc, nr) = (lattice.ncol, lattice.nrow);
    let (fi, fj) = lattice
        .xy_to_ij(lattice.xori + x, lattice.yori + y)
        .unwrap();
    let fi = fi.clamp(0.0, (nc - 1) as f64);
    let fj = fj.clamp(0.0, (nr - 1) as f64);
    let (i0, j0) = (fi.floor() as usize, fj.floor() as usize);
    let (i1, j1) = ((i0 + 1).min(nc - 1), (j0 + 1).min(nr - 1));
    let (tx, ty) = (fi - i0 as f64, fj - j0 as f64);
    field[[i0, j0]] * (1.0 - tx) * (1.0 - ty)
        + field[[i1, j0]] * tx * (1.0 - ty)
        + field[[i0, j1]] * (1.0 - tx) * ty
        + field[[i1, j1]] * tx * ty
}

fn rms(errs: &[f64]) -> f64 {
    (errs.iter().map(|e| e * e).sum::<f64>() / errs.len() as f64).sqrt()
}
fn max_abs(errs: &[f64]) -> f64 {
    errs.iter().fold(0.0_f64, |a, e| a.max(e.abs()))
}

/// Local-coordinate scatter → `[world_x, world_y, z]` rows for `lattice`.
fn coords_for(lattice: &Lattice, pts: &[(f64, f64)]) -> Vec<[f64; 3]> {
    pts.iter()
        .map(|&(x, y)| [lattice.xori + x, lattice.yori + y, truth(x, y)])
        .collect()
}

/// On-scatter error vector of a solved field vs truth.
fn on_scatter_errs(field: &Array2<f64>, lattice: &Lattice, pts: &[(f64, f64)]) -> Vec<f64> {
    pts.iter()
        .map(|&(x, y)| eval_local(field, lattice, x, y) - truth(x, y))
        .collect()
}

/// Solve both modes on `lattice` from the full-extent scatter, returning
/// `((nearest_rms, nearest_max), (bilinear_rms, bilinear_max))` at the scatter.
fn nearest_vs_bilinear(label: &str, lattice: &Lattice) -> ((f64, f64), (f64, f64)) {
    let pts = scatter_xy(MARGIN, EXTENT - MARGIN);
    let coords = coords_for(lattice, &pts);
    let nearest =
        grid_min_curvature_conditioned(&coords, lattice, None, Conditioning::NearestNode).unwrap();
    let bilinear =
        grid_min_curvature_conditioned(&coords, lattice, None, Conditioning::Bilinear).unwrap();
    let ne = on_scatter_errs(&nearest, lattice, &pts);
    let be = on_scatter_errs(&bilinear, lattice, &pts);
    let out = ((rms(&ne), max_abs(&ne)), (rms(&be), max_abs(&be)));
    eprintln!(
        "[{label}] {} off-node pts | NearestNode rms {:.3} m max {:.3} m | Bilinear rms {:.3} m max {:.3} m ({:.0}% rms)",
        pts.len(),
        (out.0).0,
        (out.0).1,
        (out.1).0,
        (out.1).1,
        100.0 * (1.0 - (out.1).0 / (out.0).0),
    );
    out
}

// ---------------------------------------------------------------------------
// S1 — the conditioning fix: off-node snap error removed
// ---------------------------------------------------------------------------

#[test]
fn snap_defect_reproduced_then_fixed() {
    let lattice = Lattice::regular(0.0, 0.0, SPACING, SPACING, N, N);
    let ((n_rms, n_max), (b_rms, b_max)) = nearest_vs_bilinear("unit-origin 100 m", &lattice);

    // The NearestNode path reproduces the metres-level on-data snap defect.
    assert!(
        n_rms > 0.5 && n_max > 2.0,
        "the snap fixture must demonstrate the defect: rms {n_rms} max {n_max}"
    );
    // The Bilinear fix drops it to a small, documented residual — a large fraction
    // of the snap error is removed at the data.
    assert!(
        b_rms < 0.30 && b_rms < 0.35 * n_rms,
        "Bilinear must remove most of the snap error: rms {b_rms} (nearest {n_rms})"
    );
    assert!(
        b_max < 0.35 * n_max,
        "Bilinear must cut the worst-point error: max {b_max} (nearest {n_max})"
    );
}

#[test]
fn world_scale_variant_holds() {
    // Doctrine R1: a world georef (large origin + real spacing) must not degrade
    // the fix — off-node conditioning happens in node-index space, so the large
    // coordinate magnitudes must not reintroduce the snap error.
    let lattice = Lattice::regular(ORIGIN_X, ORIGIN_Y, SPACING, SPACING, N, N);
    let ((n_rms, _), (b_rms, _)) = nearest_vs_bilinear("world-scale georef", &lattice);
    assert!(n_rms > 0.5, "world-scale snap defect present: {n_rms}");
    assert!(
        b_rms < 0.30 && b_rms < 0.35 * n_rms,
        "world-scale Bilinear must remove the snap error too: {b_rms} (nearest {n_rms})"
    );
}

// ---------------------------------------------------------------------------
// S2 — the preserved contracts: on-node bit-exactness, determinism, warm-start
// ---------------------------------------------------------------------------

/// On-node controls (integer node positions — exactly what petekStatic feeds)
/// are honoured bit-exactly in BOTH modes, and the Bilinear field is bit-for-bit
/// identical to NearestNode when every control is on a node.
#[test]
fn on_node_controls_are_bit_exact_in_both_modes() {
    let lattice = Lattice::regular(ORIGIN_X, ORIGIN_Y, SPACING, SPACING, N, N);
    // A spread of exact node controls (world coords of nodes).
    let node_ij = [
        (0, 0),
        (20, 0),
        (0, 20),
        (20, 20),
        (10, 10),
        (5, 15),
        (15, 5),
    ];
    let coords: Vec<[f64; 3]> = node_ij
        .iter()
        .map(|&(i, j)| {
            let (x, y) = lattice.node_xy(i, j);
            [x, y, truth(i as f64 * SPACING, j as f64 * SPACING)]
        })
        .collect();
    let nearest =
        grid_min_curvature_conditioned(&coords, &lattice, None, Conditioning::NearestNode).unwrap();
    let bilinear =
        grid_min_curvature_conditioned(&coords, &lattice, None, Conditioning::Bilinear).unwrap();

    // Each control node holds its value exactly, both modes.
    for (&(i, j), c) in node_ij.iter().zip(&coords) {
        assert!(
            (nearest[[i, j]] - c[2]).abs() < 1e-9,
            "NearestNode control ({i},{j}) not exact"
        );
        assert!(
            (bilinear[[i, j]] - c[2]).abs() < 1e-9,
            "Bilinear control ({i},{j}) not exact"
        );
    }
    // With only on-node controls, Bilinear is a no-op over NearestNode — bit-equal.
    assert_eq!(
        nearest, bilinear,
        "on-node-only inputs must make Bilinear bit-identical to NearestNode"
    );
}

/// The Bilinear solve is deterministic: two runs are bit-identical (no RNG, fixed
/// sweep + sample order).
#[test]
fn bilinear_is_deterministic() {
    let lattice = Lattice::regular(0.0, 0.0, SPACING, SPACING, N, N);
    let coords = coords_for(&lattice, &scatter_xy(MARGIN, EXTENT - MARGIN));
    let a =
        grid_min_curvature_conditioned(&coords, &lattice, None, Conditioning::Bilinear).unwrap();
    let b =
        grid_min_curvature_conditioned(&coords, &lattice, None, Conditioning::Bilinear).unwrap();
    assert_eq!(a, b, "Bilinear must be bit-deterministic");
}

/// Warm-start continuity: on a well-determined off-node fixture (scatter covering
/// the whole lattice, boundary included — no data void), seeding the Bilinear
/// solve from its own converged field reproduces it to the solver tolerance
/// (`warm == cold`). This is the guarantee petekStatic's regeneration seam needs.
#[test]
fn bilinear_warm_equals_cold_when_well_determined() {
    let lattice = Lattice::regular(0.0, 0.0, SPACING, SPACING, N, N);
    // Full-extent scatter (to the edges) → the near-Neumann void mode is pinned,
    // so a single solve converges everywhere (not just in a data hull).
    let coords = coords_for(&lattice, &scatter_xy(0.0, EXTENT));
    let cold =
        grid_min_curvature_conditioned(&coords, &lattice, None, Conditioning::Bilinear).unwrap();
    let warm =
        grid_min_curvature_conditioned(&coords, &lattice, Some(&cold), Conditioning::Bilinear)
            .unwrap();
    let mut moved = 0.0_f64;
    for (w, c) in warm.iter().zip(cold.iter()) {
        moved = moved.max((w - c).abs());
    }
    eprintln!("well-determined Bilinear warm-restart max move: {moved:.2e} m");
    assert!(
        moved < 1e-3,
        "warm must reproduce cold to tolerance, moved {moved}"
    );
}
