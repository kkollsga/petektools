//! Weighted descriptive statistics — the part `statrs` does not provide.
//!
//! Reliability weights `wᵢ ≥ 0` (not all zero). Definitions:
//! - weighted mean: `μ_w = Σ wᵢ xᵢ / Σ wᵢ`;
//! - weighted variance (unbiased under reliability weights):
//!   `s²_w = Σ wᵢ (xᵢ − μ_w)² / (V₁ − V₂/V₁)` with `V₁ = Σ wᵢ`, `V₂ = Σ wᵢ²`
//!   — the standard reliability-weight correction that reduces to the ordinary
//!   `n − 1` sample variance when all weights are equal;
//! - weighted percentile: linear interpolation on the cumulative-weight CDF.
//!
//! References: standard weighted-statistics definitions, e.g. the GNU Scientific
//! Library `gsl_stats_wvariance`; and the cumulative-weight quantile used widely
//! in survey/Monte-Carlo post-processing.

use crate::foundation::{AlgoError, Result};

/// Weighted mean `Σ wᵢ xᵢ / Σ wᵢ`.
///
/// Errors on empty input, on a `values`/`weights` length mismatch, on any
/// negative weight, or when the weights sum to zero.
pub fn weighted_mean(values: &[f64], weights: &[f64]) -> Result<f64> {
    let (v1, _v2) = validate(values, weights)?;
    let dot: f64 = values.iter().zip(weights).map(|(x, w)| w * x).sum();
    Ok(dot / v1)
}

/// Unbiased weighted variance under reliability weights (see the module docs).
///
/// Errors as [`weighted_mean`]; additionally yields `0.0` when the effective
/// degrees of freedom collapse (e.g. all weight on a single sample).
pub fn weighted_variance(values: &[f64], weights: &[f64]) -> Result<f64> {
    let (v1, v2) = validate(values, weights)?;
    let mu = weighted_mean(values, weights)?;
    let ss: f64 = values
        .iter()
        .zip(weights)
        .map(|(x, w)| w * (x - mu) * (x - mu))
        .sum();
    let denom = v1 - v2 / v1;
    if denom <= 0.0 {
        return Ok(0.0);
    }
    Ok(ss / denom)
}

/// Weighted standard deviation (`√weighted_variance`).
pub fn weighted_std_dev(values: &[f64], weights: &[f64]) -> Result<f64> {
    Ok(weighted_variance(values, weights)?.sqrt())
}

/// The weighted `p`-th percentile (`p` in `[0, 100]`), by linear interpolation
/// on the cumulative-weight CDF.
///
/// Points are sorted by value; each point `i` is placed at the *centre* of its
/// weight interval, `cᵢ = (Wᵢ₋₁ + wᵢ/2) / Σw`, and the result is a linear
/// interpolation of the value against the target `p/100`. `p = 0` → min value,
/// `p = 100` → max value. Errors as [`weighted_mean`], or on `p` outside
/// `[0, 100]`.
///
/// **Convention note.** This is the centre-of-weight-interval definition, which
/// is *not* the type-7 rule used by the unweighted [`percentile`](super::percentile):
/// even at equal weights the two need not coincide (e.g. `[1,2,3,4,5]` at
/// `p = 25` gives `1.75` here versus type-7's `2.0`). Use the unweighted
/// `percentile` when Excel `PERCENTILE` parity matters; use this when the
/// samples carry reliability weights.
pub fn weighted_percentile(values: &[f64], weights: &[f64], p: f64) -> Result<f64> {
    let (v1, _v2) = validate(values, weights)?;
    if !(0.0..=100.0).contains(&p) {
        return Err(AlgoError::InvalidArgument(
            "weighted_percentile: p must be in [0, 100]".to_string(),
        ));
    }

    // Sort (value, weight) by value.
    let mut pairs: Vec<(f64, f64)> = values
        .iter()
        .copied()
        .zip(weights.iter().copied())
        .collect();
    pairs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    // Centred cumulative-weight positions in [0, 1].
    let mut positions = Vec::with_capacity(pairs.len());
    let mut running = 0.0;
    for &(_, w) in &pairs {
        positions.push((running + w / 2.0) / v1);
        running += w;
    }

    let target = p / 100.0;
    // Below the first / above the last centre → clamp to the extreme value.
    if target <= positions[0] {
        return Ok(pairs[0].0);
    }
    if target >= *positions.last().unwrap() {
        return Ok(pairs.last().unwrap().0);
    }
    // Linear interpolation between the bracketing points.
    for k in 1..pairs.len() {
        if target <= positions[k] {
            let (p0, p1) = (positions[k - 1], positions[k]);
            let (v0, v1v) = (pairs[k - 1].0, pairs[k].0);
            let t = if p1 > p0 {
                (target - p0) / (p1 - p0)
            } else {
                0.0
            };
            return Ok(v0 + t * (v1v - v0));
        }
    }
    Ok(pairs.last().unwrap().0)
}

/// Validate a `(values, weights)` pair; return `(Σw, Σw²)`.
fn validate(values: &[f64], weights: &[f64]) -> Result<(f64, f64)> {
    if values.is_empty() {
        return Err(AlgoError::EmptyInput("weighted stats: no data"));
    }
    if values.len() != weights.len() {
        return Err(AlgoError::InvalidArgument(
            "weighted stats: values and weights differ in length".to_string(),
        ));
    }
    if weights.iter().any(|&w| w < 0.0 || !w.is_finite()) {
        return Err(AlgoError::InvalidArgument(
            "weighted stats: weights must be finite and non-negative".to_string(),
        ));
    }
    let v1: f64 = weights.iter().sum();
    let v2: f64 = weights.iter().map(|w| w * w).sum();
    if v1 <= 0.0 {
        return Err(AlgoError::InvalidArgument(
            "weighted stats: weights sum to zero".to_string(),
        ));
    }
    Ok((v1, v2))
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn equal_weights_match_unweighted() {
        let d = [2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0];
        let w = vec![1.0; d.len()];
        assert_relative_eq!(
            weighted_mean(&d, &w).unwrap(),
            super::super::mean(&d).unwrap(),
            epsilon = 1e-12
        );
        // With equal weights the reliability-weight correction reduces to n−1.
        assert_relative_eq!(
            weighted_variance(&d, &w).unwrap(),
            super::super::variance(&d).unwrap(),
            epsilon = 1e-9
        );
    }

    #[test]
    fn weighted_mean_known_value() {
        // 10 with weight 3, 20 with weight 1 -> (30+20)/4 = 12.5
        assert_relative_eq!(
            weighted_mean(&[10.0, 20.0], &[3.0, 1.0]).unwrap(),
            12.5,
            epsilon = 1e-12
        );
    }

    #[test]
    fn zero_weight_point_is_ignored() {
        let a = weighted_mean(&[10.0, 20.0, 999.0], &[1.0, 1.0, 0.0]).unwrap();
        assert_relative_eq!(a, 15.0, epsilon = 1e-12);
    }

    #[test]
    fn validation_errors() {
        assert!(matches!(
            weighted_mean(&[], &[]),
            Err(AlgoError::EmptyInput(_))
        ));
        assert!(weighted_mean(&[1.0, 2.0], &[1.0]).is_err()); // length mismatch
        assert!(weighted_mean(&[1.0, 2.0], &[1.0, -1.0]).is_err()); // negative weight
        assert!(weighted_mean(&[1.0, 2.0], &[0.0, 0.0]).is_err()); // zero total
    }

    #[test]
    fn weighted_percentile_endpoints_and_monotone() {
        let v = [1.0, 5.0, 2.0, 4.0, 3.0];
        let w = [1.0, 1.0, 1.0, 1.0, 1.0];
        assert_relative_eq!(
            weighted_percentile(&v, &w, 0.0).unwrap(),
            1.0,
            epsilon = 1e-12
        );
        assert_relative_eq!(
            weighted_percentile(&v, &w, 100.0).unwrap(),
            5.0,
            epsilon = 1e-12
        );
        let mut prev = f64::NEG_INFINITY;
        for p in [0.0, 20.0, 50.0, 80.0, 100.0] {
            let q = weighted_percentile(&v, &w, p).unwrap();
            assert!(q >= prev - 1e-12, "not monotone at p={p}");
            prev = q;
        }
    }

    #[test]
    fn dominant_weight_pulls_the_median() {
        // A single heavily-weighted value dominates the weighted median.
        let v = [1.0, 2.0, 100.0];
        let w = [1.0, 1.0, 50.0];
        let m = weighted_percentile(&v, &w, 50.0).unwrap();
        assert!(
            m > 50.0,
            "median {m} should be pulled toward the heavy point"
        );
    }
}
