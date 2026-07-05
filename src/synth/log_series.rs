//! **Zone-conformant synthetic log series** — one continuous, depth-autocorrelated
//! petrophysical curve (porosity / net-to-gross / water saturation) whose target
//! `{mean, std}` shifts from zone to zone, staying strictly inside `[0, 1]`.
//!
//! A [`ZoneSpec`] stack is turned into a single log by:
//!
//! 1. drawing **one continuous** AR(1) standard-normal driver over the whole
//!    depth range ([`correlated_gaussian`]), its per-step correlation length taken
//!    from the zone each sample sits in — so continuity carries *across* boundaries
//!    (no artificial jump in the underlying field, only the statistics change);
//! 2. mapping each sample through its zone's moment-matched [`LogitNormal`]
//!    transform, so every zone hits its target mean/std within sampling tolerance
//!    and no value ever leaves `[0, 1]`;
//! 3. optionally **blending** the transform across a boundary over
//!    `transition_beds` samples, so the statistics ramp rather than step (a bed or
//!    two of graded transition).
//!
//! The result is the believable thing white noise cannot fake: a curve that
//! *remembers* its recent depth, with a spread and level that honour each zone's
//! petrophysics. Derived from the AR(1) + logit-normal maths in the sibling
//! modules; no third-party code was consulted.

use crate::foundation::{AlgoError, Result};
use crate::sampling::seeded_rng;
use crate::synth::correlated::{ar1_phi, correlated_gaussian};
use crate::synth::transform::LogitNormal;

/// One zone's petrophysical target for a synthetic log: a thickness, the target
/// marginal `{mean, std}` of the (bounded, `[0,1]`) property, and the depth
/// autocorrelation length that sets bed-scale continuity.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ZoneSpec {
    /// Zone thickness in metres (`> 0`).
    pub thickness_m: f64,
    /// Target mean of the property in the zone (`0 < mean < 1`).
    pub mean: f64,
    /// Target standard deviation (`0 < std`, and `std² < mean·(1−mean)`).
    pub std: f64,
    /// Depth autocorrelation length in metres (`> 0`) — the e-folding length of
    /// the vertical continuity (bed scale).
    pub corr_length_m: f64,
}

impl ZoneSpec {
    /// Build and validate a zone spec. Errors ([`AlgoError::InvalidArgument`])
    /// unless `thickness_m > 0`, `corr_length_m > 0`, `0 < mean < 1`, `std > 0`,
    /// and the target is feasible for a `[0,1]` variable (`std² < mean·(1−mean)`).
    pub fn new(thickness_m: f64, mean: f64, std: f64, corr_length_m: f64) -> Result<ZoneSpec> {
        if !(thickness_m.is_finite() && thickness_m > 0.0) {
            return Err(AlgoError::InvalidArgument(
                "ZoneSpec: thickness_m must be finite and > 0".to_string(),
            ));
        }
        if !(corr_length_m.is_finite() && corr_length_m > 0.0) {
            return Err(AlgoError::InvalidArgument(
                "ZoneSpec: corr_length_m must be finite and > 0".to_string(),
            ));
        }
        // Feasibility of the moment target is validated by constructing the
        // transform (0<mean<1, std>0, std² < mean(1-mean)).
        LogitNormal::match_moments(mean, std)?;
        Ok(ZoneSpec {
            thickness_m,
            mean,
            std,
            corr_length_m,
        })
    }
}

/// Number of depth samples in a zone of `thickness_m` at `depth_step` (at least 1).
fn zone_samples(thickness_m: f64, depth_step: f64) -> usize {
    ((thickness_m / depth_step).round() as usize).max(1)
}

/// The per-zone sample counts of a stack at `depth_step` — the depth layout the
/// series (and any co-generated curve) shares. `depth_step` must be `> 0`.
pub fn zone_sample_counts(zones: &[ZoneSpec], depth_step: f64) -> Vec<usize> {
    zones
        .iter()
        .map(|z| zone_samples(z.thickness_m, depth_step))
        .collect()
}

/// Generate one continuous, depth-autocorrelated log series over the [`ZoneSpec`]
/// stack, sampled every `depth_step` metres (top of the stack first).
///
/// Each zone hits its target `{mean, std}` (within sampling tolerance) with values
/// strictly inside `[0, 1]`; the vertical continuity follows each zone's
/// correlation length. `transition_beds` blends the transform across each internal
/// boundary over that many samples on either side (`0` ⇒ hard boundaries); it
/// should stay small relative to the zone thicknesses.
///
/// Returns the series (length `Σ zone_sample_counts`). Errors on an empty stack or
/// a non-positive `depth_step`. Bit-reproducible per `seed`.
pub fn synth_log_series(
    zones: &[ZoneSpec],
    depth_step: f64,
    transition_beds: usize,
    seed: u64,
) -> Result<Vec<f64>> {
    if zones.is_empty() {
        return Err(AlgoError::EmptyInput("synth_log_series: empty zone stack"));
    }
    if !(depth_step.is_finite() && depth_step > 0.0) {
        return Err(AlgoError::InvalidArgument(
            "synth_log_series: depth_step must be finite and > 0".to_string(),
        ));
    }

    // Depth layout: per-zone sample counts, zone start indices, per-sample zone id.
    let counts = zone_sample_counts(zones, depth_step);
    let n: usize = counts.iter().sum();
    let mut starts = Vec::with_capacity(zones.len());
    let mut zone_of = Vec::with_capacity(n);
    let mut acc = 0usize;
    for (zi, &c) in counts.iter().enumerate() {
        starts.push(acc);
        for _ in 0..c {
            zone_of.push(zi);
        }
        acc += c;
    }

    // One continuous AR(1) driver; per-step correlation length from the sample's
    // zone (use the deeper sample's zone for the step into it).
    let mut rng = seeded_rng(seed);
    let driver = correlated_gaussian(
        n,
        |k| ar1_phi(depth_step, zones[zone_of[k]].corr_length_m),
        &mut rng,
    );

    // Per-zone moment-matched transforms (validated at ZoneSpec::new).
    let transforms: Vec<LogitNormal> = zones
        .iter()
        .map(|z| LogitNormal::match_moments(z.mean, z.std).expect("validated at ZoneSpec::new"))
        .collect();

    // Base pass: each sample through its own zone's transform.
    let mut out: Vec<f64> = (0..n)
        .map(|k| transforms[zone_of[k]].apply(driver[k]))
        .collect();

    // Graded transitions: blend (a, b) across each internal boundary window.
    if transition_beds > 0 {
        let h = transition_beds;
        for b in 1..zones.len() {
            let bidx = starts[b];
            let lo = bidx.saturating_sub(h);
            let hi = (bidx + h).min(n);
            let span = (hi - lo) as f64;
            if span <= 0.0 {
                continue;
            }
            for k in lo..hi {
                let t = (k - lo) as f64 / span; // 0 (upper zone) → 1 (lower zone)
                let blended = transforms[b - 1].lerp(&transforms[b], t);
                out[k] = blended.apply(driver[k]);
            }
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stats::{mean, std_dev};
    use crate::synth::correlated::lag1_autocorr;

    fn zones() -> Vec<ZoneSpec> {
        vec![
            ZoneSpec::new(20.0, 0.10, 0.03, 4.0).unwrap(),
            ZoneSpec::new(30.0, 0.24, 0.04, 6.0).unwrap(),
            ZoneSpec::new(15.0, 0.08, 0.02, 3.0).unwrap(),
            ZoneSpec::new(25.0, 0.18, 0.05, 5.0).unwrap(),
        ]
    }

    #[test]
    fn empty_and_bad_args_error() {
        assert!(synth_log_series(&[], 0.5, 0, 1).is_err());
        assert!(synth_log_series(&zones(), 0.0, 0, 1).is_err());
        assert!(synth_log_series(&zones(), -1.0, 0, 1).is_err());
    }

    #[test]
    fn length_matches_layout() {
        let z = zones();
        let s = synth_log_series(&z, 0.5, 0, 1).unwrap();
        let expect: usize = zone_sample_counts(&z, 0.5).iter().sum();
        assert_eq!(s.len(), expect);
    }

    #[test]
    fn bit_reproducible() {
        let z = zones();
        let a = synth_log_series(&z, 0.25, 2, 2026).unwrap();
        let b = synth_log_series(&z, 0.25, 2, 2026).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn bounds_never_violated() {
        for seed in 0..5u64 {
            let s = synth_log_series(&zones(), 0.25, 1, seed).unwrap();
            assert!(s.iter().all(|&v| v > 0.0 && v < 1.0), "out of (0,1)");
        }
    }

    #[test]
    fn each_zone_hits_target_moments_across_seeds() {
        // Per-zone mean/std should track the spec, averaged over seeds (hard
        // boundaries so each zone's samples are pure).
        let z = zones();
        let depth_step = 0.25;
        let counts = zone_sample_counts(&z, depth_step);
        let seeds = [1u64, 2, 3, 4, 5, 6, 7, 8];
        for (zi, spec) in z.iter().enumerate() {
            let start: usize = counts[..zi].iter().sum();
            let end = start + counts[zi];
            let mut mbar = 0.0;
            let mut sbar = 0.0;
            for &seed in &seeds {
                let s = synth_log_series(&z, depth_step, 0, seed).unwrap();
                let seg = &s[start..end];
                mbar += mean(seg).unwrap();
                sbar += std_dev(seg).unwrap();
            }
            mbar /= seeds.len() as f64;
            sbar /= seeds.len() as f64;
            assert!(
                (mbar - spec.mean).abs() < 0.02,
                "zone {zi} mean {mbar} vs {}",
                spec.mean
            );
            assert!(
                (sbar - spec.std).abs() < 0.02,
                "zone {zi} std {sbar} vs {}",
                spec.std
            );
        }
    }

    #[test]
    fn autocorrelation_length_recovered() {
        // A single thick zone: the output series' lag-1 autocorrelation should
        // recover the AR(1) phi from the spec's correlation length (±, allowing
        // for the mild attenuation of the monotone transform).
        let depth_step = 0.5;
        let corr = 10.0;
        let z = vec![ZoneSpec::new(400.0, 0.25, 0.05, corr).unwrap()];
        let phi = ar1_phi(depth_step, corr);
        let mut rbar = 0.0;
        let seeds = [10u64, 20, 30, 40];
        for &seed in &seeds {
            let s = synth_log_series(&z, depth_step, 0, seed).unwrap();
            rbar += lag1_autocorr(&s);
        }
        rbar /= seeds.len() as f64;
        // e-folding length from the recovered lag-1 correlation, within ±20%.
        let recovered_len = -depth_step / rbar.ln();
        assert!(
            (recovered_len - corr).abs() / corr < 0.2,
            "recovered corr length {recovered_len} vs {corr} (phi {phi}, r {rbar})"
        );
    }
}
