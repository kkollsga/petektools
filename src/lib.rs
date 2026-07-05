//! # petekTools
//!
//! Standalone numerics & geostatistics kernels for Rust — the layer Rust is
//! missing. Mature crates cover linear algebra (`faer`), statistics/distributions
//! (`statrs`, `rand_distr`), FFT (`rustfft`) and spatial indexing (`kiddo`,
//! `rstar`), but there is **no production-grade scattered-data gridding /
//! geostatistics** crate. petekTools fills exactly that gap and curates the
//! rest behind one front-door.
//!
//! ## The pillars (module map)
//! - [`gridding`] — the core gap: scattered-data → grid kernels (`nearest`,
//!   `idw`, `min_curvature`), warm-start / [`ConvergentGridder`], the
//!   [`Gridder`] trait + [`OrdinaryKriging`], and the grid → grid [`resample`]
//!   (native regular grid onto a foreign [`Lattice`], bilinear/nearest).
//! - [`geostat`] — the geostatistics workflow beyond one global krige:
//!   experimental variogram + [`Variogram::fit`], moving-neighbourhood
//!   [`LocalKriging`](geostat::LocalKriging) (scales to tens of thousands of
//!   points), the [`NormalScore`](geostat::NormalScore) transform, and
//!   conditional [`sgs`](geostat::sgs) simulation (with collocated cokriging).
//! - [`stats`] — curated descriptive statistics (unweighted + weighted).
//! - [`sampling`] — reproducible draws from the common appraisal distributions
//!   (incl. truncated/clamped bounding), plus the realization-set helpers
//!   [`reservoir_summary`](sampling::reservoir_summary) (P90=low digest) and
//!   [`aggregate`](sampling::aggregate).
//! - [`units`] — domain-agnostic unit conversions (imperial + SI).
//! - [`container`] — a domain-agnostic single-file section container.
//! - [`store`] — a domain-agnostic chunked, memory-mapped lane store: the
//!   spill-to-disk backing for larger-than-memory models (k-slab-major lanes,
//!   `f32`/`f64`/`u16`/`u32`, deterministic layout, zero-copy views).
//! - [`foundation`] — the shared vocabulary ([`Lattice`], [`BBox`],
//!   [`AlgoError`]).
//!
//! A thin **PyO3 wheel** (`petektools` on PyPI) re-exports the Python-relevant
//! front-door — `sampling` (all `Sampler` variants + a seeded `Rng` giving the
//! same stream as this crate), `stats`, `reservoir_summary`/`aggregate`, and the
//! `geostat` kernels. It lives in the `py/` workspace member (maturin,
//! `publish = false`); `API.md` §"Python (PyO3) surface" is its contract.
//!
//! `gridding` and `foundation` are re-exported at the crate root for the common
//! path; `stats` / `sampling` / `units` / `container` stay deliberately
//! namespaced (import e.g. `petektools::stats::percentile`,
//! `petektools::units::bbl_to_m3`).
//!
//! ## Charter (what belongs here — and what does not)
//! - **In:** scattered-data gridding/interpolation (minimum-curvature, IDW,
//!   nearest today; kriging / RBF later), plus thin curation over the mature
//!   numeric crates.
//! - **Out:** file I/O of any kind (that is petekio), and reservoir-domain
//!   modeling — PVT, rel-perm, material balance, decline, GRV (that is peteksim).
//!   The deliberate exceptions are [`container`] — a **domain-agnostic** file
//!   container lifted here so every layer shares one framing — and [`store`],
//!   the domain-agnostic mmap lane store; both do generic, opaque array/blob I/O
//!   only (domain/format I/O stays in petekio).
//!
//! ## Dependency rule: this crate is a **pure leaf**
//! It depends only on general-purpose numeric crates — never on petekio or
//! peteksim. petekio depends on petekTools (for the gridding kernels);
//! peteksim depends on both. One direction, no cycles.
//!
//! ## Type-agnostic boundary
//! Kernels speak [`Lattice`] (this crate's own geometry vocabulary) + plain
//! `[[f64; 3]]` coordinate arrays — never a consumer's domain type. petekio's
//! `GridGeometry` maps onto [`Lattice`] field-for-field, so a future delegation
//! is a 1:1 conversion at the call site, not a rewrite.
//!
//! ## Status
//! GATE-0 is locked (the [`Lattice`] / [`GridMethod`] / [`grid`] contract + the
//! three kernels ported from petekio 0.2.0). Shipped since (unreleased, on the
//! way to 0.2.0): warm-start / [`ConvergentGridder`] gridding, the [`Gridder`]
//! trait + [`OrdinaryKriging`], the curated [`stats`] and [`sampling`]
//! front-doors, the [`units`] / [`container`] modules, and the PyO3 `petektools`
//! wheel (the `py/` member) over the front-door. See `API.md` for the contract.

// The crate is unsafe-free everywhere except the `store` unit, which needs two
// `memmap2` map calls (each carries a `SAFETY` note + `#[allow(unsafe_code)]`).
// `deny` (not `forbid`) is what lets that single, documented carve-out compile.
#![deny(unsafe_code)]

pub mod container;
pub mod foundation;
pub mod geostat;
pub mod gridding;
pub mod sampling;
pub mod stats;
pub mod store;
pub mod synth;
pub mod units;

// Curated top-level surface — the front-door consumers import. (Unit conversions
// stay namespaced under `units` to keep the numeric front-door uncluttered.)
pub use foundation::{AlgoError, BBox, Lattice, Result};
pub use gridding::{
    grid, grid_min_curvature_conditioned, grid_min_curvature_seeded, resample, Conditioning,
    ConvergentGridder, GridMethod, Gridder, MinCurvatureOperator, OrdinaryKriging, ResampleMethod,
    Variogram, VariogramModel,
};
