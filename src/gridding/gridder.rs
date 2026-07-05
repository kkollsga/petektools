//! The [`Gridder`] trait — one interface over the scattered-data → grid backends.
//!
//! The built-in [`GridMethod`] set (nearest / IDW / minimum-curvature) and the
//! new [`OrdinaryKriging`](crate::OrdinaryKriging) backend all produce a dense
//! `(ncol × nrow)` field from the same `(coords, lattice)` inputs, so they share
//! this trait — letting a caller hold a `Box<dyn Gridder>` and swap methods
//! (including kriging) behind one call.
//!
//! This unifies the **stateless, cold-grid** entry points. The two warm-start
//! entry points are deliberately *not* `Gridder`s, because they are not pure
//! `(coords, lattice) → field` functions:
//! - [`grid_min_curvature_seeded`](crate::grid_min_curvature_seeded) takes an
//!   extra seed field (a warm start), and
//! - [`ConvergentGridder`](crate::ConvergentGridder) is *stateful* — it holds a
//!   solved field and an accumulating control set, exposed through its own
//!   `add_control` / `field` surface.
//!
//! Both remain the fast incremental path over the same minimum-curvature kernel
//! that `GridMethod::MinimumCurvature` reaches through this trait.

use crate::foundation::{Lattice, Result};
use ndarray::Array2;

/// A scattered-data gridding backend: interpolate `[x, y, z]` rows onto
/// `lattice`, returning the `(ncol × nrow)` node array (`NaN` where undefined).
///
/// Implemented by [`GridMethod`](crate::GridMethod) (the built-in enum) and by
/// [`OrdinaryKriging`](crate::OrdinaryKriging). Errors follow the built-ins:
/// empty input errors; per-node undefined values are `NaN`.
pub trait Gridder {
    /// Grid `coords` onto `lattice`, producing the node-value field.
    fn grid(&self, coords: &[[f64; 3]], lattice: &Lattice) -> Result<Array2<f64>>;
}

impl Gridder for super::GridMethod {
    /// Dispatch to the free [`grid`](super::grid) function — so
    /// `method.grid(coords, lattice)` equals `grid(coords, lattice, method)`.
    fn grid(&self, coords: &[[f64; 3]], lattice: &Lattice) -> Result<Array2<f64>> {
        super::grid(coords, lattice, *self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gridding::GridMethod;

    #[test]
    fn gridmethod_trait_matches_free_function() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 5, 5);
        let coords = [[0.0, 0.0, 1.0], [4.0, 4.0, 9.0], [2.0, 2.0, 5.0]];
        for method in [
            GridMethod::Nearest,
            GridMethod::InverseDistance,
            GridMethod::MinimumCurvature,
        ] {
            let via_trait = Gridder::grid(&method, &coords, &lattice).unwrap();
            let via_free = crate::gridding::grid(&coords, &lattice, method).unwrap();
            assert_eq!(via_trait, via_free, "{method:?}");
        }
    }

    #[test]
    fn usable_as_trait_object() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 4, 4);
        let coords = [[0.0, 0.0, 1.0], [3.0, 3.0, 4.0]];
        let g: Box<dyn Gridder> = Box::new(GridMethod::InverseDistance);
        let out = g.grid(&coords, &lattice).unwrap();
        assert_eq!(out.dim(), (4, 4));
    }
}
