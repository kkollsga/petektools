//! `aggregate` — sum per-segment realization vectors into a total, under a
//! chosen **dependence** assumption between the segments.
//!
//! An appraisal often models several segments/zones separately, producing one
//! realization vector per segment (e.g. each segment's STOIIP over `N` Monte-Carlo
//! trials). The field total is their sum — but *how* the segments co-vary sets the
//! spread of that total, so the sum is taken under an explicit [`Correlation`].
//!
//! Segments are combined index-wise, so a shorter segment truncates the result:
//! the output length is the **shortest** segment's length (all segments should
//! carry the same trial count `N`; a mismatch is treated as "use the common
//! prefix"). An empty segment list — or any empty segment — yields an empty `Vec`.

/// The dependence assumption used when summing segment realizations.
///
/// `#[non_exhaustive]`: a rank-correlation variant (`Rank(rho)` — an
/// Iman–Conover / rank-reordering coupling to a target Spearman ρ) is the planned
/// next member and will be additive when it lands.
#[derive(Debug, Clone, Copy, PartialEq)]
#[non_exhaustive]
pub enum Correlation {
    /// **Independent** segments: sum index-wise, `total[i] = Σ_s segment_s[i]`.
    ///
    /// This is the *sum of independently-ordered draws* — it preserves
    /// independence **only if** each segment vector is itself an independent
    /// draw order (the usual case when every segment was sampled from its own
    /// seeded Monte-Carlo stream, so trial `i` pairs one independent draw from
    /// each segment). If two segment vectors happen to share an induced ordering,
    /// pass independently-permuted copies first — no reshuffle is done here (this
    /// function is deterministic and RNG-free).
    Independent,
    /// **Comonotonic** (perfect positive rank dependence): each segment is sorted
    /// ascending, then summed rank-for-rank — `total[k] = Σ_s sorted(segment_s)[k]`.
    /// The total's P90/P50/P10 are then the per-segment percentiles added
    /// straight across (the conservative "everything low together / high
    /// together" bound used for a fully-dependent aggregation).
    Comonotonic,
}

/// Aggregate per-segment realization vectors into a single total vector under
/// `corr` (see [`Correlation`] for the precise per-mode semantics).
///
/// The result length is the shortest segment's length; an empty input (or any
/// empty segment) gives an empty `Vec`.
pub fn aggregate(segments: &[&[f64]], corr: Correlation) -> Vec<f64> {
    let n = match segments.iter().map(|s| s.len()).min() {
        Some(n) if n > 0 && !segments.is_empty() => n,
        _ => return Vec::new(),
    };

    match corr {
        Correlation::Independent => {
            let mut total = vec![0.0_f64; n];
            for seg in segments {
                for (t, v) in total.iter_mut().zip(seg.iter()) {
                    *t += *v;
                }
            }
            total
        }
        Correlation::Comonotonic => {
            let mut total = vec![0.0_f64; n];
            for seg in segments {
                let mut sorted: Vec<f64> = seg[..n].to_vec();
                sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                for (t, v) in total.iter_mut().zip(sorted.iter()) {
                    *t += *v;
                }
            }
            total
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_inputs_give_empty() {
        assert!(aggregate(&[], Correlation::Independent).is_empty());
        let empty: &[f64] = &[];
        assert!(aggregate(&[empty], Correlation::Comonotonic).is_empty());
    }

    #[test]
    fn independent_is_index_wise_sum() {
        let a = [1.0, 2.0, 3.0];
        let b = [10.0, 20.0, 30.0];
        let out = aggregate(&[&a, &b], Correlation::Independent);
        assert_eq!(out, vec![11.0, 22.0, 33.0]);
    }

    #[test]
    fn comonotonic_sums_by_rank() {
        // Same data as independent but scrambled orders; comonotonic sorts each
        // segment first, so it sums the matching ranks regardless of input order.
        let a = [3.0, 1.0, 2.0];
        let b = [10.0, 30.0, 20.0];
        let out = aggregate(&[&a, &b], Correlation::Comonotonic);
        // sorted(a) = [1,2,3], sorted(b) = [10,20,30] -> [11,22,33]
        assert_eq!(out, vec![11.0, 22.0, 33.0]);
    }

    #[test]
    fn comonotonic_widens_the_spread_vs_independent() {
        // Anti-aligned segments: independent cancels, comonotonic reinforces, so
        // the comonotonic total has the larger range (perfect-correlation bound).
        let a = [1.0, 2.0, 3.0, 4.0];
        let b = [4.0, 3.0, 2.0, 1.0];
        let ind = aggregate(&[&a, &b], Correlation::Independent);
        let com = aggregate(&[&a, &b], Correlation::Comonotonic);
        let range = |v: &[f64]| {
            v.iter().cloned().fold(f64::MIN, f64::max) - v.iter().cloned().fold(f64::MAX, f64::min)
        };
        assert_eq!(ind, vec![5.0, 5.0, 5.0, 5.0]); // independent cancels to flat
        assert!(range(&com) > range(&ind));
    }

    #[test]
    fn ragged_segments_truncate_to_shortest() {
        let a = [1.0, 2.0, 3.0, 4.0];
        let b = [10.0, 20.0];
        let out = aggregate(&[&a, &b], Correlation::Independent);
        assert_eq!(out, vec![11.0, 22.0]);
    }
}
