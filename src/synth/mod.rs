//! `synth` — **believable synthetic subsurface data**: seeded, deterministic
//! generators for logs, facies, structural surfaces, trend maps, wells and
//! trajectories. The generators the fixture factories and user demos compose into
//! a whole synthetic asset — a full stand-in for a real (confidential) dataset.
//!
//! Synthetic data is *believable* only when it carries the structure real data
//! has: a log **remembers its depth** (autocorrelation, not white noise), a
//! fraction **stays in `[0, 1]`** while hitting a target mean/std, sand and shale
//! **alternate in beds** with a real proportion, a dome **closes four ways**, a
//! trend map **correlates** with the property it drives. This module is built on
//! two small, well-documented maths primitives —
//!
//! - [`correlated`] — a depth-autocorrelated Gaussian series (AR(1) ≙ exponential
//!   correlation), the memory under every log; and
//! - [`transform`] — the moment-matched logit-normal map onto `[0, 1]`, hitting a
//!   target `{mean, std}` while never leaving the bounds —
//!
//! and the crate's own [`geostat::sgs_unconditional`](crate::geostat::sgs_unconditional)
//! for the 2-D fields.
//!
//! ## The surface (public)
//!
//! - **Logs** — [`ZoneSpec`] + [`synth_log_series`]: a zone-conformant, bounded,
//!   depth-autocorrelated property curve hitting each zone's `{mean, std}`.
//! - **Facies** — [`Facies`], [`synth_facies_series`] (truncated-Gaussian binary
//!   sand/shale at a target NTG) + [`MomentSpec`], [`synth_por_with_facies`] (the
//!   sand/shale porosity contrast composed onto the beds).
//! - **Coupled petrophysics** — [`PetroZoneSpec`] + [`synth_petro_curves`]: one
//!   [`PetroCurves`] whose **net-to-gross is derived from porosity** by a net cutoff
//!   (`net_flag = φ ≥ cutoff`), with the facies mixture *calibrated* so the realized
//!   series still hits the quoted zone NTG and net-rock `{mean, std}` (accounting for
//!   the across-cutoff leak). [`ntg_curve`] renders the derived flag as a continuous
//!   display curve. The petrophysically-honest replacement for an independent
//!   porosity/NTG pair.
//! - **Surfaces** — [`NoiseSpec`], [`synth_dome_surface`] (four-way closure, tilt
//!   and correlated noise), [`synth_isochore`] (non-negative thickness), and
//!   [`synth_trend_map`] (a `[0,1]` depositional trend, optionally correlated at a
//!   known `ρ` with a supplied field).
//! - **Wells** — [`place_wells`] / [`place_wells_in_polygon`],
//!   [`tops_from_surface`], and [`Station`] / [`Trajectory`] / [`synth_trajectory`]
//!   (vertical) + [`synth_trajectory_profile`] with a [`WellProfile`]
//!   ([`BuildHold`] / [`BuildHoldDrop`]) — believable deviated bores placed by the
//!   minimum-curvature relation ([`max_dogleg_severity`] scores their plausibility).
//! - **Outlines** — [`closure_outline`] (a surface's closing contour, marching
//!   squares) + [`study_area_outline`].
//! - **World frame** — [`Georef`]: the fictional world posture (431000/6521000-style
//!   origin) that is the *default* for every spatial generator here (the georeference
//!   is the lattice / extent / wellhead you pass); a convenience for the
//!   build-local → place-in-world idiom.
//!
//! Every generator is **seeded and bit-reproducible**. Namespaced under `synth`
//! (like `stats` / `sampling` / `units`), not re-exported at the crate root.
//!
//! Derived independently from the cited primary literature on each submodule; no
//! third-party code was consulted.

mod correlated;
mod transform;

pub mod facies;
pub mod georef;
pub mod log_series;
pub mod outline;
pub mod petro;
pub mod surface;
pub mod wells;

pub use facies::{synth_facies_series, synth_por_with_facies, Facies, MomentSpec};
pub use georef::{Georef, FICTIONAL_ORIGIN};
pub use log_series::{synth_log_series, zone_sample_counts, ZoneSpec};
pub use outline::{closure_outline, study_area_outline};
pub use petro::{ntg_curve, synth_petro_curves, PetroCurves, PetroZoneSpec, DEFAULT_NET_CUTOFF};
pub use surface::{synth_dome_surface, synth_isochore, synth_trend_map, NoiseSpec};
pub use wells::{
    max_dogleg_severity, place_wells, place_wells_in_polygon, synth_trajectory,
    synth_trajectory_profile, tops_from_surface, BuildHold, BuildHoldDrop, Station, Trajectory,
    WellProfile, MAX_BUILD_RATE_DEG_PER_30M,
};
