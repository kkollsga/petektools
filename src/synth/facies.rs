//! **Binary facies (sand/shale) and facies-composed porosity** — thin-bedded
//! believability: the alternation and property contrast that a single smooth
//! curve cannot express.
//!
//! ## Facies by truncated Gaussian
//!
//! A binary sand/shale log is a **truncated Gaussian simulation** (Matheron et al.
//! 1987; Armstrong et al. 2011, *Plurigaussian Simulations in Geosciences*): draw
//! a depth-autocorrelated standard-normal series `Z` (correlation length =
//! `bed_scale_m`) and threshold it,
//!
//! ```text
//!   sand  ⇔  Z > t,   t = Φ⁻¹(1 − NTG)      ⇒  P(sand) = P(Z > t) = NTG
//! ```
//!
//! so the sand **proportion equals NTG** (within sampling tolerance) and the *bed
//! thicknesses* are the level-excursion lengths of an AR(1) process — a realistic,
//! roughly geometric thickness distribution, not the fixed cadence of a square
//! wave. `bed_scale_m` sets the mean bed thickness.
//!
//! ## Porosity composed with facies
//!
//! [`synth_por_with_facies`] draws one continuous AR(1) driver and maps each
//! sample through the **facies-appropriate** moment-matched transform (a high-mean
//! sand porosity vs a low-mean shale porosity). The porosity therefore steps
//! between two believable levels at each bed boundary while varying smoothly
//! *within* a bed — the sand/shale contrast composed onto the thin-bedded
//! architecture. Derived from the cited literature; no third-party code consulted.

use crate::foundation::{AlgoError, Result};
use crate::sampling::seeded_rng;
use crate::synth::correlated::{ar1_phi, correlated_gaussian};
use crate::synth::transform::LogitNormal;
use statrs::distribution::{ContinuousCDF, Normal as StatrsNormal};

/// A binary lithofacies at one depth sample.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Facies {
    /// Reservoir sand (net).
    Sand,
    /// Non-reservoir shale (non-net).
    Shale,
}

impl Facies {
    /// `true` for [`Facies::Sand`].
    pub fn is_sand(self) -> bool {
        matches!(self, Facies::Sand)
    }

    /// Net code: `1` for sand, `0` for shale (the numeric log convention).
    pub fn code(self) -> u8 {
        match self {
            Facies::Sand => 1,
            Facies::Shale => 0,
        }
    }
}

/// A bounded-property `{mean, std}` target (a porosity level for one facies).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MomentSpec {
    /// Target mean (`0 < mean < 1`).
    pub mean: f64,
    /// Target standard deviation (`0 < std`, `std² < mean·(1−mean)`).
    pub std: f64,
}

impl MomentSpec {
    /// Build and validate a moment target (same feasibility rule as [`ZoneSpec`]:
    /// `0 < mean < 1`, `std > 0`, `std² < mean·(1−mean)`).
    ///
    /// [`ZoneSpec`]: crate::synth::ZoneSpec
    pub fn new(mean: f64, std: f64) -> Result<MomentSpec> {
        LogitNormal::match_moments(mean, std)?;
        Ok(MomentSpec { mean, std })
    }
}

/// SplitMix64 finaliser — derive a well-mixed independent seed from `seed`, so a
/// dependent stream decouples from another built with the same nominal seed.
pub(crate) fn mix_seed(seed: u64) -> u64 {
    let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Generate a binary sand/shale series of `n` samples at `depth_step` metres,
/// whose sand proportion equals `ntg_target` (within sampling tolerance) and whose
/// mean bed thickness scales with `bed_scale_m` (the autocorrelation length).
///
/// Errors unless `n ≥ 1`, `depth_step > 0`, `0 < ntg_target < 1`, and
/// `bed_scale_m > 0`. Bit-reproducible per `seed`.
pub fn synth_facies_series(
    n: usize,
    depth_step: f64,
    ntg_target: f64,
    bed_scale_m: f64,
    seed: u64,
) -> Result<Vec<Facies>> {
    if n == 0 {
        return Err(AlgoError::EmptyInput("synth_facies_series: n = 0"));
    }
    if !(depth_step.is_finite() && depth_step > 0.0) {
        return Err(AlgoError::InvalidArgument(
            "synth_facies_series: depth_step must be finite and > 0".to_string(),
        ));
    }
    if !(ntg_target.is_finite()) || ntg_target <= 0.0 || ntg_target >= 1.0 {
        return Err(AlgoError::InvalidArgument(
            "synth_facies_series: need 0 < ntg_target < 1".to_string(),
        ));
    }
    if !(bed_scale_m.is_finite() && bed_scale_m > 0.0) {
        return Err(AlgoError::InvalidArgument(
            "synth_facies_series: bed_scale_m must be finite and > 0".to_string(),
        ));
    }

    let snorm = StatrsNormal::new(0.0, 1.0).expect("standard normal");
    // Threshold so P(Z > t) = ntg_target.
    let t = snorm.inverse_cdf(1.0 - ntg_target);

    let phi = ar1_phi(depth_step, bed_scale_m);
    let mut rng = seeded_rng(seed);
    let z = correlated_gaussian(n, |_| phi, &mut rng);

    Ok(z.into_iter()
        .map(|v| if v > t { Facies::Sand } else { Facies::Shale })
        .collect())
}

/// Compose a porosity series onto a `facies` log: each sample is drawn from the
/// `sand` or `shale` moment target according to its facies, sharing one continuous
/// AR(1) driver (correlation length `corr_length_m`) so porosity varies smoothly
/// within a bed and steps between the two levels at bed boundaries.
///
/// Returns a `[0,1]` porosity series aligned with `facies` (same length). Errors
/// on an empty `facies` or a non-positive `depth_step` / `corr_length_m`.
/// Bit-reproducible per `seed`.
pub fn synth_por_with_facies(
    facies: &[Facies],
    depth_step: f64,
    sand: MomentSpec,
    shale: MomentSpec,
    corr_length_m: f64,
    seed: u64,
) -> Result<Vec<f64>> {
    if facies.is_empty() {
        return Err(AlgoError::EmptyInput("synth_por_with_facies: empty facies"));
    }
    if !(depth_step.is_finite() && depth_step > 0.0) {
        return Err(AlgoError::InvalidArgument(
            "synth_por_with_facies: depth_step must be finite and > 0".to_string(),
        ));
    }
    if !(corr_length_m.is_finite() && corr_length_m > 0.0) {
        return Err(AlgoError::InvalidArgument(
            "synth_por_with_facies: corr_length_m must be finite and > 0".to_string(),
        ));
    }

    let t_sand = LogitNormal::match_moments(sand.mean, sand.std)?;
    let t_shale = LogitNormal::match_moments(shale.mean, shale.std)?;

    let phi = ar1_phi(depth_step, corr_length_m);
    // The porosity driver must be INDEPENDENT of the facies series, or sand
    // samples (a high-driver subset) would bias the sand mean. Mixing the seed
    // decouples this stream from a facies series built with the same nominal
    // `seed` (SplitMix64 finaliser), while staying bit-reproducible.
    let mut rng = seeded_rng(mix_seed(seed));
    let driver = correlated_gaussian(facies.len(), |_| phi, &mut rng);

    Ok(facies
        .iter()
        .zip(driver.iter())
        .map(|(f, &z)| {
            if f.is_sand() {
                t_sand.apply(z)
            } else {
                t_shale.apply(z)
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stats::mean;

    #[test]
    fn bad_args_error() {
        assert!(synth_facies_series(0, 0.5, 0.5, 3.0, 1).is_err());
        assert!(synth_facies_series(10, 0.0, 0.5, 3.0, 1).is_err());
        assert!(synth_facies_series(10, 0.5, 0.0, 3.0, 1).is_err());
        assert!(synth_facies_series(10, 0.5, 1.0, 3.0, 1).is_err());
        assert!(synth_facies_series(10, 0.5, 0.5, 0.0, 1).is_err());
    }

    #[test]
    fn proportion_matches_ntg_across_seeds() {
        let depth_step = 0.25;
        for &ntg in &[0.3_f64, 0.5, 0.7] {
            let mut pbar = 0.0;
            let seeds = [1u64, 2, 3, 4, 5, 6];
            for &seed in &seeds {
                let f = synth_facies_series(4000, depth_step, ntg, 2.0, seed).unwrap();
                let sand = f.iter().filter(|x| x.is_sand()).count() as f64 / f.len() as f64;
                pbar += sand;
            }
            pbar /= seeds.len() as f64;
            assert!(
                (pbar - ntg).abs() < 0.03,
                "sand fraction {pbar} vs ntg {ntg}"
            );
        }
    }

    #[test]
    fn bit_reproducible() {
        let a = synth_facies_series(500, 0.5, 0.6, 3.0, 99).unwrap();
        let b = synth_facies_series(500, 0.5, 0.6, 3.0, 99).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn larger_bed_scale_makes_thicker_beds() {
        // Longer correlation length → fewer facies transitions per unit length.
        let count_flips = |bed: f64| {
            let f = synth_facies_series(4000, 0.25, 0.5, bed, 7).unwrap();
            f.windows(2).filter(|w| w[0] != w[1]).count()
        };
        assert!(
            count_flips(6.0) < count_flips(1.0),
            "thicker beds should flip less"
        );
    }

    #[test]
    fn porosity_contrast_and_bounds() {
        let depth_step = 0.25;
        let facies = synth_facies_series(4000, depth_step, 0.5, 2.0, 5).unwrap();
        let sand = MomentSpec::new(0.26, 0.03).unwrap();
        let shale = MomentSpec::new(0.08, 0.02).unwrap();
        let por = synth_por_with_facies(&facies, depth_step, sand, shale, 1.5, 5).unwrap();

        assert_eq!(por.len(), facies.len());
        assert!(por.iter().all(|&v| v > 0.0 && v < 1.0), "bounds violated");

        // Mean porosity in sand should exceed that in shale (the contrast).
        let sand_por: Vec<f64> = por
            .iter()
            .zip(&facies)
            .filter(|(_, f)| f.is_sand())
            .map(|(&p, _)| p)
            .collect();
        let shale_por: Vec<f64> = por
            .iter()
            .zip(&facies)
            .filter(|(_, f)| !f.is_sand())
            .map(|(&p, _)| p)
            .collect();
        let ms = mean(&sand_por).unwrap();
        let mh = mean(&shale_por).unwrap();
        assert!(
            ms > mh + 0.1,
            "sand por {ms} not clearly above shale por {mh}"
        );
        assert!((ms - 0.26).abs() < 0.02, "sand por mean {ms}");
        assert!((mh - 0.08).abs() < 0.02, "shale por mean {mh}");
    }
}
