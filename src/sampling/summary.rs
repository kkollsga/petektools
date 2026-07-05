//! `reservoir_summary` — the oil-industry P90/P50/P10 digest of a realization set.
//!
//! ## The P90 = low convention (documented once, here)
//!
//! Petroleum reserves reporting names percentiles by their **probability of
//! exceedance**, which is the *reverse* of the statistical (probability of
//! non-exceedance) convention:
//!
//! - **P90 = the low estimate** — the value the realizations exceed 90 % of the
//!   time, i.e. the statistical **10th** percentile.
//! - **P50 = the median** — the statistical 50th percentile.
//! - **P10 = the high estimate** — exceeded only 10 % of the time, i.e. the
//!   statistical **90th** percentile.
//!
//! So `P90 ≤ P50 ≤ P10` (the industry labels read "low ≤ mid ≤ high"). This is
//! the SPE/PRMS convention used across volumetrics and appraisal Monte-Carlo.
//! The percentiles are the crate's own **type-7** ones ([`crate::stats::percentile`],
//! Excel `PERCENTILE` parity), so a summary here reconciles with a spreadsheet.

use crate::foundation::Result;
use crate::stats::{mean, percentile};

/// The P90 (low) / P50 (mid) / P10 (high) / mean digest of a set of realizations.
///
/// The `pXX` fields follow the **oil-industry exceedance convention** — see the
/// [module docs](self): `p90` is the *low* estimate (statistical 10th
/// percentile), `p10` the *high* (statistical 90th). Hence `p90 ≤ p50 ≤ p10`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReservoirSummary {
    /// Low estimate — exceeded 90 % of the time (statistical 10th percentile).
    pub p90: f64,
    /// Median — the statistical 50th percentile.
    pub p50: f64,
    /// High estimate — exceeded 10 % of the time (statistical 90th percentile).
    pub p10: f64,
    /// Arithmetic mean of the realizations.
    pub mean: f64,
}

/// Summarise `data` (one realization per element) into a [`ReservoirSummary`]
/// using the oil-industry P90 = low convention (see the [module docs](self)).
///
/// Errors on empty input (propagated from [`crate::stats`]).
pub fn reservoir_summary(data: &[f64]) -> Result<ReservoirSummary> {
    Ok(ReservoirSummary {
        // Exceedance ↔ statistical percentile is the 100 − p flip.
        p90: percentile(data, 10.0)?,
        p50: percentile(data, 50.0)?,
        p10: percentile(data, 90.0)?,
        mean: mean(data)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::foundation::AlgoError;
    use approx::assert_relative_eq;

    #[test]
    fn empty_errors() {
        assert!(matches!(
            reservoir_summary(&[]),
            Err(AlgoError::EmptyInput(_))
        ));
    }

    #[test]
    fn known_values_follow_exceedance_convention() {
        // 11 evenly-spaced values 1..=11. Type-7 ranks on 0-based order stats:
        //   p=10 -> rank 0.1·10 = 1.0 -> data[1] = 2   (P90, low)
        //   p=50 -> rank 5.0        -> data[5] = 6   (P50)
        //   p=90 -> rank 9.0        -> data[9] = 10  (P10, high)
        //   mean = 6
        let data: Vec<f64> = (1..=11).map(|v| v as f64).collect();
        let s = reservoir_summary(&data).unwrap();
        assert_relative_eq!(s.p90, 2.0, epsilon = 1e-12);
        assert_relative_eq!(s.p50, 6.0, epsilon = 1e-12);
        assert_relative_eq!(s.p10, 10.0, epsilon = 1e-12);
        assert_relative_eq!(s.mean, 6.0, epsilon = 1e-12);
        // The industry ordering: low ≤ mid ≤ high.
        assert!(s.p90 <= s.p50 && s.p50 <= s.p10);
    }

    #[test]
    fn single_realization_collapses_to_that_value() {
        let s = reservoir_summary(&[42.0]).unwrap();
        assert_eq!((s.p90, s.p50, s.p10, s.mean), (42.0, 42.0, 42.0, 42.0));
    }
}
