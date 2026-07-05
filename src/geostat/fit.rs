//! Fit a [`Variogram`] model to an [`ExperimentalVariogram`] by **pair-count
//! weighted least squares**.
//!
//! ## Objective
//!
//! For a chosen [`VariogramModel`] shape, fit the nugget `c₀`, partial sill `c`
//! and range `a` that minimise the pair-count-weighted sum of squared residuals
//! against the experimental points `(hₖ, γ̂ₖ, Nₖ)`:
//!
//! ```text
//! minimise  Σₖ Nₖ · ( γ_model(hₖ; c₀, c, a) − γ̂ₖ )²
//! ```
//!
//! Weighting by the pair count `Nₖ` (the number of pairs behind each lag class)
//! is the standard, cheap WLS choice: well-populated near-lags — which anchor the
//! nugget and the short-scale continuity — dominate the fit over the sparse,
//! noisy far-lags (Cressie 1985; Deutsch & Journel 1998, *GSLIB* §II.2).
//!
//! ## Method
//!
//! For a **fixed range** `a`, the model is *linear* in `(c₀, c)`:
//! `γ_model(h) = c₀ · 1 + c · g(h/a)` where `g` is the model's normalised
//! structural function (rising `0 → 1`). So `(c₀, c)` solve a 2×2 weighted normal
//! system in closed form, with the non-negativity constraints `c₀, c ≥ 0` handled
//! by also testing the two boundary solutions and keeping the feasible one of
//! least weighted SSE. The range is then found by a **grid search** over `a`
//! (coarse sweep + a local refinement pass) — robust and fully deterministic, no
//! external optimiser. `Nugget` is fitted directly as the weighted mean
//! semivariance (it has no structural component or range).
//!
//! No third-party geostatistics code was consulted; the fit is derived from the
//! objective above.

use crate::foundation::{AlgoError, Result};
use crate::geostat::experimental::ExperimentalVariogram;
use crate::gridding::kriging::{Variogram, VariogramModel};

/// Normalised structural function `g(r)` (rising `0 → 1`), `r = h / a`, matching
/// the sill-scaled term of [`Variogram::gamma`]. `Nugget` has none (`g ≡ 0`).
fn normalized_structural(model: VariogramModel, r: f64) -> f64 {
    match model {
        VariogramModel::Nugget => 0.0,
        VariogramModel::Spherical => {
            if r >= 1.0 {
                1.0
            } else {
                1.5 * r - 0.5 * r * r * r
            }
        }
        VariogramModel::Exponential => 1.0 - (-3.0 * r).exp(),
        VariogramModel::Gaussian => 1.0 - (-3.0 * r * r).exp(),
    }
}

/// The best feasible `(c0, c)` and its weighted SSE for a fixed range, by
/// weighted linear least squares with `c0, c ≥ 0`.
fn best_c0_c_for_range(
    model: VariogramModel,
    exp: &ExperimentalVariogram,
    range: f64,
) -> (f64, f64, f64) {
    // The normalised structural value g(h/a) depends only on the (fixed) range,
    // so evaluate it once per lag and reuse across both the moment accumulation
    // and every candidate's SSE — it was previously recomputed in each.
    let g: Vec<f64> = exp
        .lags
        .iter()
        .map(|&h| normalized_structural(model, h / range))
        .collect();

    // Weighted moments of the linear system  γ ≈ c0·1 + c·g.
    let (mut sw, mut swg, mut swgg, mut swy, mut swgy) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for ((&gk, &count), &y) in g.iter().zip(&exp.counts).zip(&exp.semivariances) {
        let w = count as f64;
        sw += w;
        swg += w * gk;
        swgg += w * gk * gk;
        swy += w * y;
        swgy += w * gk * y;
    }

    let wsse = |c0: f64, c: f64| -> f64 {
        (0..exp.len())
            .map(|k| {
                let w = exp.counts[k] as f64;
                let r = c0 + c * g[k] - exp.semivariances[k];
                w * r * r
            })
            .sum()
    };

    // Candidate solutions, keep the feasible (c0,c >= 0) one of least SSE.
    let mut candidates: Vec<(f64, f64)> = Vec::new();
    // Unconstrained 2x2 solve.
    let det = sw * swgg - swg * swg;
    if det.abs() > 1e-300 {
        let c0 = (swy * swgg - swg * swgy) / det;
        let c = (sw * swgy - swg * swy) / det;
        candidates.push((c0, c));
    }
    // Boundary c0 = 0: c = swgy / swgg.
    if swgg > 0.0 {
        candidates.push((0.0, swgy / swgg));
    }
    // Boundary c = 0: c0 = swy / sw (weighted mean).
    if sw > 0.0 {
        candidates.push((swy / sw, 0.0));
    }
    candidates.push((0.0, 0.0));

    let mut best = (0.0, 0.0, f64::INFINITY);
    for (c0, c) in candidates {
        if c0 < -1e-12 || c < -1e-12 {
            continue;
        }
        let (c0, c) = (c0.max(0.0), c.max(0.0));
        let e = wsse(c0, c);
        if e < best.2 {
            best = (c0, c, e);
        }
    }
    best
}

impl Variogram {
    /// Fit a `model`-shaped variogram to `exp` by pair-count weighted least
    /// squares (see the [module docs](crate::geostat::fit)).
    ///
    /// Returns the fitted [`Variogram`] (nugget, partial sill and range). Errors
    /// with [`AlgoError::EmptyInput`] on an empty experimental variogram, and
    /// propagates [`Variogram::new`]'s validation (e.g. a degenerate all-zero
    /// fit). For [`VariogramModel::Nugget`] the fit is the weighted-mean
    /// semivariance with a nominal (unused) range.
    pub fn fit(model: VariogramModel, exp: &ExperimentalVariogram) -> Result<Variogram> {
        if exp.is_empty() {
            return Err(AlgoError::EmptyInput(
                "Variogram::fit: empty experimental variogram",
            ));
        }
        let h_max = exp.lags.iter().cloned().fold(0.0_f64, f64::max);

        // Nugget: no range/structure — pure weighted mean of the semivariances.
        if model == VariogramModel::Nugget {
            let sw: f64 = exp.counts.iter().map(|&n| n as f64).sum();
            let swy: f64 = exp
                .semivariances
                .iter()
                .zip(&exp.counts)
                .map(|(y, &n)| n as f64 * y)
                .sum();
            let c0 = if sw > 0.0 { swy / sw } else { 0.0 };
            return Variogram::new(VariogramModel::Nugget, c0, 0.0, h_max.max(1.0));
        }

        // Grid search over the range, then a local refinement sweep.
        let sweep = |lo: f64, hi: f64, steps: usize| -> (f64, f64, f64, f64) {
            let mut best = (0.0, 0.0, 0.0, f64::INFINITY); // (range, c0, c, sse)
            for s in 0..steps {
                let range = lo + (hi - lo) * s as f64 / (steps.max(2) - 1) as f64;
                if range <= 0.0 {
                    continue;
                }
                let (c0, c, sse) = best_c0_c_for_range(model, exp, range);
                if sse < best.3 {
                    best = (range, c0, c, sse);
                }
            }
            best
        };

        let coarse = sweep(h_max / 50.0, h_max * 2.0, 400);
        // Refine within ±one coarse step of the winning range.
        let step = (h_max * 2.0 - h_max / 50.0) / 399.0;
        let fine = sweep((coarse.0 - step).max(h_max / 100.0), coarse.0 + step, 100);
        let best = if fine.3 < coarse.3 { fine } else { coarse };

        Variogram::new(model, best.1, best.2, best.0.max(1e-9))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geostat::experimental::experimental_variogram;

    /// Build a synthetic experimental variogram by sampling a known model exactly
    /// (equal pair counts) — the fit should recover its parameters.
    fn synth_from_model(truth: &Variogram, h_max: f64, n: usize) -> ExperimentalVariogram {
        let lags: Vec<f64> = (1..=n).map(|k| h_max * k as f64 / n as f64).collect();
        let semivariances: Vec<f64> = lags.iter().map(|&h| truth.gamma(h)).collect();
        ExperimentalVariogram {
            lags,
            counts: vec![100; n],
            semivariances,
        }
    }

    #[test]
    fn recovers_spherical_parameters() {
        let truth = Variogram::new(VariogramModel::Spherical, 0.5, 3.0, 40.0).unwrap();
        let exp = synth_from_model(&truth, 80.0, 40);
        let fit = Variogram::fit(VariogramModel::Spherical, &exp).unwrap();
        assert!((fit.nugget - 0.5).abs() < 0.1, "nugget {}", fit.nugget);
        assert!((fit.sill - 3.0).abs() < 0.15, "sill {}", fit.sill);
        assert!((fit.range - 40.0).abs() < 2.0, "range {}", fit.range);
    }

    #[test]
    fn recovers_exponential_parameters() {
        let truth = Variogram::new(VariogramModel::Exponential, 0.0, 2.0, 25.0).unwrap();
        let exp = synth_from_model(&truth, 80.0, 40);
        let fit = Variogram::fit(VariogramModel::Exponential, &exp).unwrap();
        assert!(fit.nugget < 0.1, "nugget {}", fit.nugget);
        assert!((fit.sill - 2.0).abs() < 0.2, "sill {}", fit.sill);
        assert!((fit.range - 25.0).abs() < 3.0, "range {}", fit.range);
    }

    #[test]
    fn empty_experimental_errors() {
        let ev = ExperimentalVariogram {
            lags: vec![],
            semivariances: vec![],
            counts: vec![],
        };
        assert!(Variogram::fit(VariogramModel::Spherical, &ev).is_err());
    }

    #[test]
    fn end_to_end_from_scattered_data() {
        // A smooth linear ramp z = x has a monotone experimental variogram; the
        // fit should return a valid, positive-sill model (sanity, not recovery).
        let mut coords = Vec::new();
        for i in 0..10 {
            for j in 0..10 {
                coords.push([i as f64, j as f64, i as f64]);
            }
        }
        let exp = experimental_variogram(&coords, 1.0, 8).unwrap();
        let fit = Variogram::fit(VariogramModel::Spherical, &exp).unwrap();
        assert!(fit.total_sill() > 0.0);
        assert!(fit.range > 0.0);
    }
}
