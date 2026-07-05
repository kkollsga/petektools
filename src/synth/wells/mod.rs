//! **Well placement, surface picks, and trajectories** — turning a structural
//! picture into wells: seeded locations, a surface top at each well (plus a
//! residual mispick), and a survey trajectory.
//!
//! **World frame is the default posture.** Every input here is a *world*
//! coordinate — the extent / polygon a well is placed in, the `lattice` a top is
//! sampled from, the `wellhead_xy` a bore starts at — so the outputs land in the
//! world too. A fictional world origin (431000/6521000-style) is built with
//! [`Georef`](crate::synth::Georef); there is no separate local frame.
//!
//! - [`place_wells`] / [`place_wells_in_polygon`] — seeded uniform-random well
//!   heads inside a rectangular extent or an arbitrary polygon (rejection
//!   sampling).
//! - [`tops_from_surface`] — bilinear-sample a surface at each well and add a
//!   drawn residual (a [`Sampler`](crate::sampling::Sampler) — a `±10 m` uniform,
//!   a normal mispick, …).
//! - [`synth_trajectory`] — a **vertical** well survey (constant `xy`, `MD == TVD`,
//!   `INCL = AZIM = 0`), the unchanged default.
//! - [`synth_trajectory_profile`] — a **directional** well survey following a
//!   believable [`WellProfile`] (`Vertical` | [`BuildHold`] | [`BuildHoldDrop`]):
//!   kick off at a depth, build to a hold inclination at a believable rate, hold
//!   (and optionally drop back) on a target azimuth. Stations are placed by the
//!   **minimum-curvature** relation between adjacent angle pairs, so a deviated
//!   bore sweeps real world `x/y` and crosses many areal columns at reservoir
//!   depth.
//!
//! This is trajectory **synthesis** (we author the analytic inclination/azimuth
//! schedule, then place stations consistent with it) — *not* survey
//! interpretation (reconstructing a path from a measured, noisy survey), which is
//! petekIO's job. The two share the minimum-curvature geometry; only synthesis
//! lives here.
//!
//! No third-party code was consulted.

mod placement;
mod tops;
mod trajectory;

pub use placement::{place_wells, place_wells_in_polygon};
pub use tops::tops_from_surface;
pub use trajectory::{
    max_dogleg_severity, synth_trajectory, synth_trajectory_profile, BuildHold, BuildHoldDrop,
    Station, Trajectory, WellProfile, MAX_BUILD_RATE_DEG_PER_30M,
};

#[cfg(test)]
mod tests;
