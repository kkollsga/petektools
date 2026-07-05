//! `sampling` — a curated, validated front-door for reproducible random draws
//! from the distributions an appraisal Monte-Carlo actually uses.
//!
//! Curates [`rand`](https://docs.rs/rand) + [`rand_distr`](https://docs.rs/rand_distr):
//! parameters are validated up front (returning a
//! [`Result`](crate::foundation::Result) instead of panicking), and a
//! [`seeded_rng`] gives a deterministic stream — reproducibility matters for MC
//! over a static model.
//!
//! Namespaced under `sampling` (not re-exported at the crate root), matching the
//! `units` / `container` / `stats` front-doors. The heavy lifting (the variate
//! algorithms — Box–Muller/Ziggurat normals, etc.) stays in `rand_distr`; this
//! module only validates and dispatches.

//! Beyond the raw [`Sampler`], two realization-set helpers an appraisal
//! Monte-Carlo reaches for: [`reservoir_summary`] (the oil-industry P90/P50/P10
//! digest) and [`aggregate`] (summing per-segment realizations under an explicit
//! [`Correlation`] assumption).

pub mod aggregate;
pub mod distributions;
pub mod summary;

pub use aggregate::{aggregate, Correlation};
pub use distributions::{seeded_rng, Clamped, Sampler};
pub use summary::{reservoir_summary, ReservoirSummary};
