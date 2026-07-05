//! Inverse-distance-weighting gridding (global, p = 2; exact at coincident
//! samples).
//!
//! Ported from petekio 0.2.0 `src/core/gridding.rs` (`grid_idw` / `idw_at`, the
//! author's own prior art) with the `GridGeometry` parameter swapped 1:1 for
//! [`Lattice`]. The IDW power (`p = 2`) is the locked default, kept as a named
//! constant.

use crate::foundation::Lattice;
use ndarray::Array2;

/// IDW power exponent (`wᵢ = 1/dᵢ^p`); p = 2 is the locked default.
const IDW_POWER: f64 = 2.0;

/// `(ncol × nrow)` node values by inverse-distance weighting of all samples.
pub(crate) fn grid_idw(coords: &[[f64; 3]], lattice: &Lattice) -> Array2<f64> {
    let mut out = Array2::from_elem((lattice.ncol, lattice.nrow), f64::NAN);
    for j in 0..lattice.nrow {
        for i in 0..lattice.ncol {
            let (x, y) = lattice.node_xy(i, j);
            out[[i, j]] = idw_at(coords, x, y);
        }
    }
    out
}

/// IDW value at a single point. Exact (returns the sample's Z) at a coincident
/// sample; `NaN` only if there are no samples.
fn idw_at(coords: &[[f64; 3]], x: f64, y: f64) -> f64 {
    let mut wsum = 0.0;
    let mut vsum = 0.0;
    for c in coords {
        let d2 = (c[0] - x).powi(2) + (c[1] - y).powi(2);
        if d2 == 0.0 {
            return c[2]; // exact hit
        }
        let w = 1.0 / d2.powf(IDW_POWER / 2.0);
        wsum += w;
        vsum += w * c[2];
    }
    if wsum > 0.0 {
        vsum / wsum
    } else {
        f64::NAN
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_at_coincident_sample() {
        // Nodes sit exactly on samples; each node must return that sample's Z
        // exactly (no blending), even with other samples present.
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 2, 2);
        let coords = [
            [0.0, 0.0, 10.0],
            [1.0, 0.0, 20.0],
            [0.0, 1.0, 30.0],
            [1.0, 1.0, 40.0],
        ];
        let out = grid_idw(&coords, &lattice);
        assert_eq!(out[[0, 0]], 10.0);
        assert_eq!(out[[1, 0]], 20.0);
        assert_eq!(out[[0, 1]], 30.0);
        assert_eq!(out[[1, 1]], 40.0);
    }

    #[test]
    fn interpolated_value_bounded_by_samples() {
        // A node between two samples must lie strictly between their Z's
        // (IDW is a convex combination of sample values).
        let lattice = Lattice::regular(0.5, 0.0, 1.0, 1.0, 1, 1); // single node at (0.5, 0)
        let coords = [[0.0, 0.0, 0.0], [1.0, 0.0, 100.0]];
        let v = grid_idw(&coords, &lattice)[[0, 0]];
        assert!(v > 0.0 && v < 100.0, "v = {v}");
        // Equidistant → exact midpoint average.
        assert!((v - 50.0).abs() < 1e-9, "v = {v}");
    }

    #[test]
    fn symmetric_layout_averages() {
        // Node equidistant from four corner samples → mean of the four Z's.
        let lattice = Lattice::regular(0.5, 0.5, 1.0, 1.0, 1, 1);
        let coords = [
            [0.0, 0.0, 10.0],
            [1.0, 0.0, 20.0],
            [0.0, 1.0, 30.0],
            [1.0, 1.0, 40.0],
        ];
        let v = grid_idw(&coords, &lattice)[[0, 0]];
        assert!((v - 25.0).abs() < 1e-9, "v = {v}");
    }
}
