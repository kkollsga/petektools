//! `sampling` bindings — the reproducible-draw front-door.
//!
//! Mirrors `petektools::sampling`: every [`Sampler`] variant, the `.clamped()`
//! combinator, and an explicit seeded [`Rng`] so a Python Monte-Carlo reproduces
//! the Rust engine's stream bit-for-bit (same seed + params → identical draws;
//! guarded by the cross-language parity vector in the Rust `tests/parity.rs`).

use petektools::sampling::{seeded_rng, Clamped, Sampler};
use pyo3::prelude::*;
use rand::rngs::StdRng;

use crate::to_pyerr;

/// A deterministic RNG — `Rng(seed)` seeds a stream; the *same* seed replays the
/// *same* draws. Thread one instance through successive `sample`/`sample_n`
/// calls (each call advances it), exactly like the Rust `seeded_rng`.
#[pyclass(name = "Rng")]
pub struct Rng {
    pub(crate) inner: StdRng,
}

#[pymethods]
impl Rng {
    #[new]
    fn new(seed: u64) -> Rng {
        Rng {
            inner: seeded_rng(seed),
        }
    }

    fn __repr__(&self) -> String {
        "Rng(<seeded stream>)".to_string()
    }
}

/// A validated distribution to draw from. Build one with a variant constructor
/// (`Sampler.uniform(...)`, `Sampler.normal(...)`, …) — each validates its
/// parameters up front — then draw with `sample(rng)` / `sample_n(n, rng)` (an
/// explicit [`Rng`] for reproducibility) or the `*_seeded` convenience.
///
/// Units/conventions: parameters are in the quantity's own units. For
/// `lognormal`, `mean`/`std_dev` are the parameters of the *underlying normal*
/// (log-space). `truncated_normal` *reshapes* the density onto `[lo, hi]`
/// (renormalised, no mass at the bounds); `.clamped(lo, hi)` instead *snaps*
/// out-of-range draws to the nearest bound (mass piles at `lo`/`hi`).
#[pyclass(name = "Sampler", frozen)]
pub struct PySampler {
    pub(crate) inner: Sampler,
}

#[pymethods]
impl PySampler {
    /// Uniform on `[lo, hi)`. Requires finite `lo < hi`.
    #[staticmethod]
    fn uniform(lo: f64, hi: f64) -> PyResult<PySampler> {
        Sampler::new_uniform(lo, hi)
            .map(|inner| PySampler { inner })
            .map_err(to_pyerr)
    }

    /// Normal with the given `mean` and `std_dev` (`std_dev > 0`).
    #[staticmethod]
    fn normal(mean: f64, std_dev: f64) -> PyResult<PySampler> {
        Sampler::new_normal(mean, std_dev)
            .map(|inner| PySampler { inner })
            .map_err(to_pyerr)
    }

    /// Log-normal: `ln(x) ~ Normal(mean, std_dev)` — `mean`/`std_dev` parametrise
    /// the *underlying* normal (log-space). Draws are strictly positive.
    #[staticmethod]
    fn lognormal(mean: f64, std_dev: f64) -> PyResult<PySampler> {
        Sampler::new_lognormal(mean, std_dev)
            .map(|inner| PySampler { inner })
            .map_err(to_pyerr)
    }

    /// Triangular on `[min, max]` peaking at `mode` (`min <= mode <= max`).
    #[staticmethod]
    fn triangular(min: f64, mode: f64, max: f64) -> PyResult<PySampler> {
        Sampler::new_triangular(min, mode, max)
            .map(|inner| PySampler { inner })
            .map_err(to_pyerr)
    }

    /// A `Normal(mean, std_dev)` **truncated** to `[lo, hi]`: the density is
    /// renormalised over the interval (exact clipped-CDF draw, always in bounds).
    /// Use this for a genuinely bounded quantity (a saturation in `[0, 1]`, a
    /// positive thickness). For a hard limiter instead, see `.clamped`.
    #[staticmethod]
    fn truncated_normal(mean: f64, std_dev: f64, lo: f64, hi: f64) -> PyResult<PySampler> {
        Sampler::new_truncated_normal(mean, std_dev, lo, hi)
            .map(|inner| PySampler { inner })
            .map_err(to_pyerr)
    }

    /// Wrap this sampler so every draw is clamped into `[lo, hi]` (out-of-range
    /// draws snap to the nearest bound → mass *piles* at `lo`/`hi`). The general
    /// hard-limiter combinator; works on any variant. Requires finite `lo < hi`.
    fn clamped(&self, lo: f64, hi: f64) -> PyResult<PyClamped> {
        self.inner
            .clamped(lo, hi)
            .map(|inner| PyClamped { inner })
            .map_err(to_pyerr)
    }

    /// Draw one sample, advancing `rng`.
    fn sample(&self, rng: &mut Rng) -> f64 {
        self.inner.sample(&mut rng.inner)
    }

    /// Draw `n` samples, advancing `rng`.
    fn sample_n(&self, n: usize, rng: &mut Rng) -> Vec<f64> {
        self.inner.sample_n(n, &mut rng.inner)
    }

    /// Convenience: draw `n` samples from a *fresh* `Rng(seed)`. Equivalent to
    /// `sample_n(n, Rng(seed))` and to the Rust
    /// `sampler.sample_n(n, &mut seeded_rng(seed))` — the parity path.
    fn sample_n_seeded(&self, n: usize, seed: u64) -> Vec<f64> {
        self.inner.sample_n(n, &mut seeded_rng(seed))
    }

    fn __repr__(&self) -> String {
        format!("Sampler({:?})", self.inner)
    }
}

/// A sampler whose every draw is clamped into `[lo, hi]` (see
/// [`PySampler::clamped`]). Same draw API as [`PySampler`].
#[pyclass(name = "Clamped", frozen)]
pub struct PyClamped {
    pub(crate) inner: Clamped,
}

#[pymethods]
impl PyClamped {
    /// Draw one clamped sample, advancing `rng`.
    fn sample(&self, rng: &mut Rng) -> f64 {
        self.inner.sample(&mut rng.inner)
    }

    /// Draw `n` clamped samples, advancing `rng`.
    fn sample_n(&self, n: usize, rng: &mut Rng) -> Vec<f64> {
        self.inner.sample_n(n, &mut rng.inner)
    }

    /// Convenience: draw `n` clamped samples from a fresh `Rng(seed)`.
    fn sample_n_seeded(&self, n: usize, seed: u64) -> Vec<f64> {
        self.inner.sample_n(n, &mut seeded_rng(seed))
    }

    fn __repr__(&self) -> String {
        format!("Clamped({:?})", self.inner)
    }
}
