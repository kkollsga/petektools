//! **Sequential Gaussian simulation** (SGS): draw a random field that honours the
//! conditioning data exactly, reproduces the modelled spatial continuity, and
//! matches the data histogram — optionally steered by a collocated secondary
//! variable (collocated cokriging, Markov-1).
//!
//! ## The algorithm
//!
//! 1. **Transform** the data to standard-normal scores ([`NormalScore`]).
//! 2. **Snap** each datum to its nearest lattice node and fix that node's score
//!    (conditioning honoured exactly at the nodes the data land on).
//! 3. **Visit** every remaining node once, in a **random path** seeded by
//!    `params.seed`.
//! 4. At each node, **simple-krige** (in normal-score space, mean 0) from the
//!    nearby already-known nodes — data *and* previously simulated — to get a
//!    conditional mean and variance, then **draw** `N(mean, √variance)` and set
//!    the node. The drawn value immediately becomes conditioning data for later
//!    nodes.
//! 5. **Back-transform** every node to data space.
//!
//! Because every node is drawn from its full conditional given all earlier
//! nodes, the ensemble reproduces the covariance and (through the transform) the
//! histogram (Deutsch & Journel 1998, *GSLIB* §VI.2; Goovaerts 1997 §8.4).
//!
//! ## Collocated secondary (Markov-1)
//!
//! With `params.collocated = Some((secondary, ρ))` the lattice-resident secondary
//! is standardised (zero mean, unit variance over its finite nodes) and folded
//! into each node's kriging as a collocated cokriging datum under the Markov-1
//! screening — see [`simple_kriging`](crate::geostat::local_kriging). `ρ = 0`
//! recovers plain SGS; `ρ → 1` pulls the field toward the secondary pattern.
//!
//! ## Speed contract
//!
//! Per `decision_mc_composition`, this is the **build-fast** path: one conditional
//! simulation per property build (a fast MC-over-realizations mode comes later).
//! A single random-path pass with a moving neighbourhood keeps it near-linear in
//! the node count.
//!
//! ## Module layout
//!
//! The workflow is split by concern: `sweep` holds the shared sequential-
//! Gaussian pass (and the conditioning-data snap), `scratch` the reusable
//! per-sweep buffers, `collocated` the secondary standardisation, and
//! `session` the reusable [`SgsSession`] context. This module keeps the public
//! parameters ([`SgsParams`]) and the two one-shot entry points ([`sgs`],
//! [`sgs_unconditional`]).
//!
//! Derived from the cited primary literature; no third-party code was consulted.

mod collocated;
mod scratch;
mod session;
mod sweep;

use crate::foundation::{AlgoError, Lattice, Result};
use crate::geostat::nscore::NormalScore;
use crate::gridding::kriging::SpatialVariogram;
use ndarray::Array2;

use collocated::standardize;
use scratch::SgsScratch;
use sweep::{simulate_scores, snap_fixed};

pub use session::SgsSession;

/// Parameters for [`sgs`].
#[derive(Debug, Clone)]
pub struct SgsParams {
    /// Spatial-continuity model, **fitted on the normal-score data** (so its total
    /// sill is ~1). Its correlogram drives the per-node simple kriging.
    pub variogram: SpatialVariogram,
    /// Maximum conditioning nodes (data + simulated) per node's local solve.
    pub max_neighbours: usize,
    /// Search radius for the moving neighbourhood (world units).
    pub radius: f64,
    /// RNG seed — the random path and every conditional draw derive from it, so
    /// the same seed reproduces the field bit-for-bit.
    pub seed: u64,
    /// Optional collocated secondary: a lattice-shaped `(ncol × nrow)` secondary
    /// field and its correlation `ρ` with the primary (Markov-1). The secondary
    /// is standardised internally. `None` ⇒ plain SGS.
    pub collocated: Option<(Array2<f64>, f64)>,
}

impl SgsParams {
    /// A plain (no-secondary) parameter set. Errors unless `max_neighbours ≥ 1`
    /// and `radius > 0` (finite).
    pub fn new(
        variogram: impl Into<SpatialVariogram>,
        max_neighbours: usize,
        radius: f64,
        seed: u64,
    ) -> Result<SgsParams> {
        if max_neighbours == 0 || !radius.is_finite() || radius <= 0.0 {
            return Err(AlgoError::InvalidArgument(
                "SgsParams: need max_neighbours >= 1 and radius > 0".to_string(),
            ));
        }
        Ok(SgsParams {
            variogram: variogram.into(),
            max_neighbours,
            radius,
            seed,
            collocated: None,
        })
    }
}

/// Run sequential Gaussian simulation of `coords` (`[x, y, z]` rows) onto
/// `lattice`, returning the `(ncol × nrow)` simulated field in **data space**.
///
/// Conditioning data are honoured exactly at the nodes they snap to. Errors on
/// empty input, on invalid neighbourhood parameters, or on a collocated secondary
/// whose shape does not match the lattice.
pub fn sgs(coords: &[[f64; 3]], lattice: &Lattice, params: &SgsParams) -> Result<Array2<f64>> {
    sgs_seeded(coords, lattice, params, params.seed)
}

/// [`sgs`] with an **explicit RNG seed** that overrides `params.seed` — the
/// bit-for-bit reproducible field for `seed`, everything else drawn from `params`.
///
/// This exists for the **parallel-layer** caller (petekStatic's per-layer SGS
/// sweep): a single shared `&SgsParams` (carrying the collocated secondary, which
/// is invariant across the layers) is reused across every layer, while each
/// layer's independent seed is passed here — avoiding a per-layer clone of the
/// secondary field. `sgs(coords, lattice, params)` is exactly
/// `sgs_seeded(coords, lattice, params, params.seed)`.
///
/// Errors identically to [`sgs`].
pub fn sgs_seeded(
    coords: &[[f64; 3]],
    lattice: &Lattice,
    params: &SgsParams,
    seed: u64,
) -> Result<Array2<f64>> {
    if coords.is_empty() {
        return Err(AlgoError::EmptyInput("sgs: no conditioning data"));
    }
    if params.max_neighbours == 0 || !params.radius.is_finite() || params.radius <= 0.0 {
        return Err(AlgoError::InvalidArgument(
            "sgs: need max_neighbours >= 1 and radius > 0".to_string(),
        ));
    }
    let (ncol, nrow) = (lattice.ncol, lattice.nrow);
    if let Some((sec, _)) = &params.collocated {
        if sec.dim() != (ncol, nrow) {
            return Err(AlgoError::InvalidArgument(
                "sgs: collocated secondary shape must match the lattice (ncol, nrow)".to_string(),
            ));
        }
    }
    let secondary = params
        .collocated
        .as_ref()
        .map(|(f, rho)| (standardize(f), *rho));

    // Normal-score transform from the data values.
    let zvals: Vec<f64> = coords.iter().map(|c| c[2]).collect();
    let ns = NormalScore::fit(&zvals)?;

    // Snap each datum to its nearest node and fix it as hard conditioning data,
    // in input order (the random path + draw stream then derive from `seed`).
    let fixed = snap_fixed(coords, lattice, &ns);

    let mut scratch = SgsScratch::default();
    let sim = simulate_scores(
        lattice,
        &params.variogram,
        params.max_neighbours,
        params.radius,
        secondary.as_ref(),
        seed,
        &fixed,
        &mut scratch,
    );

    // Back-transform every node to data space.
    Ok(sim.mapv(|s| ns.back(s)))
}

/// Draw an **unconditional** Gaussian random field onto `lattice`: no
/// conditioning data, a **parametric** target `N(mean, variance)` marginal, and
/// the spatial continuity of `variogram`. Returns the `(ncol × nrow)` field.
///
/// This is the same sequential-Gaussian machinery as [`sgs`] but bypasses the
/// data-anchored normal-score transform: the field is simulated directly in
/// standard-Gaussian space (`simple_kriging` works in the variogram's
/// *correlogram* `ρ(h) = 1 − γ(h)/S`, so the sweep is unit-variance regardless of
/// the variogram's sill — only its **shape and range** matter here), then mapped
/// to the target by the affine `value = mean + √variance · score`. The result is
/// therefore marginally `N(mean, variance)` with the variogram's autocorrelation
/// structure imprinted (range visible in the field's spatial correlation).
///
/// Degeneracies are sane: `variance == 0` returns a constant `mean` field; a
/// pure-nugget (rangeless) variogram yields spatially independent `N(mean,
/// variance)` draws. Errors on invalid neighbourhood parameters or a negative /
/// non-finite `variance`. Bit-reproducible per `seed`.
///
/// Deutsch & Journel 1998, *GSLIB* §VI.2; Goovaerts 1997 §8.4 — the
/// *unconditional* case of the same algorithm.
pub fn sgs_unconditional<V>(
    lattice: &Lattice,
    mean: f64,
    variance: f64,
    variogram: &V,
    max_neighbours: usize,
    radius: f64,
    seed: u64,
) -> Result<Array2<f64>>
where
    for<'a> SpatialVariogram: From<&'a V>,
{
    if max_neighbours == 0 || !radius.is_finite() || radius <= 0.0 {
        return Err(AlgoError::InvalidArgument(
            "sgs_unconditional: need max_neighbours >= 1 and radius > 0".to_string(),
        ));
    }
    if !mean.is_finite() || !variance.is_finite() || variance < 0.0 {
        return Err(AlgoError::InvalidArgument(
            "sgs_unconditional: need finite mean and variance >= 0".to_string(),
        ));
    }
    if variance == 0.0 {
        return Ok(Array2::from_elem((lattice.ncol, lattice.nrow), mean));
    }
    let variogram = SpatialVariogram::from(variogram);
    let mut scratch = SgsScratch::default();
    let sim = simulate_scores(
        lattice,
        &variogram,
        max_neighbours,
        radius,
        None,
        seed,
        &[],
        &mut scratch,
    );
    let sd = variance.sqrt();
    Ok(sim.mapv(|s| mean + sd * s))
}

#[cfg(test)]
mod tests;
