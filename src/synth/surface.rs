//! **2-D structural recipes** — the reusable build-down surfaces: a four-way-dip
//! dome, a non-negative isochore, and a depositional trend map. All correlated
//! roughness comes from [`sgs_unconditional`], so a single seed reproduces the
//! whole structural picture.
//!
//! - [`synth_dome_surface`] — an analytic elliptical **dome** (a four-way closure:
//!   a crest that dips away in every direction) plus a regional **tilt** plane plus
//!   **correlated noise**. The believable trap.
//! - [`synth_isochore`] — a correlated **thickness** field about a mean, clamped at
//!   zero (a thickness cannot be negative).
//! - [`synth_trend_map`] — a correlated field mapped to `[0, 1]` (a net-sand-style
//!   depositional trend), optionally **correlated at a known `ρ`** with a supplied
//!   field so collocated-cokriging tests have a real relationship to recover.
//!
//! Derived from the sequential-Gaussian and normal-score maths in the sibling
//! modules; no third-party code was consulted.

use crate::foundation::{AlgoError, Lattice, Result};
use crate::geostat::{sgs_unconditional, NormalScore};
use crate::gridding::kriging::Variogram;
use ndarray::Array2;
use statrs::distribution::{ContinuousCDF, Normal as StatrsNormal};

/// Correlated-roughness specification for a synthetic surface: an amplitude
/// (`variance`) and a continuity model (`variogram`, shape + range). Consumed by
/// [`synth_dome_surface`] via [`sgs_unconditional`].
#[derive(Debug, Clone)]
pub struct NoiseSpec {
    /// Variance (amplitude²) of the correlated noise (`≥ 0`; `0` ⇒ no noise).
    pub variance: f64,
    /// Spatial-continuity model for the noise (its shape + range; the sill is
    /// irrelevant — amplitude is set by `variance`).
    pub variogram: Variogram,
}

impl NoiseSpec {
    /// Build and validate a noise spec. Errors unless `variance ≥ 0` (finite).
    pub fn new(variance: f64, variogram: Variogram) -> Result<NoiseSpec> {
        if !(variance.is_finite() && variance >= 0.0) {
            return Err(AlgoError::InvalidArgument(
                "NoiseSpec: variance must be finite and >= 0".to_string(),
            ));
        }
        Ok(NoiseSpec {
            variance,
            variogram,
        })
    }
}

/// Sensible moving-neighbourhood parameters for an unconditional field on
/// `lattice` with `variogram`: a radius covering ~1.5 ranges (but at least a few
/// cells) and a modest neighbour cap.
fn search_params(lattice: &Lattice, variogram: &Variogram) -> (usize, f64) {
    let cell = lattice
        .xinc
        .abs()
        .max(lattice.yinc.abs())
        .max(f64::MIN_POSITIVE);
    let radius = (variogram.range * 1.5).max(cell * 4.0);
    (24, radius)
}

/// Generate a synthetic **dome** structure on `lattice`: an elliptical four-way
/// closure of amplitude `relief`, elongation `aspect` (`> 1` stretches the crest
/// along x, `< 1` along y), a regional `tilt` (total elevation change across the
/// x-extent), and correlated `noise`.
///
/// Returns a structural-relief field (`ncol × nrow`) with the crest as the
/// **maximum** — add your own datum, or negate, for a depth convention. The dome
/// bell is centred on the lattice and decays outward so its contours close inside
/// the extent (the four-way dip closure). Errors on non-finite `relief` / `tilt`
/// or `aspect ≤ 0`. Bit-reproducible per `seed`.
pub fn synth_dome_surface(
    lattice: &Lattice,
    relief: f64,
    aspect: f64,
    tilt: f64,
    noise: &NoiseSpec,
    seed: u64,
) -> Result<Array2<f64>> {
    if !relief.is_finite() || !tilt.is_finite() {
        return Err(AlgoError::InvalidArgument(
            "synth_dome_surface: relief and tilt must be finite".to_string(),
        ));
    }
    if !(aspect.is_finite() && aspect > 0.0) {
        return Err(AlgoError::InvalidArgument(
            "synth_dome_surface: aspect must be finite and > 0".to_string(),
        ));
    }
    let (ncol, nrow) = (lattice.ncol, lattice.nrow);
    let bb = lattice.bbox();
    let (cx, cy) = (0.5 * (bb.xmin + bb.xmax), 0.5 * (bb.ymin + bb.ymax));
    let hx = 0.5 * (bb.xmax - bb.xmin);
    let hy = 0.5 * (bb.ymax - bb.ymin);
    // Half-extent = 2σ so the flanks fall to ~13% of relief at the edge; aspect
    // stretches one axis and squeezes the other.
    let sx = (hx / 2.0 * aspect.sqrt()).max(f64::MIN_POSITIVE);
    let sy = (hy / 2.0 / aspect.sqrt()).max(f64::MIN_POSITIVE);
    let xspan = (bb.xmax - bb.xmin).max(f64::MIN_POSITIVE);

    // Optional correlated noise.
    let noise_field = if noise.variance > 0.0 {
        let (mn, r) = search_params(lattice, &noise.variogram);
        Some(sgs_unconditional(
            lattice,
            0.0,
            noise.variance,
            &noise.variogram,
            mn,
            r,
            seed,
        )?)
    } else {
        None
    };

    let mut out = Array2::from_elem((ncol, nrow), 0.0);
    for i in 0..ncol {
        for j in 0..nrow {
            let (x, y) = lattice.node_xy(i, j);
            let dx = (x - cx) / sx;
            let dy = (y - cy) / sy;
            let dome = relief * (-0.5 * (dx * dx + dy * dy)).exp();
            let plane = tilt * ((x - bb.xmin) / xspan - 0.5);
            let eps = noise_field.as_ref().map(|f| f[[i, j]]).unwrap_or(0.0);
            out[[i, j]] = dome + plane + eps;
        }
    }
    Ok(out)
}

/// Generate a synthetic **isochore** (thickness map) on `lattice`: a correlated
/// field about `mean_thickness` with standard deviation `variability` and
/// continuity `variogram`, **clamped at zero** (a thickness is non-negative).
///
/// Errors unless `mean_thickness` is finite and `variability ≥ 0` (finite).
/// `variability = 0` yields the constant `mean_thickness`. The clamp puts a small
/// mass at zero wherever the Gaussian dips negative — negligible when
/// `mean_thickness ≫ variability`, documented otherwise. Bit-reproducible per
/// `seed`.
pub fn synth_isochore(
    lattice: &Lattice,
    mean_thickness: f64,
    variability: f64,
    variogram: &Variogram,
    seed: u64,
) -> Result<Array2<f64>> {
    if !mean_thickness.is_finite() {
        return Err(AlgoError::InvalidArgument(
            "synth_isochore: mean_thickness must be finite".to_string(),
        ));
    }
    if !(variability.is_finite() && variability >= 0.0) {
        return Err(AlgoError::InvalidArgument(
            "synth_isochore: variability must be finite and >= 0".to_string(),
        ));
    }
    let (mn, r) = search_params(lattice, variogram);
    let field = sgs_unconditional(
        lattice,
        mean_thickness,
        variability * variability,
        variogram,
        mn,
        r,
        seed,
    )?;
    Ok(field.mapv(|v| v.max(0.0)))
}

/// Generate a **depositional trend map** on `lattice`: a spatially-correlated
/// field mapped to `[0, 1]` (a net-sand-style relative trend, `Uniform(0,1)`
/// marginal via the standard-normal CDF).
///
/// With `correlate_with = Some((field, ρ))` the trend is built to correlate with
/// `field` at (approximately) `ρ` — the standard correlation construction
/// `G = ρ·Y + √(1−ρ²)·Y⊥`, where `Y` is the normal-score transform of `field` and
/// `Y⊥` is an independent correlated Gaussian field — so a collocated-cokriging
/// test has a real relationship to recover at a known strength. Without it, the
/// trend is an independent correlated field. `ρ` must be in `[−1, 1]` and `field`
/// must match the lattice shape. Errors otherwise. Bit-reproducible per `seed`.
pub fn synth_trend_map(
    lattice: &Lattice,
    variogram: &Variogram,
    seed: u64,
    correlate_with: Option<(&Array2<f64>, f64)>,
) -> Result<Array2<f64>> {
    let (ncol, nrow) = (lattice.ncol, lattice.nrow);
    let (mn, r) = search_params(lattice, variogram);

    // The base correlated Gaussian field, marginally ~ N(0,1).
    let g = sgs_unconditional(lattice, 0.0, 1.0, variogram, mn, r, seed)?;

    let gaussian = match correlate_with {
        None => g,
        Some((field, rho)) => {
            if !(rho.is_finite()) || !(-1.0..=1.0).contains(&rho) {
                return Err(AlgoError::InvalidArgument(
                    "synth_trend_map: rho must be in [-1, 1]".to_string(),
                ));
            }
            if field.dim() != (ncol, nrow) {
                return Err(AlgoError::InvalidArgument(
                    "synth_trend_map: correlate_with field shape must match the lattice"
                        .to_string(),
                ));
            }
            // Normal-score the conditioning field, then mix: rho·Y + sqrt(1-rho²)·G.
            let vals: Vec<f64> = field.iter().cloned().filter(|v| v.is_finite()).collect();
            let ns = NormalScore::fit(&vals)?;
            let w = (1.0 - rho * rho).max(0.0).sqrt();
            Array2::from_shape_fn((ncol, nrow), |(i, j)| {
                let y = if field[[i, j]].is_finite() {
                    ns.forward(field[[i, j]])
                } else {
                    0.0
                };
                rho * y + w * g[[i, j]]
            })
        }
    };

    // Map the Gaussian to [0,1] via the standard-normal CDF (Uniform marginal).
    let snorm = StatrsNormal::new(0.0, 1.0).expect("standard normal");
    Ok(gaussian.mapv(|z| snorm.cdf(z)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gridding::kriging::VariogramModel;
    use crate::stats::mean;

    fn vg(range: f64) -> Variogram {
        Variogram::new(VariogramModel::Spherical, 0.0, 1.0, range).unwrap()
    }

    #[test]
    fn dome_has_interior_crest() {
        let lat = Lattice::regular(0.0, 0.0, 10.0, 10.0, 40, 40);
        let noise = NoiseSpec::new(0.0, vg(100.0)).unwrap();
        let s = synth_dome_surface(&lat, 100.0, 1.0, 0.0, &noise, 1).unwrap();
        // The maximum should sit near the centre, not on the boundary.
        let mut best = (0usize, 0usize, f64::NEG_INFINITY);
        for i in 0..40 {
            for j in 0..40 {
                if s[[i, j]] > best.2 {
                    best = (i, j, s[[i, j]]);
                }
            }
        }
        assert!(
            best.0 > 5 && best.0 < 34 && best.1 > 5 && best.1 < 34,
            "crest at boundary: {best:?}"
        );
        // Crest near `relief`, flanks well below.
        assert!(best.2 > 80.0, "crest {} below relief", best.2);
        assert!(s[[0, 0]] < 30.0, "corner {} not a flank", s[[0, 0]]);
    }

    #[test]
    fn dome_aspect_elongates() {
        let lat = Lattice::regular(0.0, 0.0, 10.0, 10.0, 41, 41);
        let noise = NoiseSpec::new(0.0, vg(100.0)).unwrap();
        // aspect > 1 stretches along x: the mid-row profile stays higher out to
        // larger |x| than the mid-column profile does at the same |y|.
        let s = synth_dome_surface(&lat, 100.0, 3.0, 0.0, &noise, 1).unwrap();
        let mid = 20;
        // value a few cells off-crest along x vs along y.
        let along_x = s[[mid + 8, mid]];
        let along_y = s[[mid, mid + 8]];
        assert!(
            along_x > along_y,
            "x-elongation not visible: {along_x} vs {along_y}"
        );
    }

    #[test]
    fn dome_bit_reproducible_with_noise() {
        let lat = Lattice::regular(0.0, 0.0, 10.0, 10.0, 30, 30);
        let noise = NoiseSpec::new(25.0, vg(120.0)).unwrap();
        let a = synth_dome_surface(&lat, 80.0, 1.5, 40.0, &noise, 7).unwrap();
        let b = synth_dome_surface(&lat, 80.0, 1.5, 40.0, &noise, 7).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn isochore_is_nonnegative_and_on_mean() {
        let lat = Lattice::regular(0.0, 0.0, 10.0, 10.0, 40, 40);
        let f = synth_isochore(&lat, 20.0, 5.0, &vg(120.0), 3).unwrap();
        assert!(f.iter().all(|&v| v >= 0.0), "negative thickness");
        let flat: Vec<f64> = f.iter().cloned().collect();
        assert!((mean(&flat).unwrap() - 20.0).abs() < 4.0, "mean off");
    }

    #[test]
    fn isochore_zero_variability_is_constant() {
        let lat = Lattice::regular(0.0, 0.0, 10.0, 10.0, 10, 10);
        let f = synth_isochore(&lat, 12.0, 0.0, &vg(50.0), 1).unwrap();
        assert!(f.iter().all(|&v| v == 12.0));
    }

    #[test]
    fn trend_map_is_in_unit_interval() {
        let lat = Lattice::regular(0.0, 0.0, 10.0, 10.0, 30, 30);
        let t = synth_trend_map(&lat, &vg(120.0), 5, None).unwrap();
        assert!(t.iter().all(|&v| (0.0..=1.0).contains(&v)));
    }

    #[test]
    fn trend_map_recovers_target_correlation() {
        // Build a base field, then a trend correlated at a known rho; the realized
        // correlation between their normal scores should be close to rho.
        let lat = Lattice::regular(0.0, 0.0, 10.0, 10.0, 50, 50);
        let base = sgs_unconditional(&lat, 0.5, 0.02, &vg(150.0), 24, 200.0, 11).unwrap();
        for &rho in &[0.0_f64, 0.5, 0.8] {
            let trend = synth_trend_map(&lat, &vg(150.0), 22, Some((&base, rho))).unwrap();
            // Pearson between normal scores of trend and base ≈ rho.
            let bvals: Vec<f64> = base.iter().cloned().collect();
            let nb = NormalScore::fit(&bvals).unwrap();
            let tvals: Vec<f64> = trend.iter().cloned().collect();
            let nt = NormalScore::fit(&tvals).unwrap();
            let ys: Vec<f64> = base.iter().map(|&v| nb.forward(v)).collect();
            let xs: Vec<f64> = trend.iter().map(|&v| nt.forward(v)).collect();
            let r = pearson(&xs, &ys);
            assert!((r - rho).abs() < 0.12, "realized corr {r} vs target {rho}");
        }
    }

    fn pearson(a: &[f64], b: &[f64]) -> f64 {
        let n = a.len() as f64;
        let ma = a.iter().sum::<f64>() / n;
        let mb = b.iter().sum::<f64>() / n;
        let mut cov = 0.0;
        let mut va = 0.0;
        let mut vb = 0.0;
        for i in 0..a.len() {
            cov += (a[i] - ma) * (b[i] - mb);
            va += (a[i] - ma).powi(2);
            vb += (b[i] - mb).powi(2);
        }
        cov / (va.sqrt() * vb.sqrt())
    }
}
