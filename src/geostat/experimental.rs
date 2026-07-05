//! The **experimental (empirical) variogram** — the raw semivariance-vs-lag cloud
//! binned into regular lag classes, the input a [`Variogram`] model is fitted to.
//!
//! For every ordered pair of data `(i, j)` at areal separation
//! `h = |xᵢ − xⱼ|`, the semivariance contribution is `½ (zᵢ − zⱼ)²`. Grouping
//! pairs into lag bins of width `lag` and averaging gives the classical
//! (Matheron) estimator
//!
//! ```text
//! γ̂(hₖ) = 1 / (2 Nₖ) · Σ_{(i,j) ∈ bin k} (zᵢ − zⱼ)²
//! ```
//!
//! where `Nₖ` is the pair count in bin `k`. This first cut is **omnidirectional**
//! (pairs binned by separation distance only, no azimuth/tolerance windows).
//!
//! Implemented from the primary literature:
//! - Matheron, G. (1962), *Traité de géostatistique appliquée* (the estimator).
//! - Deutsch, C.V. & Journel, A.G. (1998), *GSLIB*, §II.1 (`gam`/`gamv`).
//! - Chilès, J.-P. & Delfiner, P. (2012), *Geostatistics: Modeling Spatial
//!   Uncertainty*, 2nd ed., §2.2 (variogram estimation).
//!
//! No third-party geostatistics code was consulted — the estimator is coded
//! directly from the definition above.

use crate::foundation::{AlgoError, Result};

/// A binned experimental variogram: one entry per non-empty lag class, each
/// carrying the class' **mean pair separation**, its **average semivariance**,
/// and the **pair count** (the weight a fit leans on).
///
/// Produced by [`experimental_variogram`]; consumed by
/// [`Variogram::fit`](crate::Variogram::fit).
#[derive(Debug, Clone, PartialEq)]
pub struct ExperimentalVariogram {
    /// Mean pair separation `h̄ₖ` within each retained lag class.
    pub lags: Vec<f64>,
    /// Average semivariance `γ̂(hₖ)` in each retained lag class.
    pub semivariances: Vec<f64>,
    /// Number of data pairs falling in each retained lag class.
    pub counts: Vec<usize>,
}

impl ExperimentalVariogram {
    /// Number of retained (non-empty) lag classes.
    pub fn len(&self) -> usize {
        self.lags.len()
    }

    /// Whether no lag class was populated (no pairs within `n_lags · lag`).
    pub fn is_empty(&self) -> bool {
        self.lags.is_empty()
    }
}

/// Compute the omnidirectional experimental variogram of `coords` (`[x, y, z]`
/// rows, `z` the value) using `n_lags` bins of width `lag`.
///
/// Bin `k` (`0 ≤ k < n_lags`) collects pairs whose separation `h` falls in
/// `[k·lag, (k+1)·lag)`; the pair at the exact bin edge goes to the upper bin.
/// Pairs farther than `n_lags · lag` are dropped. Empty bins are omitted from
/// the result, so the returned vectors are aligned and hold only populated
/// classes. Each retained class reports the **mean** separation of its pairs
/// (not the bin centre — the GSLIB convention), which fits the model more
/// faithfully on irregular data.
///
/// Errors on fewer than two data (`EmptyInput`) or a non-positive / non-finite
/// `lag` or zero `n_lags` (`InvalidArgument`). Uses the crate `[[f64; 3]]`
/// packed-coordinate convention (value in `z`) for consistency with the gridding
/// and kriging kernels, rather than a separate `values` slice.
pub fn experimental_variogram(
    coords: &[[f64; 3]],
    lag: f64,
    n_lags: usize,
) -> Result<ExperimentalVariogram> {
    if coords.len() < 2 {
        return Err(AlgoError::EmptyInput(
            "experimental_variogram: need at least two data",
        ));
    }
    if !lag.is_finite() || lag <= 0.0 || n_lags == 0 {
        return Err(AlgoError::InvalidArgument(
            "experimental_variogram: need lag > 0 (finite) and n_lags >= 1".to_string(),
        ));
    }

    let mut sum_gamma = vec![0.0_f64; n_lags]; // Σ (zi − zj)²  per bin
    let mut sum_dist = vec![0.0_f64; n_lags]; // Σ h           per bin
    let mut counts = vec![0_usize; n_lags];
    let max_h = lag * n_lags as f64;

    for i in 0..coords.len() {
        let a = &coords[i];
        for b in &coords[i + 1..] {
            let dx = a[0] - b[0];
            let dy = a[1] - b[1];
            let h = (dx * dx + dy * dy).sqrt();
            if h >= max_h {
                continue;
            }
            let k = (h / lag) as usize; // floor; h < max_h so k < n_lags
            let dz = a[2] - b[2];
            sum_gamma[k] += dz * dz;
            sum_dist[k] += h;
            counts[k] += 1;
        }
    }

    let mut lags = Vec::new();
    let mut semivariances = Vec::new();
    let mut kept_counts = Vec::new();
    for k in 0..n_lags {
        let n = counts[k];
        if n == 0 {
            continue;
        }
        lags.push(sum_dist[k] / n as f64);
        semivariances.push(sum_gamma[k] / (2.0 * n as f64));
        kept_counts.push(n);
    }

    Ok(ExperimentalVariogram {
        lags,
        semivariances,
        counts: kept_counts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn errors_on_too_few_data_or_bad_params() {
        assert!(matches!(
            experimental_variogram(&[[0.0, 0.0, 1.0]], 1.0, 5),
            Err(AlgoError::EmptyInput(_))
        ));
        let d = [[0.0, 0.0, 1.0], [1.0, 0.0, 2.0]];
        assert!(experimental_variogram(&d, 0.0, 5).is_err());
        assert!(experimental_variogram(&d, 1.0, 0).is_err());
    }

    #[test]
    fn hand_checked_three_collinear_points() {
        // Points on a line at x = 0, 1, 2 with z = 0, 1, 2.
        // Pairs: (0,1) h=1 dz=1; (1,2) h=1 dz=1; (0,2) h=2 dz=2.
        // lag = 1, n_lags = 3:
        //   bin0 [0,1): no pair (h=1 lands in bin1)
        //   bin1 [1,2): pairs (0,1),(1,2) -> Σdz²=2, N=2, γ = 2/(2·2)=0.5, h̄=1
        //   bin2 [2,3): pair (0,2)       -> Σdz²=4, N=1, γ = 4/(2·1)=2.0, h̄=2
        let d = [[0.0, 0.0, 0.0], [1.0, 0.0, 1.0], [2.0, 0.0, 2.0]];
        let ev = experimental_variogram(&d, 1.0, 3).unwrap();
        assert_eq!(ev.len(), 2); // bin0 empty, dropped
        assert_relative_eq!(ev.lags[0], 1.0, epsilon = 1e-12);
        assert_relative_eq!(ev.semivariances[0], 0.5, epsilon = 1e-12);
        assert_eq!(ev.counts[0], 2);
        assert_relative_eq!(ev.lags[1], 2.0, epsilon = 1e-12);
        assert_relative_eq!(ev.semivariances[1], 2.0, epsilon = 1e-12);
        assert_eq!(ev.counts[1], 1);
    }

    #[test]
    fn pairs_beyond_reach_are_dropped() {
        // Two points 5 apart, but only 2 lag classes of width 1 (max reach 2).
        let d = [[0.0, 0.0, 1.0], [5.0, 0.0, 9.0]];
        let ev = experimental_variogram(&d, 1.0, 2).unwrap();
        assert!(ev.is_empty(), "the lone far pair should fall outside reach");
    }
}
