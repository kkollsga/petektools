//! The **normal-score transform**: a monotone map taking data of any marginal
//! distribution to standard-normal *scores*, and its inverse (back-transform).
//!
//! Sequential Gaussian simulation assumes a multi-Gaussian random function, so
//! the data are first transformed to `N(0, 1)` scores, simulated in that space,
//! then back-transformed to the data distribution (Deutsch & Journel 1998,
//! *GSLIB* §VI.2; Goovaerts 1997 §7.4).
//!
//! The transform is built from the sample: the sorted data values are assigned
//! cumulative probabilities by the Hazen plotting position
//! `pₖ = (k + 0.5) / n` (`k` the 0-based rank), and the score of value `vₖ` is
//! the standard-normal quantile `Φ⁻¹(pₖ)`. Arbitrary values map by **linear
//! interpolation** on the `(value → score)` table; the back-transform inverts the
//! same table. Values (or scores) beyond the sample range clamp to the extreme
//! data value — the standard, safe treatment of the tails for a bounded sample.
//!
//! `Φ`/`Φ⁻¹` come from `statrs` (already a dependency); no third-party
//! geostatistics code was consulted.

use crate::foundation::{AlgoError, Result};
use statrs::distribution::{ContinuousCDF, Normal as StatrsNormal};

/// A fitted normal-score transform: the paired, ascending `(value, score)`
/// tables that map data ⇄ standard-normal scores. Build with
/// [`NormalScore::fit`].
#[derive(Debug, Clone, PartialEq)]
pub struct NormalScore {
    /// Ascending distinct data values (the transform knots).
    values: Vec<f64>,
    /// Standard-normal score at each knot (ascending, same length as `values`).
    scores: Vec<f64>,
}

impl NormalScore {
    /// Fit the transform to `data`. Coincident (tied) values are merged to a
    /// single knot carrying the mean of their scores, keeping the map strictly
    /// monotone and invertible. Errors on empty input.
    pub fn fit(data: &[f64]) -> Result<NormalScore> {
        if data.is_empty() {
            return Err(AlgoError::EmptyInput("NormalScore::fit: no data"));
        }
        let snorm = StatrsNormal::new(0.0, 1.0).expect("standard normal");
        let n = data.len();

        let mut sorted: Vec<f64> = data.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        // Rank → score for every element (Hazen plotting position).
        let all_scores: Vec<f64> = (0..n)
            .map(|k| snorm.inverse_cdf((k as f64 + 0.5) / n as f64))
            .collect();

        // Merge ties: one knot per distinct value, its score the mean of the
        // scores of the tied ranks.
        let mut values = Vec::new();
        let mut scores = Vec::new();
        let mut k = 0;
        while k < n {
            let v = sorted[k];
            let mut j = k;
            let mut score_sum = 0.0;
            while j < n && sorted[j] == v {
                score_sum += all_scores[j];
                j += 1;
            }
            values.push(v);
            scores.push(score_sum / (j - k) as f64);
            k = j;
        }
        Ok(NormalScore { values, scores })
    }

    /// Forward transform: data `value` → standard-normal score (piecewise-linear
    /// on the fitted knots; clamped at the data extremes).
    pub fn forward(&self, value: f64) -> f64 {
        interp(&self.values, &self.scores, value)
    }

    /// Back-transform: standard-normal `score` → data value (the inverse of
    /// [`forward`](Self::forward); clamped at the score extremes).
    pub fn back(&self, score: f64) -> f64 {
        interp(&self.scores, &self.values, score)
    }

    /// The score of the smallest / largest datum (the clamp limits).
    pub fn score_bounds(&self) -> (f64, f64) {
        (self.scores[0], self.scores[self.scores.len() - 1])
    }
}

/// Piecewise-linear interpolation of `ys` over ascending knots `xs` at `x`,
/// clamped to `ys` at the ends. `xs`/`ys` are equal-length and non-empty.
fn interp(xs: &[f64], ys: &[f64], x: f64) -> f64 {
    let n = xs.len();
    if n == 1 || x <= xs[0] {
        return ys[0];
    }
    if x >= xs[n - 1] {
        return ys[n - 1];
    }
    // Binary search for the bracketing knot.
    let mut lo = 0;
    let mut hi = n - 1;
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if xs[mid] <= x {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let t = (x - xs[lo]) / (xs[hi] - xs[lo]);
    ys[lo] + t * (ys[hi] - ys[lo])
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn empty_errors() {
        assert!(matches!(
            NormalScore::fit(&[]),
            Err(AlgoError::EmptyInput(_))
        ));
    }

    #[test]
    fn round_trips_the_data_values() {
        let data = [3.0, 1.0, 4.0, 1.5, 9.0, 2.6];
        let ns = NormalScore::fit(&data).unwrap();
        for &v in &data {
            let back = ns.back(ns.forward(v));
            assert_relative_eq!(back, v, epsilon = 1e-9);
        }
    }

    #[test]
    fn scores_are_symmetric_for_symmetric_ranks() {
        // With n even and distinct values, the score set is symmetric about 0,
        // so the mean score is ~0 and the median maps near 0.
        let data: Vec<f64> = (1..=100).map(|v| v as f64).collect();
        let ns = NormalScore::fit(&data).unwrap();
        let mean_score: f64 = data.iter().map(|&v| ns.forward(v)).sum::<f64>() / data.len() as f64;
        assert!(mean_score.abs() < 1e-9, "mean score {mean_score} not ~0");
    }

    #[test]
    fn monotone_forward() {
        let data = [10.0, 20.0, 30.0, 40.0, 50.0];
        let ns = NormalScore::fit(&data).unwrap();
        let mut prev = f64::NEG_INFINITY;
        for v in [5.0, 12.0, 25.0, 33.0, 48.0, 60.0] {
            let s = ns.forward(v);
            assert!(s >= prev, "not monotone at {v}");
            prev = s;
        }
    }

    #[test]
    fn tails_clamp_to_extremes() {
        let data = [1.0, 2.0, 3.0];
        let ns = NormalScore::fit(&data).unwrap();
        let (lo, hi) = ns.score_bounds();
        assert_eq!(ns.forward(-100.0), lo);
        assert_eq!(ns.forward(100.0), hi);
        assert_eq!(ns.back(-100.0), 1.0); // below smallest score → smallest value
        assert_eq!(ns.back(100.0), 3.0);
    }

    #[test]
    fn handles_ties() {
        let data = [5.0, 5.0, 5.0, 1.0, 9.0];
        let ns = NormalScore::fit(&data).unwrap();
        // Round-trip still works and 5.0 maps to a single stable score.
        let s = ns.forward(5.0);
        assert_relative_eq!(ns.back(s), 5.0, epsilon = 1e-9);
    }
}
