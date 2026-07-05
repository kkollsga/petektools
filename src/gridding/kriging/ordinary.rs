//! Ordinary kriging — the best linear unbiased estimator under an unknown but
//! constant local mean, using a [`Variogram`] for spatial continuity.
//!
//! For a target location `x₀` the estimate is a weighted sum of the data
//! `Z*(x₀) = Σ λᵢ Z(xᵢ)` under the unbiasedness constraint `Σ λᵢ = 1`. The
//! weights solve the ordinary-kriging system (with a Lagrange multiplier `μ`
//! enforcing the constraint), written here in the semivariogram form:
//!
//! ```text
//! ┌               ┐ ┌   ┐   ┌        ┐
//! │  Γ         1  │ │ λ │   │  γ₀    │        Γ_ij = γ(|xᵢ − xⱼ|)   (Γ_ii = 0)
//! │  1ᵀ        0  │ │ μ │ = │  1     │        γ₀_i = γ(|xᵢ − x₀|)
//! └               ┘ └   ┘   └        ┘
//! ```
//!
//! and the ordinary-kriging variance is `σ²(x₀) = Σ λᵢ γ₀ᵢ + μ`.
//!
//! Implemented from:
//! - Matheron, G. (1963), "Principles of geostatistics", *Economic Geology* 58.
//! - Journel, A.G. & Huijbregts, C.J. (1978), *Mining Geostatistics*, ch. V.
//! - Isaaks, E.H. & Srivastava, R.M. (1989), *An Introduction to Applied
//!   Geostatistics*, ch. 12 (ordinary kriging).
//! - Cressie, N. (1993), *Statistics for Spatial Data*, §3.2.
//!
//! **Scope.** This is a *global-neighbourhood* solver: every datum enters the
//! system, so the coefficient matrix is factored once and back-substituted per
//! node. That is exact and well-suited to the moderate scattered sets this crate
//! grids; a moving local-search neighbourhood is a future optimisation.
//!
//! **Exactness.** With no nugget, ordinary kriging is an *exact interpolator*:
//! at a datum location the estimate reproduces that datum and the kriging
//! variance is zero. A nugget introduces the usual discontinuity at the data, so
//! exactness holds for the nugget-free case (Isaaks & Srivastava 1989, §12).

use crate::foundation::{AlgoError, Lattice, Result};
use ndarray::Array2;

use super::prep::{dedup_coincident, dist2d};
use super::solve::LuFactorization;
use super::variogram::Variogram;
use crate::gridding::Gridder;

/// An ordinary-kriging gridder parameterised by a [`Variogram`].
///
/// Implements [`Gridder`], so it plugs into the same interface as the built-in
/// [`GridMethod`](crate::GridMethod) backends. Use [`grid`](Gridder::grid) for
/// the estimate field alone, or [`krige`](Self::krige) to also get the
/// per-node ordinary-kriging variance.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OrdinaryKriging {
    variogram: Variogram,
}

impl OrdinaryKriging {
    /// Build an ordinary-kriging gridder from a variogram model.
    pub fn new(variogram: Variogram) -> OrdinaryKriging {
        OrdinaryKriging { variogram }
    }

    /// The variogram this gridder kriges with.
    pub fn variogram(&self) -> &Variogram {
        &self.variogram
    }

    /// Krige `coords` (`[x, y, z]` rows) onto `lattice`, returning both the
    /// `(ncol × nrow)` estimate field **and** the matching ordinary-kriging
    /// variance field.
    ///
    /// Coincident data (identical `(x, y)`) are averaged before the solve — two
    /// data at one location make the system singular, so they are merged, their
    /// `z` averaged. Errors on empty input; errors with
    /// [`AlgoError::InvalidGeometry`] if the kriging system is singular (which a
    /// valid [`Variogram`] over distinct points does not produce).
    pub fn krige(
        &self,
        coords: &[[f64; 3]],
        lattice: &Lattice,
    ) -> Result<(Array2<f64>, Array2<f64>)> {
        if coords.is_empty() {
            return Err(AlgoError::EmptyInput("krige: no points to grid"));
        }
        let data = dedup_coincident(coords);
        let n = data.len();

        // Build the (n+1)×(n+1) ordinary-kriging matrix, shared by every node.
        // Layout row-major; index n is the Lagrange row/column.
        let m = n + 1;
        let mut a = vec![0.0_f64; m * m];
        for i in 0..n {
            for j in 0..n {
                a[i * m + j] = self
                    .variogram
                    .gamma(dist2d([data[i][0], data[i][1]], [data[j][0], data[j][1]]));
            }
            a[i * m + n] = 1.0; // constraint column
            a[n * m + i] = 1.0; // constraint row
        }
        a[n * m + n] = 0.0;

        let lu = LuFactorization::factor(a, m).ok_or(AlgoError::InvalidGeometry(
            "kriging: system is singular (check the variogram and for duplicate points)",
        ))?;

        let mut est = Array2::from_elem((lattice.ncol, lattice.nrow), f64::NAN);
        let mut var = Array2::from_elem((lattice.ncol, lattice.nrow), f64::NAN);
        let mut rhs = vec![0.0_f64; m];
        rhs[n] = 1.0;
        // One retained solution buffer across the per-node back-substitutions —
        // `solve_into` runs the identical arithmetic to the allocating `solve`
        // (both delegate to the same in-place kernel), no per-node allocation.
        let mut sol: Vec<f64> = Vec::with_capacity(m);

        for jj in 0..lattice.nrow {
            for ii in 0..lattice.ncol {
                let (x, y) = lattice.node_xy(ii, jj);
                for (k, d) in data.iter().enumerate() {
                    rhs[k] = self.variogram.gamma(dist2d([d[0], d[1]], [x, y]));
                }
                lu.solve_into(&rhs, &mut sol); // sol[0..n] = weights, sol[n] = μ

                let mut z = 0.0;
                let mut sigma2 = sol[n]; // μ
                for (k, d) in data.iter().enumerate() {
                    z += sol[k] * d[2];
                    sigma2 += sol[k] * rhs[k]; // Σ λᵢ γ₀ᵢ
                }
                est[[ii, jj]] = z;
                // Guard against a tiny negative from round-off.
                var[[ii, jj]] = sigma2.max(0.0);
            }
        }
        Ok((est, var))
    }
}

impl Gridder for OrdinaryKriging {
    /// Ordinary-kriging estimate field (the variance is discarded; use
    /// [`krige`](OrdinaryKriging::krige) to keep it).
    fn grid(&self, coords: &[[f64; 3]], lattice: &Lattice) -> Result<Array2<f64>> {
        self.krige(coords, lattice).map(|(est, _var)| est)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gridding::kriging::VariogramModel;
    use approx::assert_relative_eq;

    fn spherical(nugget: f64) -> Variogram {
        Variogram::new(VariogramModel::Spherical, nugget, 1.0, 10.0).unwrap()
    }

    #[test]
    fn empty_input_errors() {
        let ok = OrdinaryKriging::new(spherical(0.0));
        let g = Lattice::regular(0.0, 0.0, 1.0, 1.0, 4, 4);
        assert!(matches!(ok.grid(&[], &g), Err(AlgoError::EmptyInput(_))));
    }

    #[test]
    fn exact_at_data_points_with_no_nugget() {
        // Data placed on lattice nodes; a nugget-free variogram makes kriging an
        // exact interpolator, and the kriging variance is zero at the data.
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 6, 6);
        let coords = [
            [0.0, 0.0, 10.0],
            [5.0, 0.0, 22.0],
            [0.0, 5.0, 7.0],
            [5.0, 5.0, 40.0],
            [2.0, 3.0, 18.0],
        ];
        let ok = OrdinaryKriging::new(spherical(0.0));
        let (est, var) = ok.krige(&coords, &lattice).unwrap();
        for c in &coords {
            let (fi, fj) = lattice.xy_to_ij(c[0], c[1]).unwrap();
            let (i, j) = (fi.round() as usize, fj.round() as usize);
            assert_relative_eq!(est[[i, j]], c[2], epsilon = 1e-7);
            assert!(var[[i, j]].abs() < 1e-7, "variance {} not ~0", var[[i, j]]);
        }
    }

    #[test]
    fn constant_data_reproduced_everywhere() {
        // Σλ = 1 ⇒ constant data give the constant back at every node.
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 7, 5);
        let coords = [
            [0.0, 0.0, 12.5],
            [6.0, 0.0, 12.5],
            [3.0, 4.0, 12.5],
            [6.0, 4.0, 12.5],
        ];
        let ok = OrdinaryKriging::new(spherical(0.5));
        let est = ok.grid(&coords, &lattice).unwrap();
        for v in est.iter() {
            assert_relative_eq!(*v, 12.5, epsilon = 1e-9);
        }
    }

    #[test]
    fn symmetric_midpoint_averages_two_points() {
        // Known configuration: two equal-variogram data, target exactly midway
        // ⇒ weights 0.5/0.5 ⇒ estimate = mean. (Isaaks & Srivastava, symmetry.)
        let lattice = Lattice::regular(1.0, 0.0, 1.0, 1.0, 1, 1); // single node at (1,0)
        let coords = [[0.0, 0.0, 10.0], [2.0, 0.0, 20.0]];
        let ok = OrdinaryKriging::new(spherical(0.0));
        let est = ok.grid(&coords, &lattice).unwrap();
        assert_relative_eq!(est[[0, 0]], 15.0, epsilon = 1e-9);
    }

    #[test]
    fn symmetric_centre_of_square_averages_four_points() {
        // Target equidistant from four corners of a square ⇒ weights 0.25 each
        // ⇒ estimate = mean of the four data.
        let lattice = Lattice::regular(1.0, 1.0, 1.0, 1.0, 1, 1); // node at (1,1)
        let coords = [
            [0.0, 0.0, 4.0],
            [2.0, 0.0, 8.0],
            [0.0, 2.0, 12.0],
            [2.0, 2.0, 16.0],
        ];
        let ok = OrdinaryKriging::new(spherical(0.0));
        let est = ok.grid(&coords, &lattice).unwrap();
        assert_relative_eq!(est[[0, 0]], 10.0, epsilon = 1e-9);
    }

    #[test]
    fn estimate_is_bounded_by_the_data_range() {
        // Away from screening effects, an OK estimate should stay within the
        // data's [min, max] on a smooth configuration.
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 11, 11);
        let coords = [
            [0.0, 0.0, 5.0],
            [10.0, 0.0, 25.0],
            [0.0, 10.0, 15.0],
            [10.0, 10.0, 35.0],
            [5.0, 5.0, 20.0],
        ];
        let (lo, hi) = (5.0, 35.0);
        let ok = OrdinaryKriging::new(spherical(0.0));
        let est = ok.grid(&coords, &lattice).unwrap();
        for v in est.iter() {
            assert!(*v >= lo - 1e-6 && *v <= hi + 1e-6, "out of range: {v}");
        }
    }

    #[test]
    fn duplicate_points_are_averaged_not_singular() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 4, 4);
        // Two coincident points at (1,1): 10 and 20 -> averaged to 15.
        let coords = [
            [0.0, 0.0, 0.0],
            [1.0, 1.0, 10.0],
            [1.0, 1.0, 20.0],
            [3.0, 3.0, 30.0],
        ];
        let ok = OrdinaryKriging::new(spherical(0.0));
        let (est, _var) = ok.krige(&coords, &lattice).unwrap();
        assert_relative_eq!(est[[1, 1]], 15.0, epsilon = 1e-7);
    }

    #[test]
    fn variance_grows_away_from_data() {
        // The kriging variance is ~0 at a datum and larger far from all data.
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 21, 21);
        let coords = [[0.0, 0.0, 10.0], [20.0, 20.0, 30.0]];
        let ok = OrdinaryKriging::new(spherical(0.0));
        let (_est, var) = ok.krige(&coords, &lattice).unwrap();
        let near = var[[0, 0]]; // on a datum
        let far = var[[10, 10]]; // centre, far from both
        assert!(near < far, "near {near} should be < far {far}");
    }
}
