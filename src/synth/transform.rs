//! **Moment-matched bounded transform** — the map that turns a standard-normal
//! variate into a `[0, 1]`-bounded fraction (porosity, net-to-gross, water
//! saturation) with a *prescribed* mean and standard deviation.
//!
//! ## The transform
//!
//! A believable petrophysical fraction must (a) never leave `[0, 1]` and (b) hit
//! a target `{mean, std}`. The **logit-normal** map does both:
//!
//! ```text
//!   X = logistic(a + b·Z),   Z ~ N(0, 1),   logistic(t) = 1 / (1 + e^-t)
//! ```
//!
//! `X` is *strictly* interior to `(0, 1)` for every finite `Z` — bounds are
//! **never** violated (contrast a clipped/censored Gaussian `clamp(μ + σZ, 0, 1)`,
//! which is exact only in the interior and piles probability mass on the bounds,
//! biasing the realized mean toward ½ and shrinking the realized std as the target
//! approaches 0 or 1). Because the map is **monotone**, applying it to an
//! autocorrelated Gaussian series preserves that series' ordering and — to good
//! approximation in the near-linear central band — its correlation length.
//!
//! ## Matching the moments
//!
//! The logit-normal has no closed-form moments, so `(a, b)` are solved
//! numerically. With `Z` integrated by an `N`-point equal-probability
//! (quantile) quadrature `zᵢ = Φ⁻¹((i+½)/N)`:
//!
//! ```text
//!   E[X](a, b) = (1/N) Σ logistic(a + b·zᵢ)
//!   Var[X](a, b) = (1/N) Σ logistic(a + b·zᵢ)² − E[X]²
//! ```
//!
//! `E[X]` is monotone increasing in `a` (inner bisection pins the mean); with the
//! mean pinned, `Var[X]` is monotone increasing in `b` from `0` (as `b→0`, `X`
//! collapses to the constant `logistic(a)`) up to the two-point Bernoulli limit
//! `m(1−m)` (as `b→∞`, `X → {0,1}` with `P(1)=m`). An **outer bisection on `b`**
//! hits the target variance.
//!
//! ## Bias behaviour near the bounds
//!
//! The achievable variance is capped at `m(1−m)` — the variance of a Bernoulli
//! with the same mean. A target `std² ≥ m(1−m)` is **infeasible** (rejected): you
//! cannot ask a `[0,1]` variable with mean `m` to be more variable than the
//! extreme two-point distribution. As the target mean nears a bound the feasible
//! std window narrows accordingly; the transform stays exact and unbiased *inside*
//! that window (unlike the clipped-Gaussian alternative, whose realized moments
//! drift once its Gaussian mass reaches a bound). Derived independently from the
//! logit-normal definition (Atchison & Shen 1980, *Logistic-normal distributions*);
//! no third-party code was consulted.

use crate::foundation::{AlgoError, Result};
use statrs::distribution::{ContinuousCDF, Normal as StatrsNormal};

/// Number of equal-probability quadrature nodes used to integrate the
/// logit-normal moments over `Z ~ N(0,1)`. 256 balances accuracy and cost (the
/// solve runs once per zone/facies, not per sample).
const QUAD_NODES: usize = 256;

/// The numeric logistic (sigmoid), overflow-safe on both tails.
pub(crate) fn logistic(t: f64) -> f64 {
    if t >= 0.0 {
        1.0 / (1.0 + (-t).exp())
    } else {
        let e = t.exp();
        e / (1.0 + e)
    }
}

/// A fitted logit-normal transform `X = logistic(a + b·Z)` matching a target
/// `{mean, std}` over `Z ~ N(0, 1)`. Build with [`LogitNormal::match_moments`],
/// then map an autocorrelated standard-normal series through [`apply`](Self::apply).
#[derive(Debug, Clone, Copy)]
pub(crate) struct LogitNormal {
    a: f64,
    b: f64,
}

impl LogitNormal {
    /// Solve `(a, b)` so that `E[X] = mean` and `SD[X] = std` for `X =
    /// logistic(a + b·Z)`.
    ///
    /// Errors ([`AlgoError::InvalidArgument`]) unless `0 < mean < 1`, `std > 0`,
    /// and the target is feasible (`std² < mean·(1−mean)`, the Bernoulli cap).
    pub(crate) fn match_moments(mean: f64, std: f64) -> Result<LogitNormal> {
        if !(mean.is_finite() && std.is_finite()) || mean <= 0.0 || mean >= 1.0 || std <= 0.0 {
            return Err(AlgoError::InvalidArgument(
                "synth transform: need 0 < mean < 1 and std > 0".to_string(),
            ));
        }
        let target_var = std * std;
        let cap = mean * (1.0 - mean);
        if target_var >= cap {
            return Err(AlgoError::InvalidArgument(format!(
                "synth transform: std {std} too large for mean {mean} — a [0,1] variable \
                 with this mean cannot exceed the Bernoulli variance {cap:.5} (std < {:.5})",
                cap.sqrt()
            )));
        }

        let nodes = quad_nodes();

        // Outer bisection on b (variance monotone increasing in b, mean pinned).
        let mut lo = 1e-6_f64;
        let mut hi = 60.0_f64;
        let mut a = a_for_mean(0.0, &nodes, mean); // initialised; recomputed in loop
        let mut b = 0.5 * (lo + hi);
        for _ in 0..200 {
            b = 0.5 * (lo + hi);
            a = a_for_mean(b, &nodes, mean);
            let var = variance_at(a, b, &nodes);
            if (var - target_var).abs() <= 1e-10 {
                break;
            }
            if var < target_var {
                lo = b;
            } else {
                hi = b;
            }
        }
        Ok(LogitNormal { a, b })
    }

    /// Construct directly from raw logit-normal parameters `X = logistic(a + b·Z)`
    /// (no moment inversion). Used by the coupled petrophysics calibration, which
    /// solves `(a, b)` against *net-conditioned* targets rather than the marginal
    /// `{mean, std}` — see [`crate::synth::petro`].
    pub(crate) fn from_ab(a: f64, b: f64) -> LogitNormal {
        LogitNormal { a, b }
    }

    /// The raw `(a, b)` parameters — the starting point when a downstream solve
    /// refines a moment-matched fit against a different objective.
    pub(crate) fn ab(&self) -> (f64, f64) {
        (self.a, self.b)
    }

    /// Map a standard-normal variate `z` to the bounded fraction `X ∈ (0, 1)`.
    pub(crate) fn apply(&self, z: f64) -> f64 {
        logistic(self.a + self.b * z)
    }

    /// Linear blend toward `other` by `t ∈ [0, 1]` in the transform's `(a, b)`
    /// parameters — the smooth statistics shift across a zone boundary. `t = 0`
    /// is `self`, `t = 1` is `other`.
    pub(crate) fn lerp(&self, other: &LogitNormal, t: f64) -> LogitNormal {
        let t = t.clamp(0.0, 1.0);
        LogitNormal {
            a: self.a + (other.a - self.a) * t,
            b: self.b + (other.b - self.b) * t,
        }
    }
}

/// The `N` equal-probability quadrature nodes `zᵢ = Φ⁻¹((i+½)/N)` for `Z ~ N(0,1)`.
/// Shared with [`crate::synth::petro`], which integrates *exceedance* functionals
/// (`P(X≥c)`, above-cutoff moment masses) over the same node set.
pub(crate) fn quad_nodes() -> Vec<f64> {
    let snorm = StatrsNormal::new(0.0, 1.0).expect("standard normal");
    (0..QUAD_NODES)
        .map(|i| snorm.inverse_cdf((i as f64 + 0.5) / QUAD_NODES as f64))
        .collect()
}

/// `E[logistic(a + b·Z)]` over the quadrature nodes.
fn mean_at(a: f64, b: f64, nodes: &[f64]) -> f64 {
    nodes.iter().map(|&z| logistic(a + b * z)).sum::<f64>() / nodes.len() as f64
}

/// `Var[logistic(a + b·Z)]` over the quadrature nodes.
fn variance_at(a: f64, b: f64, nodes: &[f64]) -> f64 {
    let n = nodes.len() as f64;
    let mut s = 0.0;
    let mut s2 = 0.0;
    for &z in nodes {
        let x = logistic(a + b * z);
        s += x;
        s2 += x * x;
    }
    let m = s / n;
    (s2 / n - m * m).max(0.0)
}

/// Inner bisection: the intercept `a` making `E[logistic(a + b·Z)] = target`
/// (monotone increasing in `a`).
fn a_for_mean(b: f64, nodes: &[f64], target: f64) -> f64 {
    let mut lo = -40.0_f64;
    let mut hi = 40.0_f64;
    for _ in 0..200 {
        let mid = 0.5 * (lo + hi);
        let m = mean_at(mid, b, nodes);
        if (m - target).abs() <= 1e-12 {
            return mid;
        }
        if m < target {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Realized population `{mean, var}` of the fitted transform over the nodes.
    fn realized(t: &LogitNormal) -> (f64, f64) {
        let nodes = quad_nodes();
        (mean_at(t.a, t.b, &nodes), variance_at(t.a, t.b, &nodes))
    }

    #[test]
    fn hits_target_moments_across_the_feasible_range() {
        for &(m, s) in &[
            (0.22, 0.03),
            (0.70, 0.12),
            (0.30, 0.10),
            (0.05, 0.02),
            (0.95, 0.02),
            (0.5, 0.28),
        ] {
            let t = LogitNormal::match_moments(m, s).unwrap();
            let (rm, rv) = realized(&t);
            assert!((rm - m).abs() < 1e-4, "mean {rm} vs {m}");
            assert!((rv.sqrt() - s).abs() < 1e-4, "std {} vs {s}", rv.sqrt());
        }
    }

    #[test]
    fn output_is_strictly_in_bounds() {
        let t = LogitNormal::match_moments(0.5, 0.28).unwrap();
        // Over a realistic Gaussian range the output is strictly interior.
        for z in [-8.0, -3.0, 0.0, 3.0, 8.0] {
            let x = t.apply(z);
            assert!(x > 0.0 && x < 1.0, "x={x} not strictly in (0,1) at z={z}");
        }
        // At absurd extremes it saturates to the closed bound (f64 rounding) but
        // never leaves [0, 1] — the guarantee that matters.
        for z in [40.0, -40.0, 1e6, -1e6] {
            let x = t.apply(z);
            assert!((0.0..=1.0).contains(&x), "x={x} left [0,1] at z={z}");
        }
    }

    #[test]
    fn rejects_infeasible_and_bad_targets() {
        // std >= sqrt(m(1-m)) is infeasible.
        assert!(LogitNormal::match_moments(0.5, 0.5).is_err());
        assert!(LogitNormal::match_moments(0.1, 0.31).is_err()); // sqrt(.09)=.30
                                                                 // out-of-range mean / non-positive std.
        assert!(LogitNormal::match_moments(0.0, 0.1).is_err());
        assert!(LogitNormal::match_moments(1.0, 0.1).is_err());
        assert!(LogitNormal::match_moments(0.5, 0.0).is_err());
    }

    #[test]
    fn logistic_is_overflow_safe() {
        assert_eq!(logistic(1000.0), 1.0);
        assert_eq!(logistic(-1000.0), 0.0);
        assert!((logistic(0.0) - 0.5).abs() < 1e-15);
    }
}
