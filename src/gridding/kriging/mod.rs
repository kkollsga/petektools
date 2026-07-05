//! `kriging` — ordinary kriging with the standard variogram-model family.
//!
//! The one gridding backend that carries an explicit spatial-continuity model (a
//! [`Variogram`]) and yields a per-node estimation **variance**, not just an
//! estimate. Exposed through the shared [`Gridder`](super::Gridder) trait as
//! [`OrdinaryKriging`], alongside the built-in [`GridMethod`](super::GridMethod)
//! backends.
//!
//! - [`variogram`] — the [`Variogram`] model (nugget + spherical / exponential /
//!   Gaussian structure).
//! - [`ordinary`] — the [`OrdinaryKriging`] gridder and its solver.
//!
//! No third-party geostatistics code was consulted; everything is derived from
//! the cited primary literature (see the module docs).

mod ordinary;
pub(crate) mod prep;
pub(crate) mod solve;
mod variogram;

pub use ordinary::OrdinaryKriging;
pub use variogram::{Variogram, VariogramModel};
