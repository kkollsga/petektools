//! The reusable sequential-Gaussian-simulation context — one context, many
//! layers, with the working scratch retained across sweeps.

use super::collocated::standardize;
use super::scratch::SgsScratch;
use super::sweep::{simulate_scores, snap_fixed};
use crate::foundation::{AlgoError, Lattice, Result};
use crate::geostat::nscore::NormalScore;
use crate::gridding::kriging::SpatialVariogram;
use ndarray::Array2;

/// A **reusable sequential-Gaussian-simulation context** over a fixed lattice /
/// variogram / search neighbourhood: construct it **once**, then simulate **many
/// layers** through it, each with its own conditioning data (and optional
/// collocated secondary) and seed.
///
/// The motivating workload is *resimulate*: rebuilding a property model layer by
/// layer at interactive rates. Across layers the lattice geometry, the variogram,
/// and the search parameters do not change — only the conditioning point
/// values/membership do. A one-shot [`sgs`](super::sgs) call re-allocates all of
/// its working storage (the informed-node arrays, the visiting path, and — the hot
/// one — the per-node kriging solver matrices) on **every** layer; the session
/// pays those allocations once and threads the retained scratch through every
/// sweep. See `SgsScratch` (the module's `scratch` submodule) for exactly what is
/// retained vs. rebuilt and why.
///
/// **Determinism is preserved exactly.** For the same conditioning data + seed
/// (+ secondary), [`simulate`](Self::simulate) /
/// [`simulate_collocated`](Self::simulate_collocated) produce a field **bit-for-
/// bit identical** to the corresponding one-shot [`sgs`](super::sgs) call: the
/// visitation order, the RNG stream, and the kriging arithmetic are unchanged —
/// the session is an allocation restructure, not an algorithmic one.
///
/// ```
/// use petektools::geostat::SgsSession;
/// use petektools::{Lattice, Variogram, VariogramModel};
///
/// let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 40, 40);
/// let vg = Variogram::new(VariogramModel::Spherical, 0.0, 1.0, 10.0).unwrap();
/// let mut session = SgsSession::new(lattice, vg, 24, 18.0).unwrap();
///
/// // Simulate several layers, reusing the session's scratch each time.
/// for (k, seed) in [11u64, 22, 33].into_iter().enumerate() {
///     let coords = vec![[2.0, 2.0, 10.0 + k as f64], [30.0, 30.0, 25.0]];
///     let field = session.simulate(&coords, seed).unwrap();
///     assert_eq!(field.dim(), (40, 40));
/// }
/// ```
pub struct SgsSession {
    lattice: Lattice,
    variogram: SpatialVariogram,
    max_neighbours: usize,
    radius: f64,
    scratch: SgsScratch,
}

impl SgsSession {
    /// Build a session over a fixed `lattice`, `variogram`, and moving-search
    /// neighbourhood (`max_neighbours` within `radius`, world units). These are
    /// the layer-invariant inputs; per-layer conditioning + seed are supplied to
    /// [`simulate`](Self::simulate). Errors unless `max_neighbours ≥ 1` and
    /// `radius > 0` (finite) — the same validity contract as
    /// [`SgsParams::new`](super::SgsParams::new).
    pub fn new(
        lattice: Lattice,
        variogram: impl Into<SpatialVariogram>,
        max_neighbours: usize,
        radius: f64,
    ) -> Result<SgsSession> {
        if max_neighbours == 0 || !radius.is_finite() || radius <= 0.0 {
            return Err(AlgoError::InvalidArgument(
                "SgsSession: need max_neighbours >= 1 and radius > 0".to_string(),
            ));
        }
        Ok(SgsSession {
            lattice,
            variogram: variogram.into(),
            max_neighbours,
            radius,
            scratch: SgsScratch::default(),
        })
    }

    /// The lattice this session simulates onto.
    pub fn lattice(&self) -> &Lattice {
        &self.lattice
    }

    /// The variogram this session kriges with.
    pub fn variogram(&self) -> &SpatialVariogram {
        &self.variogram
    }

    /// Simulate one layer conditioned on `coords` (`[x, y, z]` rows) with `seed`,
    /// returning the `(ncol × nrow)` field in **data space**. Bit-for-bit equal to
    /// [`sgs`](super::sgs) called with the same data, variogram, neighbourhood, and
    /// seed (no collocated secondary). Errors on empty input.
    pub fn simulate(&mut self, coords: &[[f64; 3]], seed: u64) -> Result<Array2<f64>> {
        self.simulate_inner(coords, seed, None)
    }

    /// Simulate one layer as [`simulate`](Self::simulate) but steered by a
    /// collocated secondary (Markov-1): `secondary` is a lattice-shaped
    /// `(ncol × nrow)` field, standardised internally, folded in with correlation
    /// `rho`. Bit-for-bit equal to [`sgs`](super::sgs) with `params.collocated =
    /// Some((secondary, rho))`. Errors on empty input or a shape mismatch.
    pub fn simulate_collocated(
        &mut self,
        coords: &[[f64; 3]],
        seed: u64,
        secondary: &Array2<f64>,
        rho: f64,
    ) -> Result<Array2<f64>> {
        self.simulate_inner(coords, seed, Some((secondary, rho)))
    }

    fn simulate_inner(
        &mut self,
        coords: &[[f64; 3]],
        seed: u64,
        collocated: Option<(&Array2<f64>, f64)>,
    ) -> Result<Array2<f64>> {
        if coords.is_empty() {
            return Err(AlgoError::EmptyInput(
                "SgsSession::simulate: no conditioning data",
            ));
        }
        let (ncol, nrow) = (self.lattice.ncol, self.lattice.nrow);
        let secondary = match collocated {
            Some((sec, rho)) => {
                if sec.dim() != (ncol, nrow) {
                    return Err(AlgoError::InvalidArgument(
                        "SgsSession::simulate: collocated secondary shape must match the lattice (ncol, nrow)".to_string(),
                    ));
                }
                Some((standardize(sec), rho))
            }
            None => None,
        };

        let zvals: Vec<f64> = coords.iter().map(|c| c[2]).collect();
        let ns = NormalScore::fit(&zvals)?;
        let fixed = snap_fixed(coords, &self.lattice, &ns);

        let sim = simulate_scores(
            &self.lattice,
            &self.variogram,
            self.max_neighbours,
            self.radius,
            secondary.as_ref(),
            seed,
            &fixed,
            &mut self.scratch,
        );

        Ok(sim.mapv(|s| ns.back(s)))
    }
}
