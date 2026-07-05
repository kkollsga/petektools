//! **Depth-autocorrelated Gaussian series** — the 1-D primitive under every log
//! generator. A believable log is *not* white noise: adjacent depth samples are
//! correlated over a bed-scale length. This module produces a standard-normal
//! series with that memory, which the bounded transform then shapes into a
//! fraction.
//!
//! ## AR(1) ≙ exponential correlation
//!
//! The series is a first-order autoregression (Box, Jenkins & Reinsel 1994,
//! *Time Series Analysis*, §3.2):
//!
//! ```text
//!   Z₀ ~ N(0, 1)
//!   Zₖ = φₖ · Zₖ₋₁ + √(1 − φₖ²) · εₖ,   εₖ ~ N(0, 1)
//! ```
//!
//! Each `Zₖ` is marginally `N(0, 1)` (stationary), and the innovation scaling
//! `√(1−φ²)` is exactly what keeps the variance at 1. With a constant `φ` the
//! autocorrelation at lag `ℓ` steps is `φ^ℓ` — a geometric decay, the discrete
//! image of the **exponential covariance** `ρ(h) = e^{−h/L}`. Matching the
//! per-step lag to a correlation length `L` (metres) over a sample spacing `Δ`
//! gives
//!
//! ```text
//!   φ = e^{−Δ/L}                    (see `ar1_phi`)
//! ```
//!
//! so `L` is the e-folding length of the depth autocorrelation. `φ` may vary from
//! step to step (a per-sample correlation length): the recursion stays marginally
//! `N(0,1)`, giving a **non-stationary** series whose continuity tightens or
//! loosens with depth — exactly what a zone stack with per-zone correlation
//! lengths needs.
//!
//! Derived from the AR(1) definition; no third-party code was consulted.

use rand::rngs::StdRng;
use rand_distr::{Distribution, Normal};

/// The AR(1) lag-1 correlation `φ = e^{−Δ/L}` for a sample spacing `step_m` and
/// an exponential correlation length `corr_length_m` (both in metres). A
/// non-positive or non-finite correlation length yields `0` (no correlation —
/// white noise), the safe rangeless limit.
pub(crate) fn ar1_phi(step_m: f64, corr_length_m: f64) -> f64 {
    if !(corr_length_m.is_finite() && corr_length_m > 0.0) || step_m <= 0.0 {
        return 0.0;
    }
    (-step_m / corr_length_m).exp()
}

/// Generate an AR(1)-correlated standard-normal series of length `n`, where
/// `phi(k)` gives the lag-1 correlation for the step from sample `k−1` to `k`
/// (`phi(0)` is unused). `phi` is clamped to `[0, 1)` for numerical safety.
///
/// The stream is driven entirely by `rng`, so a seeded RNG reproduces the series
/// bit-for-bit.
pub(crate) fn correlated_gaussian<F: Fn(usize) -> f64>(
    n: usize,
    phi: F,
    rng: &mut StdRng,
) -> Vec<f64> {
    let sn = Normal::new(0.0, 1.0).expect("standard normal");
    let mut out = Vec::with_capacity(n);
    if n == 0 {
        return out;
    }
    let mut prev = sn.sample(rng);
    out.push(prev);
    for k in 1..n {
        let p = phi(k).clamp(0.0, 1.0 - 1e-9);
        let eps = sn.sample(rng);
        let z = p * prev + (1.0 - p * p).sqrt() * eps;
        out.push(z);
        prev = z;
    }
    out
}

/// Lag-1 sample autocorrelation of a series (used by tests and continuity checks).
#[cfg(test)]
pub(crate) fn lag1_autocorr(series: &[f64]) -> f64 {
    let n = series.len();
    if n < 2 {
        return 0.0;
    }
    let m = series.iter().sum::<f64>() / n as f64;
    let mut num = 0.0;
    let mut den = 0.0;
    for i in 0..n {
        den += (series[i] - m).powi(2);
        if i + 1 < n {
            num += (series[i] - m) * (series[i + 1] - m);
        }
    }
    if den == 0.0 {
        0.0
    } else {
        num / den
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sampling::seeded_rng;

    #[test]
    fn phi_maps_length_to_correlation() {
        // e-folding: at lag = L the correlation is e^-1.
        let phi = ar1_phi(1.0, 10.0);
        assert!((phi - (-0.1_f64).exp()).abs() < 1e-12);
        // rangeless / degenerate → white.
        assert_eq!(ar1_phi(1.0, 0.0), 0.0);
        assert_eq!(ar1_phi(1.0, -5.0), 0.0);
    }

    #[test]
    fn series_is_reproducible_and_unit_variance() {
        let phi = ar1_phi(0.5, 8.0);
        let mut r1 = seeded_rng(7);
        let mut r2 = seeded_rng(7);
        let a = correlated_gaussian(5000, |_| phi, &mut r1);
        let b = correlated_gaussian(5000, |_| phi, &mut r2);
        assert_eq!(a, b);
        // marginal ~ N(0,1).
        let m = a.iter().sum::<f64>() / a.len() as f64;
        let v = a.iter().map(|x| (x - m).powi(2)).sum::<f64>() / a.len() as f64;
        assert!(m.abs() < 0.1, "mean {m}");
        assert!((v - 1.0).abs() < 0.15, "var {v}");
    }

    #[test]
    fn recovers_the_correlation_length() {
        // A long series should recover phi via the lag-1 autocorrelation.
        let phi = ar1_phi(1.0, 20.0); // ~0.951
        let mut rng = seeded_rng(3);
        let s = correlated_gaussian(20000, |_| phi, &mut rng);
        let r = lag1_autocorr(&s);
        assert!((r - phi).abs() < 0.03, "recovered {r} vs {phi}");
    }

    #[test]
    fn zero_phi_is_white() {
        let mut rng = seeded_rng(1);
        let s = correlated_gaussian(20000, |_| 0.0, &mut rng);
        assert!(lag1_autocorr(&s).abs() < 0.03);
    }
}
