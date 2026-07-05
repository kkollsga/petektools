//! `stats` — a curated, validated front-door for descriptive statistics.
//!
//! Two halves:
//! - [`descriptive`] — unweighted `mean` / `variance` / `std_dev` / `percentile`
//!   / `median`, a thin wrapper over [`statrs`](https://docs.rs/statrs) that
//!   returns a [`Result`](crate::foundation::Result) instead of panicking and
//!   speaks plain `&[f64]`;
//! - [`weighted`] — the weighted family (`weighted_mean` / `weighted_variance` /
//!   `weighted_std_dev` / `weighted_percentile`) that `statrs` does not provide.
//!
//! Namespaced under `stats` (not re-exported at the crate root), matching the
//! `units` / `container` front-doors.

pub mod descriptive;
pub mod weighted;

pub use descriptive::{mean, median, percentile, std_dev, variance};
pub use weighted::{weighted_mean, weighted_percentile, weighted_std_dev, weighted_variance};
