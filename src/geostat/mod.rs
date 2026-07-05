//! `geostat` — the geostatistics workflow beyond a single global krige: build a
//! spatial-continuity model from data, krige at scale with a moving
//! neighbourhood, and draw conditional realizations (sequential Gaussian
//! simulation, optionally steered by a collocated secondary variable).
//!
//! Where [`gridding::kriging`](crate::gridding::kriging) offers one global-
//! neighbourhood ordinary krige (every datum in one dense solve), `geostat` is
//! the **inference + scale + stochastic** layer:
//!
//! - [`experimental`] — [`experimental_variogram`]: the empirical semivariance
//!   cloud binned into lag classes.
//! - [`fit`] — [`Variogram::fit`](crate::Variogram::fit): pair-count weighted
//!   least-squares fit of a model to an experimental variogram.
//! - [`neighbourhood`] — an R*-tree moving search window (max-n neighbours within
//!   a radius) shared by the local kernels.
//! - [`local_kriging`] — [`LocalKriging`]: moving-neighbourhood ordinary kriging
//!   (small dense per-node solves) that scales to conditioning sets a single
//!   global solve cannot, and a simple-kriging core (used by simulation).
//! - [`nscore`] — the [`NormalScore`] transform (data ⇄ Gaussian scores).
//! - [`sgs`] — [`sgs`]: sequential Gaussian simulation, conditioned exactly on the
//!   data, with an optional collocated-cokriging (Markov-1) secondary drift; and
//!   [`sgs_unconditional`]: the same machinery with no data and a parametric
//!   `N(mean, variance)` target (the synthetic-field primitive).
//!
//! It reuses the crate's [`Variogram`](crate::Variogram) model, the small dense
//! LU solver behind ordinary kriging, and `rstar` (already a dependency) for the
//! neighbour search. Everything is derived from the primary literature cited on
//! each submodule — no third-party geostatistics code was consulted.

pub mod experimental;
pub mod fit;
pub mod local_kriging;
pub mod neighbourhood;
pub mod nscore;
pub mod sgs;

pub use experimental::{experimental_variogram, ExperimentalVariogram};
pub use local_kriging::LocalKriging;
pub use nscore::NormalScore;
pub use sgs::{sgs, sgs_seeded, sgs_unconditional, SgsParams, SgsSession};
