//! Unweighted descriptive statistics — a thin, validated front-door over
//! [`statrs`](https://docs.rs/statrs)'s `Statistics` / `OrderStatistics`.
//!
//! petekTools does not reimplement the moments; it curates `statrs` behind a
//! small, opinionated surface that returns a [`Result`] on empty / out-of-range
//! input instead of panicking, and speaks plain `&[f64]`.
//!
//! **Percentiles use the type-7 definition** (Hyndman, R.J. & Fan, Y. (1996),
//! *Sample Quantiles in Statistical Packages*, The American Statistician
//! 50(4)): linear interpolation of the order statistics at rank `p·(n−1)`
//! (0-based). This is the definition Excel's `PERCENTILE` and R's default
//! `quantile` use — chosen deliberately because this crate's audience
//! cross-checks against Excel. (`statrs`'s `OrderStatistics::quantile` is
//! type-8, so the type-7 percentile is implemented here directly rather than
//! delegated.)

use crate::foundation::{AlgoError, Result};
use statrs::statistics::Statistics;

/// Arithmetic mean of `data`. Errors on empty input.
pub fn mean(data: &[f64]) -> Result<f64> {
    non_empty(data)?;
    Ok(data.iter().mean())
}

/// Unbiased sample variance (`n − 1` denominator) of `data`. Errors on empty
/// input; a single value yields `0.0`.
pub fn variance(data: &[f64]) -> Result<f64> {
    non_empty(data)?;
    if data.len() == 1 {
        return Ok(0.0);
    }
    Ok(data.iter().variance())
}

/// Unbiased sample standard deviation (`√variance`) of `data`. Errors on empty
/// input; a single value yields `0.0`.
pub fn std_dev(data: &[f64]) -> Result<f64> {
    Ok(variance(data)?.sqrt())
}

/// The `p`-th percentile of `data` (`p` in `[0, 100]`), by the **type-7**
/// definition (Hyndman & Fan 1996): linear interpolation of the sorted order
/// statistics at rank `p·(n−1)` (0-based). `percentile(_, 0) = min`,
/// `percentile(_, 100) = max`, and `percentile([1,2,3,4,5], 25) = 2.0` —
/// matching Excel's `PERCENTILE` and R's default `quantile`. Errors on empty
/// input or `p` outside `[0, 100]`.
pub fn percentile(data: &[f64], p: f64) -> Result<f64> {
    non_empty(data)?;
    if !(0.0..=100.0).contains(&p) {
        return Err(AlgoError::InvalidArgument(
            "percentile: p must be in [0, 100]".to_string(),
        ));
    }
    // Sort ascending (NaNs, if any, sort last and are not expected here).
    let mut sorted = data.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = sorted.len();
    if n == 1 {
        return Ok(sorted[0]);
    }
    // Type-7: 0-based rank h = p·(n−1); interpolate between ⌊h⌋ and ⌈h⌉.
    let rank = (p / 100.0) * (n - 1) as f64;
    let lo = rank.floor() as usize;
    if lo + 1 >= n {
        return Ok(sorted[n - 1]); // p == 100 (or floating-point at the top edge)
    }
    let frac = rank - lo as f64;
    Ok(sorted[lo] + frac * (sorted[lo + 1] - sorted[lo]))
}

/// The median (50th percentile) of `data`. Errors on empty input.
pub fn median(data: &[f64]) -> Result<f64> {
    percentile(data, 50.0)
}

fn non_empty(data: &[f64]) -> Result<()> {
    if data.is_empty() {
        return Err(AlgoError::EmptyInput("stats: no data"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn empty_errors() {
        assert!(matches!(mean(&[]), Err(AlgoError::EmptyInput(_))));
        assert!(matches!(variance(&[]), Err(AlgoError::EmptyInput(_))));
        assert!(matches!(
            percentile(&[], 50.0),
            Err(AlgoError::EmptyInput(_))
        ));
    }

    #[test]
    fn mean_variance_std_known_values() {
        let d = [2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0];
        assert_relative_eq!(mean(&d).unwrap(), 5.0, epsilon = 1e-12);
        // Sample variance (n−1): sum of squared dev = 32, /7 ≈ 4.5714…
        assert_relative_eq!(variance(&d).unwrap(), 32.0 / 7.0, epsilon = 1e-12);
        assert_relative_eq!(
            std_dev(&d).unwrap(),
            (32.0f64 / 7.0).sqrt(),
            epsilon = 1e-12
        );
    }

    #[test]
    fn single_value_has_zero_spread() {
        assert_eq!(variance(&[3.0]).unwrap(), 0.0);
        assert_eq!(std_dev(&[3.0]).unwrap(), 0.0);
        assert_eq!(mean(&[3.0]).unwrap(), 3.0);
    }

    #[test]
    fn percentile_endpoints_and_median() {
        let d = [1.0, 2.0, 3.0, 4.0, 5.0];
        assert_relative_eq!(percentile(&d, 0.0).unwrap(), 1.0, epsilon = 1e-12);
        assert_relative_eq!(percentile(&d, 100.0).unwrap(), 5.0, epsilon = 1e-12);
        assert_relative_eq!(median(&d).unwrap(), 3.0, epsilon = 1e-12);
    }

    #[test]
    fn percentile_is_true_type7_excel_parity() {
        // Type-7 (Hyndman & Fan 1996) = Excel PERCENTILE / R default quantile.
        // rank = p·(n−1) on 0-based order statistics.
        let d = [1.0, 2.0, 3.0, 4.0, 5.0];
        assert_relative_eq!(percentile(&d, 25.0).unwrap(), 2.0, epsilon = 1e-12);
        assert_relative_eq!(percentile(&d, 50.0).unwrap(), 3.0, epsilon = 1e-12);
        assert_relative_eq!(percentile(&d, 75.0).unwrap(), 4.0, epsilon = 1e-12);
        // Interpolated case: [1,2,3,4], p=25 → rank 0.75 → 1 + 0.75·(2−1) = 1.75.
        let e = [1.0, 2.0, 3.0, 4.0];
        assert_relative_eq!(percentile(&e, 25.0).unwrap(), 1.75, epsilon = 1e-12);
        // Unsorted input is handled (sorted internally).
        let f = [5.0, 1.0, 3.0, 2.0, 4.0];
        assert_relative_eq!(percentile(&f, 25.0).unwrap(), 2.0, epsilon = 1e-12);
    }

    #[test]
    fn percentile_rejects_out_of_range() {
        assert!(percentile(&[1.0, 2.0], -1.0).is_err());
        assert!(percentile(&[1.0, 2.0], 101.0).is_err());
    }

    #[test]
    fn percentile_is_monotone_in_p() {
        let d = [10.0, 3.0, 7.0, 1.0, 9.0, 4.0];
        let mut prev = f64::NEG_INFINITY;
        for p in [0.0, 10.0, 25.0, 50.0, 75.0, 90.0, 100.0] {
            let q = percentile(&d, p).unwrap();
            assert!(q >= prev - 1e-12, "not monotone at p={p}: {q} < {prev}");
            prev = q;
        }
    }
}
