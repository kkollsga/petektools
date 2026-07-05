//! The [`Sampler`] front-door + a deterministic [`seeded_rng`].

use crate::foundation::{AlgoError, Result};
use rand::rngs::StdRng;
use rand::{Rng, RngExt, SeedableRng};
use rand_distr::{Distribution, LogNormal, Normal, Triangular};
use statrs::distribution::{ContinuousCDF, Normal as StatrsNormal};

/// A deterministic RNG seeded from `seed` — same seed, same stream. Use it to
/// make a Monte-Carlo run reproducible.
pub fn seeded_rng(seed: u64) -> StdRng {
    StdRng::seed_from_u64(seed)
}

/// A validated distribution to draw from. Construct with the `new_*`
/// constructors (which validate the parameters), then [`sample`](Sampler::sample)
/// one draw or [`sample_n`](Sampler::sample_n) a batch.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum Sampler {
    /// Uniform on `[lo, hi)`.
    Uniform { lo: f64, hi: f64 },
    /// Normal with the given mean and standard deviation.
    Normal { mean: f64, std_dev: f64 },
    /// Log-normal: `ln(x) ~ Normal(mean, std_dev)` — `mean`/`std_dev` are the
    /// parameters of the *underlying* normal (log-space).
    LogNormal { mean: f64, std_dev: f64 },
    /// Triangular on `[min, max]` with the given `mode` (`min ≤ mode ≤ max`).
    Triangular { min: f64, mode: f64, max: f64 },
    /// A normal `Normal(mean, std_dev)` **truncated** to the interval `[lo, hi]`
    /// — the mass outside the bounds is removed and the density *renormalised*
    /// over `[lo, hi]` (not piled onto the bounds; contrast [`Clamped`]). Drawn
    /// by the exact clipped-CDF (inverse-transform) method — see
    /// [`sample`](Sampler::sample).
    TruncatedNormal {
        mean: f64,
        std_dev: f64,
        lo: f64,
        hi: f64,
    },
}

impl Sampler {
    /// Uniform on `[lo, hi)`. Errors unless `lo < hi` and both are finite.
    pub fn new_uniform(lo: f64, hi: f64) -> Result<Sampler> {
        if !(lo.is_finite() && hi.is_finite()) || lo >= hi {
            return Err(AlgoError::InvalidArgument(
                "sampling: uniform needs finite lo < hi".to_string(),
            ));
        }
        Ok(Sampler::Uniform { lo, hi })
    }

    /// Normal(`mean`, `std_dev`). Errors unless `std_dev > 0` and both finite.
    pub fn new_normal(mean: f64, std_dev: f64) -> Result<Sampler> {
        if !(mean.is_finite() && std_dev.is_finite()) || std_dev <= 0.0 {
            return Err(AlgoError::InvalidArgument(
                "sampling: normal needs finite mean and std_dev > 0".to_string(),
            ));
        }
        Ok(Sampler::Normal { mean, std_dev })
    }

    /// Log-normal with underlying-normal parameters (`mean`, `std_dev`) in
    /// log-space. Errors unless `std_dev > 0` and both finite.
    pub fn new_lognormal(mean: f64, std_dev: f64) -> Result<Sampler> {
        if !(mean.is_finite() && std_dev.is_finite()) || std_dev <= 0.0 {
            return Err(AlgoError::InvalidArgument(
                "sampling: lognormal needs finite mean and std_dev > 0 (log-space)".to_string(),
            ));
        }
        Ok(Sampler::LogNormal { mean, std_dev })
    }

    /// Triangular on `[min, max]` with peak at `mode`. Errors unless
    /// `min ≤ mode ≤ max`, `min < max`, and all finite.
    pub fn new_triangular(min: f64, mode: f64, max: f64) -> Result<Sampler> {
        if !(min.is_finite()
            && mode.is_finite()
            && max.is_finite()
            && min < max
            && (min..=max).contains(&mode))
        {
            return Err(AlgoError::InvalidArgument(
                "sampling: triangular needs finite min < max with min <= mode <= max".to_string(),
            ));
        }
        Ok(Sampler::Triangular { min, mode, max })
    }

    /// A `Normal(mean, std_dev)` truncated to `[lo, hi]` (see
    /// [`Sampler::TruncatedNormal`]). Errors unless `std_dev > 0`, `lo < hi`, and
    /// all four are finite.
    ///
    /// This *reshapes* the distribution to live on `[lo, hi]` (the removed tail
    /// mass is redistributed under the truncated density) — use it when a
    /// quantity is genuinely bounded (a saturation in `[0, 1]`, a positive
    /// thickness). If you instead want a plain normal with out-of-range draws
    /// snapped to the bounds (mass *piled* at `lo`/`hi`), use
    /// [`clamped`](Sampler::clamped) on a [`Sampler::Normal`].
    pub fn new_truncated_normal(mean: f64, std_dev: f64, lo: f64, hi: f64) -> Result<Sampler> {
        if !(mean.is_finite() && std_dev.is_finite() && lo.is_finite() && hi.is_finite())
            || std_dev <= 0.0
            || lo >= hi
        {
            return Err(AlgoError::InvalidArgument(
                "sampling: truncated normal needs finite mean, std_dev > 0 and lo < hi".to_string(),
            ));
        }
        Ok(Sampler::TruncatedNormal {
            mean,
            std_dev,
            lo,
            hi,
        })
    }

    /// Wrap this sampler so every draw is clamped into `[lo, hi]` — see
    /// [`Clamped`]. Errors unless `lo < hi` and both are finite.
    ///
    /// **Clamping is not truncation.** A draw outside `[lo, hi]` is snapped to
    /// the nearest bound, so the bounds carry *point masses* (all the tail mass
    /// collapses onto `lo`/`hi`). When you want the density genuinely reshaped
    /// onto the interval, reach for [`new_truncated_normal`](Sampler::new_truncated_normal)
    /// instead. `clamped` is the general combinator: it works on *any* sampler
    /// (e.g. a `Triangular` or `LogNormal` you just want to hard-limit).
    pub fn clamped(self, lo: f64, hi: f64) -> Result<Clamped> {
        Clamped::new(self, lo, hi)
    }

    /// Draw one sample from `rng`.
    pub fn sample<R: Rng>(&self, rng: &mut R) -> f64 {
        match *self {
            Sampler::Uniform { lo, hi } => rng.random_range(lo..hi),
            Sampler::Normal { mean, std_dev } => {
                // Params validated at construction, so `new` cannot fail here.
                Normal::new(mean, std_dev).expect("validated").sample(rng)
            }
            Sampler::LogNormal { mean, std_dev } => LogNormal::new(mean, std_dev)
                .expect("validated")
                .sample(rng),
            Sampler::Triangular { min, mode, max } => {
                // rand_distr's constructor order is (min, max, mode).
                Triangular::new(min, max, mode)
                    .expect("validated")
                    .sample(rng)
            }
            Sampler::TruncatedNormal {
                mean,
                std_dev,
                lo,
                hi,
            } => sample_truncated_normal(mean, std_dev, lo, hi, rng),
        }
    }

    /// Draw `n` samples from `rng`.
    pub fn sample_n<R: Rng>(&self, n: usize, rng: &mut R) -> Vec<f64> {
        (0..n).map(|_| self.sample(rng)).collect()
    }
}

/// One truncated-normal draw by the **clipped-CDF (inverse-transform) method**:
/// with `α = (lo − μ)/σ`, `β = (hi − μ)/σ` and `Φ` the standard-normal CDF, draw
/// `u ~ Uniform[Φ(α), Φ(β))` and return `μ + σ·Φ⁻¹(u)`. This is *exact* (the
/// returned value is distributed as the true truncated normal), needs no
/// rejection loop, and always lands in `[lo, hi]`. The final `clamp` only guards
/// the floating-point edge (`Φ⁻¹` near `u = 0`/`1`).
///
/// Degenerate case: when the bounds sit so far in one tail that `Φ(α)` and `Φ(β)`
/// round to the same double, the interval has no width — we fall back to the
/// bound-clamped mean, the limit of the truncated distribution.
fn sample_truncated_normal<R: Rng>(mean: f64, std_dev: f64, lo: f64, hi: f64, rng: &mut R) -> f64 {
    let snorm = StatrsNormal::new(0.0, 1.0).expect("standard normal");
    let a = snorm.cdf((lo - mean) / std_dev);
    let b = snorm.cdf((hi - mean) / std_dev);
    if b <= a {
        // Bounds collapsed to a single CDF value (extreme-tail truncation).
        return mean.clamp(lo, hi);
    }
    let u = rng.random_range(a..b);
    (mean + std_dev * snorm.inverse_cdf(u)).clamp(lo, hi)
}

/// A sampler whose every draw is clamped into `[lo, hi]` (see
/// [`Sampler::clamped`]). Build it with [`Clamped::new`] or the
/// [`Sampler::clamped`] combinator.
///
/// Clamping snaps an out-of-range draw to the nearest bound, so `lo` and `hi`
/// accumulate the tail mass — it is a hard limiter, **not** a truncation of the
/// density (for that, use [`Sampler::new_truncated_normal`]).
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Clamped {
    inner: Sampler,
    lo: f64,
    hi: f64,
}

impl Clamped {
    /// Wrap `inner` so its draws are clamped into `[lo, hi]`. Errors unless
    /// `lo < hi` and both are finite.
    pub fn new(inner: Sampler, lo: f64, hi: f64) -> Result<Clamped> {
        if !(lo.is_finite() && hi.is_finite()) || lo >= hi {
            return Err(AlgoError::InvalidArgument(
                "sampling: clamp needs finite lo < hi".to_string(),
            ));
        }
        Ok(Clamped { inner, lo, hi })
    }

    /// Draw one clamped sample from `rng`.
    pub fn sample<R: Rng>(&self, rng: &mut R) -> f64 {
        self.inner.sample(rng).clamp(self.lo, self.hi)
    }

    /// Draw `n` clamped samples from `rng`.
    pub fn sample_n<R: Rng>(&self, n: usize, rng: &mut R) -> Vec<f64> {
        (0..n).map(|_| self.sample(rng)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constructors_validate() {
        assert!(Sampler::new_uniform(1.0, 0.0).is_err());
        assert!(Sampler::new_uniform(0.0, 1.0).is_ok());
        assert!(Sampler::new_normal(0.0, -1.0).is_err());
        assert!(Sampler::new_normal(0.0, 1.0).is_ok());
        assert!(Sampler::new_lognormal(0.0, 0.0).is_err());
        assert!(Sampler::new_triangular(0.0, 5.0, 1.0).is_err()); // mode > max
        assert!(Sampler::new_triangular(0.0, 0.5, 1.0).is_ok());
    }

    #[test]
    fn seeded_rng_is_reproducible() {
        let s = Sampler::new_normal(10.0, 2.0).unwrap();
        let a = s.sample_n(100, &mut seeded_rng(42));
        let b = s.sample_n(100, &mut seeded_rng(42));
        assert_eq!(a, b, "same seed must reproduce the stream");
        let c = s.sample_n(100, &mut seeded_rng(43));
        assert_ne!(a, c, "a different seed should differ");
    }

    #[test]
    fn uniform_stays_in_range() {
        let s = Sampler::new_uniform(-3.0, 7.0).unwrap();
        let mut rng = seeded_rng(1);
        for v in s.sample_n(1000, &mut rng) {
            assert!((-3.0..7.0).contains(&v), "out of range: {v}");
        }
    }

    #[test]
    fn triangular_stays_within_support() {
        let s = Sampler::new_triangular(2.0, 4.0, 10.0).unwrap();
        let mut rng = seeded_rng(7);
        for v in s.sample_n(1000, &mut rng) {
            assert!((2.0..=10.0).contains(&v), "out of support: {v}");
        }
    }

    #[test]
    fn normal_mean_is_approximately_recovered() {
        let s = Sampler::new_normal(5.0, 1.0).unwrap();
        let mut rng = seeded_rng(2024);
        let xs = s.sample_n(20_000, &mut rng);
        let m: f64 = xs.iter().sum::<f64>() / xs.len() as f64;
        assert!((m - 5.0).abs() < 0.05, "sample mean {m} far from 5.0");
    }

    #[test]
    fn lognormal_is_positive() {
        let s = Sampler::new_lognormal(0.0, 0.5).unwrap();
        let mut rng = seeded_rng(9);
        for v in s.sample_n(1000, &mut rng) {
            assert!(v > 0.0, "lognormal must be positive: {v}");
        }
    }

    #[test]
    fn truncated_normal_validates() {
        assert!(Sampler::new_truncated_normal(0.0, 0.0, -1.0, 1.0).is_err()); // sd = 0
        assert!(Sampler::new_truncated_normal(0.0, 1.0, 1.0, -1.0).is_err()); // lo > hi
        assert!(Sampler::new_truncated_normal(0.0, 1.0, f64::NAN, 1.0).is_err());
        assert!(Sampler::new_truncated_normal(0.0, 1.0, -2.0, 2.0).is_ok());
    }

    #[test]
    fn truncated_normal_stays_in_bounds() {
        let s = Sampler::new_truncated_normal(0.0, 1.0, -0.5, 0.5).unwrap();
        let mut rng = seeded_rng(11);
        for v in s.sample_n(5000, &mut rng) {
            assert!((-0.5..=0.5).contains(&v), "out of bounds: {v}");
        }
    }

    #[test]
    fn truncated_normal_symmetric_mean_is_centre() {
        // Truncating a zero-mean normal symmetrically keeps the mean at 0 (the
        // clipped-CDF method reshapes the density, so the mean is unbiased).
        let s = Sampler::new_truncated_normal(0.0, 1.0, -1.5, 1.5).unwrap();
        let mut rng = seeded_rng(2024);
        let xs = s.sample_n(40_000, &mut rng);
        let m: f64 = xs.iter().sum::<f64>() / xs.len() as f64;
        assert!(m.abs() < 0.03, "truncated mean {m} not ~0");
    }

    #[test]
    fn truncated_narrower_than_clamped() {
        // A key distinction: truncation reshapes (no draws at the exact bound),
        // clamping piles tail mass onto the bounds. With tight bounds a clamped
        // normal produces many exact-bound hits; the truncated one produces none.
        let mut rng = seeded_rng(5);
        let clamped = Sampler::new_normal(0.0, 1.0)
            .unwrap()
            .clamped(-0.25, 0.25)
            .unwrap();
        let n_at_bound = clamped
            .sample_n(2000, &mut rng)
            .iter()
            .filter(|v| (**v - 0.25).abs() < 1e-12 || (**v + 0.25).abs() < 1e-12)
            .count();
        assert!(n_at_bound > 100, "clamping should pile mass at bounds");
    }

    #[test]
    fn clamped_validates_and_limits_any_sampler() {
        assert!(Sampler::new_uniform(0.0, 10.0)
            .unwrap()
            .clamped(1.0, 1.0)
            .is_err()); // lo == hi
        let s = Sampler::new_uniform(-100.0, 100.0)
            .unwrap()
            .clamped(-2.0, 3.0)
            .unwrap();
        let mut rng = seeded_rng(3);
        for v in s.sample_n(2000, &mut rng) {
            assert!((-2.0..=3.0).contains(&v), "clamp escaped: {v}");
        }
    }
}
