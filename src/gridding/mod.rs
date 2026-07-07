//! `gridding` — interpolate scattered `(x, y, z)` samples onto a regular
//! [`Lattice`], producing a dense `Array2<f64>` of node values (`NaN` where a
//! node is undefined).
//!
//! This is the GATE-0 contract surface. The [`grid`] dispatcher and
//! [`GridMethod`] are **locked**; the three kernels (`nearest`, `idw`,
//! `min_curvature`) are ported from petekio 0.2.0's proven Briggs/IDW/nearest
//! implementations, held at behaviour parity with their source.
//!
//! The built-in method set is a small closed `enum` ([`GridMethod`], mirroring
//! petekio's so delegation stays a 1:1 map). Where backends are plural — the
//! [`ordinary kriging`](kriging::OrdinaryKriging) family alongside the enum — the
//! [`Gridder`] trait is the shared interface (`GridMethod` implements it too).
//!
//! Alongside the scattered → grid kernels, [`resample`] is the **grid → grid**
//! counterpart: resample a native regular grid (values on a georeferencing
//! [`Lattice`]) onto a foreign target lattice, bilinear or nearest, null- and
//! extent-aware (axis-aligned; see the module docs for the null/extent policy).

mod band_lu;
mod convergent;
mod gridder;
mod idw;
pub mod kriging;
mod min_curvature;
mod mincurv_operator;
mod nearest;
mod resample;

pub use convergent::ConvergentGridder;
pub use gridder::Gridder;
pub use mincurv_operator::MinCurvatureOperator;
// `Conditioning` and `grid_min_curvature_conditioned` are defined in this module
// (below) and re-exported at the crate root via `lib.rs`.
pub use kriging::{
    AnisotropicVariogram, OrdinaryKriging, SpatialVariogram, Variogram, VariogramModel,
};
pub use resample::{resample, ResampleMethod};

use crate::foundation::{AlgoError, Lattice, Result};
use ndarray::Array2;

/// How the minimum-curvature solve honours a data sample that does **not** sit
/// on a lattice node.
///
/// A minimum-curvature surface is a *nodal* field; between nodes it is read by
/// bilinear interpolation. That makes the correct notion of "honour an off-node
/// datum" a constraint on the *interpolated* value — not a value to pin at any
/// single node — which is what [`Bilinear`](Self::Bilinear) enforces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Conditioning {
    /// Snap each sample to its nearest node and hold that node fixed (collisions
    /// average). Exact where data sit on nodes; an off-node sample carries a snap
    /// error up to the local gradient × its node-offset (metres on a dipping /
    /// curved flank). The historical behaviour and the default.
    #[default]
    NearestNode,
    /// Honour an off-node sample through the bilinear interpolation of its four
    /// surrounding nodes (`Σ wₖ·zₖ = z_data`), so the interpolated surface passes
    /// through the datum. A sample that lands on a node is still a hard anchor,
    /// bit-identical to [`NearestNode`](Self::NearestNode). Eliminates the
    /// nearest-node snap error at a small, documented residual (over-determined
    /// cells settle to the smooth least-misfit surface, ~the lattice floor).
    Bilinear,
}

/// Scattered-data → grid interpolation methods.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GridMethod {
    /// Value of the single areally-closest sample (blocky, exact at data).
    Nearest,
    /// Inverse-distance weighting (global, p = 2). Exact at coincident samples.
    InverseDistance,
    /// Briggs minimum-curvature (biharmonic) — smooth, honours the samples.
    MinimumCurvature,
}

/// Grid `coords` (`[x, y, z]` rows) onto `lattice` with `method`, returning the
/// `(ncol × nrow)` node-value array. Errors only on empty input; per-node
/// undefined values are `NaN`.
pub fn grid(coords: &[[f64; 3]], lattice: &Lattice, method: GridMethod) -> Result<Array2<f64>> {
    if coords.is_empty() {
        return Err(AlgoError::EmptyInput("grid: no points to grid"));
    }
    Ok(match method {
        GridMethod::Nearest => nearest::grid_nearest(coords, lattice),
        GridMethod::InverseDistance => idw::grid_idw(coords, lattice),
        GridMethod::MinimumCurvature => {
            min_curvature::grid_min_curvature(coords, lattice, None, Conditioning::NearestNode)
        }
    })
}

/// Warm-start minimum-curvature gridding: like [`grid`] with
/// [`GridMethod::MinimumCurvature`], but relax the SOR from `seed` (a
/// lattice-shaped prior field) instead of the cold IDW seed.
///
/// For an incremental re-grid (control points nudged, a point added) this
/// converges in far fewer iterations while reaching the same field — `warm ==
/// cold` to tolerance. A `None` or wrong-shape seed falls back to the cold
/// behaviour, so this is a non-breaking superset of `grid(.., MinimumCurvature)`.
/// The whole field is re-solved either way; the seed only sets the start point.
///
/// Errors only on empty input. Same seed/warm-start contract as petekio's seeded
/// `grid_min_curvature`; the underlying kernel uses the natural-dip boundary +
/// tension blend (module docs), so it converges to the family cold solver's field.
pub fn grid_min_curvature_seeded(
    coords: &[[f64; 3]],
    lattice: &Lattice,
    seed: Option<&Array2<f64>>,
) -> Result<Array2<f64>> {
    if coords.is_empty() {
        return Err(AlgoError::EmptyInput(
            "grid_min_curvature_seeded: no points to grid",
        ));
    }
    Ok(min_curvature::grid_min_curvature(
        coords,
        lattice,
        seed,
        Conditioning::NearestNode,
    ))
}

/// Minimum-curvature gridding with an explicit off-node [`Conditioning`] policy —
/// the additive superset of [`grid_min_curvature_seeded`].
///
/// With [`Conditioning::NearestNode`] this is bit-for-bit identical to
/// [`grid_min_curvature_seeded`] (samples snap to their nearest node). With
/// [`Conditioning::Bilinear`] an **off-node** sample is honoured through the
/// bilinear interpolation of its four surrounding nodes instead of being snapped,
/// so the interpolated surface passes through the datum — removing the metres-
/// level nearest-node snap error that dense sub-node scatter otherwise carries.
/// On-node samples remain hard anchors, honoured bit-exact in both modes.
///
/// `seed` is the same warm-start contract as [`grid_min_curvature_seeded`]: a
/// lattice-shaped prior field relaxes in far fewer iterations to the same fixed
/// point; `None` / wrong-shape falls back to the cold IDW seed. Deterministic
/// (fixed sweep + constraint order, no RNG).
///
/// For a consumer that works in node-index space (e.g. petekStatic's unit-spaced
/// solve lattice), pass each off-node control as `[x/xinc, y/yinc, z]` — i.e. its
/// fractional node position — with [`Conditioning::Bilinear`].
///
/// Errors only on empty input.
pub fn grid_min_curvature_conditioned(
    coords: &[[f64; 3]],
    lattice: &Lattice,
    seed: Option<&Array2<f64>>,
    conditioning: Conditioning,
) -> Result<Array2<f64>> {
    if coords.is_empty() {
        return Err(AlgoError::EmptyInput(
            "grid_min_curvature_conditioned: no points to grid",
        ));
    }
    Ok(min_curvature::grid_min_curvature(
        coords,
        lattice,
        seed,
        conditioning,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::foundation::Lattice;

    #[test]
    fn empty_input_errors() {
        let g = Lattice::regular(0.0, 0.0, 1.0, 1.0, 4, 4);
        assert!(matches!(
            grid(&[], &g, GridMethod::Nearest),
            Err(AlgoError::EmptyInput(_))
        ));
    }

    #[test]
    fn seeded_empty_input_errors() {
        let g = Lattice::regular(0.0, 0.0, 1.0, 1.0, 4, 4);
        assert!(matches!(
            grid_min_curvature_seeded(&[], &g, None),
            Err(AlgoError::EmptyInput(_))
        ));
    }

    #[test]
    fn seeded_none_equals_cold_grid() {
        // grid_min_curvature_seeded(.., None) must equal grid(.., MinimumCurvature):
        // the seeded entry is a non-breaking superset of the cold dispatch.
        let g = Lattice::regular(0.0, 0.0, 1.0, 1.0, 8, 7);
        let coords = [[1.0, 1.0, 3.0], [6.0, 5.0, 12.0], [3.0, 4.0, 7.0]];
        let cold = grid(&coords, &g, GridMethod::MinimumCurvature).unwrap();
        let seeded_none = grid_min_curvature_seeded(&coords, &g, None).unwrap();
        assert_eq!(cold, seeded_none);
        // Warm-start from the converged cold field reproduces it to the solver
        // tolerance (the cold solve reaches max_delta < TOL absolute, so the warm
        // re-solve stops in ~1 sweep; 1e-3 is well above that).
        let warm = grid_min_curvature_seeded(&coords, &g, Some(&cold)).unwrap();
        let maxd = warm
            .iter()
            .zip(cold.iter())
            .map(|(w, c)| (w - c).abs())
            .fold(0.0_f64, f64::max);
        assert!(maxd < 1e-3, "warm vs cold max diff = {maxd}");
    }
}
