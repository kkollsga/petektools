//! Surface picks — a bilinear surface top at each well plus a drawn residual
//! (the mispick).

use crate::foundation::Lattice;
use crate::sampling::{seeded_rng, Sampler};
use ndarray::Array2;

/// Bilinear sample of `surface` (`ncol × nrow`, `field[col][row]`) on `lattice` at
/// world `(x, y)`. Returns `NaN` outside the node extent or if any bracketing node
/// is `NaN`.
fn sample_surface(surface: &Array2<f64>, lattice: &Lattice, x: f64, y: f64) -> f64 {
    let (ncol, nrow) = (lattice.ncol, lattice.nrow);
    let Some((fi, fj)) = lattice.xy_to_ij(x, y) else {
        return f64::NAN;
    };
    if fi < 0.0 || fj < 0.0 || fi > (ncol - 1) as f64 || fj > (nrow - 1) as f64 {
        return f64::NAN;
    }
    let i0 = fi.floor() as usize;
    let j0 = fj.floor() as usize;
    let i1 = (i0 + 1).min(ncol - 1);
    let j1 = (j0 + 1).min(nrow - 1);
    let tx = fi - i0 as f64;
    let ty = fj - j0 as f64;
    let (v00, v10, v01, v11) = (
        surface[[i0, j0]],
        surface[[i1, j0]],
        surface[[i0, j1]],
        surface[[i1, j1]],
    );
    if [v00, v10, v01, v11].iter().any(|v| v.is_nan()) {
        return f64::NAN;
    }
    let a = v00 * (1.0 - tx) + v10 * tx;
    let b = v01 * (1.0 - tx) + v11 * tx;
    a * (1.0 - ty) + b * ty
}

/// Pick a top from `surface` at each well in `well_xy`, adding one `residual` draw
/// per well (the mispick — e.g. `Sampler::new_uniform(-10.0, 10.0)` or a normal).
///
/// Returns one top per well (in order); a well outside the surface extent yields
/// `NaN`. The residual stream is seeded by `seed` (one draw per well, in order),
/// so the picks are bit-reproducible.
pub fn tops_from_surface(
    surface: &Array2<f64>,
    lattice: &Lattice,
    well_xy: &[[f64; 2]],
    residual: &Sampler,
    seed: u64,
) -> Vec<f64> {
    let mut rng = seeded_rng(seed);
    well_xy
        .iter()
        .map(|w| {
            let base = sample_surface(surface, lattice, w[0], w[1]);
            let r = residual.sample(&mut rng);
            base + r // NaN + r = NaN (out-of-extent stays NaN)
        })
        .collect()
}
