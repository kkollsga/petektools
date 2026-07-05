//! Well trajectories — vertical and directional survey synthesis, with the
//! believable [`WellProfile`] schedules and the minimum-curvature geometry.

use crate::foundation::{AlgoError, Result};

/// One survey station along a well path.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Station {
    /// Measured depth along the borehole (m from the reference, `MD = 0` at KB).
    pub md: f64,
    /// Easting (world x).
    pub x: f64,
    /// Northing (world y).
    pub y: f64,
    /// Elevation (subsea, positive up): `kb_elevation − tvd`.
    pub z: f64,
    /// True vertical depth below the KB datum (positive down).
    pub tvd: f64,
    /// Inclination from vertical, degrees (`0` = vertical).
    pub incl: f64,
    /// Azimuth, degrees clockwise from north (`0` for a vertical well).
    pub azim: f64,
}

/// A well survey — an ordered list of [`Station`]s from KB (`MD = 0`) to TD.
#[derive(Debug, Clone, PartialEq)]
pub struct Trajectory {
    /// Survey stations, top (`MD = 0`) first.
    pub stations: Vec<Station>,
}

/// Generate a **vertical** well trajectory from a `wellhead_xy`, a KB elevation
/// (`kb_elevation`, subsea positive up), to total depth `td` (TVD below KB),
/// sampled every `md_step` metres (the final station lands exactly on `td`).
///
/// For a vertical well `MD == TVD`, `x/y` are constant at the wellhead, and
/// `INCL = AZIM = 0`. `seed` is reserved for the deviated case (survey scatter)
/// and unused here — the vertical path is deterministic. The [`Station`] fields
/// (`x/y/incl/azim`) are already present so a deviated builder is additive.
///
/// Errors unless `td > 0`, `md_step > 0`, and the inputs are finite.
pub fn synth_trajectory(
    wellhead_xy: [f64; 2],
    kb_elevation: f64,
    td: f64,
    md_step: f64,
    seed: u64,
) -> Result<Trajectory> {
    let _ = seed; // reserved: vertical wells are deterministic.
    if !(wellhead_xy[0].is_finite() && wellhead_xy[1].is_finite() && kb_elevation.is_finite()) {
        return Err(AlgoError::InvalidArgument(
            "synth_trajectory: wellhead and kb_elevation must be finite".to_string(),
        ));
    }
    if !(td.is_finite() && td > 0.0) {
        return Err(AlgoError::InvalidArgument(
            "synth_trajectory: td must be finite and > 0".to_string(),
        ));
    }
    if !(md_step.is_finite() && md_step > 0.0) {
        return Err(AlgoError::InvalidArgument(
            "synth_trajectory: md_step must be finite and > 0".to_string(),
        ));
    }
    let n_full = (td / md_step).floor() as usize;
    // Station TVDs: 0, md_step, 2·md_step, … then TD exactly (if not already hit).
    let mut tvds: Vec<f64> = (0..=n_full).map(|k| k as f64 * md_step).collect();
    if (tvds.last().copied().unwrap_or(0.0) - td).abs() > 1e-9 {
        tvds.push(td);
    }
    let stations = tvds
        .into_iter()
        .map(|tvd| Station {
            md: tvd, // MD == TVD (vertical)
            x: wellhead_xy[0],
            y: wellhead_xy[1],
            z: kb_elevation - tvd,
            tvd,
            incl: 0.0,
            azim: 0.0,
        })
        .collect();
    Ok(Trajectory { stations })
}

/// A **build-and-hold** directional profile: drop straight to `kickoff_md`, build
/// inclination from vertical to `hold_incl_deg` at `build_rate_deg_per_30m`, then
/// hold that inclination on `azimuth_deg` to TD. The classic slanted producer.
///
/// `build_rate_deg_per_30m` is a **dogleg-severity** (deg per 30 m of MD); real
/// wells build at ~1–4 °/30 m (a stiff assembly up to ~6). The build section's
/// dogleg severity equals this rate by construction.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct BuildHold {
    /// MD (m) at which the bore leaves vertical.
    pub kickoff_md: f64,
    /// Build rate, degrees of inclination per 30 m MD (believable ~1–4).
    pub build_rate_deg_per_30m: f64,
    /// Inclination (deg from vertical) reached at the end of the build and held.
    pub hold_incl_deg: f64,
    /// Target azimuth (deg clockwise from north) of the deviated section.
    pub azimuth_deg: f64,
}

/// Believable-range ceiling on a build/drop rate (deg per 30 m MD). Above this a
/// synthetic bore stops being plausible; the constructors reject it.
pub const MAX_BUILD_RATE_DEG_PER_30M: f64 = 6.0;

impl BuildHold {
    /// Validate a build-and-hold profile. Errors unless all inputs are finite,
    /// `kickoff_md ≥ 0`, `0 < build_rate ≤ 6` (deg/30 m), `0 < hold_incl < 90`,
    /// and `azimuth` is finite (normalized into `[0, 360)`).
    pub fn new(
        kickoff_md: f64,
        build_rate_deg_per_30m: f64,
        hold_incl_deg: f64,
        azimuth_deg: f64,
    ) -> Result<BuildHold> {
        validate_build(
            kickoff_md,
            build_rate_deg_per_30m,
            hold_incl_deg,
            azimuth_deg,
        )?;
        Ok(BuildHold {
            kickoff_md,
            build_rate_deg_per_30m,
            hold_incl_deg,
            azimuth_deg: normalize_azimuth(azimuth_deg),
        })
    }

    /// MD length of the build section (`hold_incl / (rate/30)`).
    fn build_len(&self) -> f64 {
        self.hold_incl_deg / (self.build_rate_deg_per_30m / 30.0)
    }
}

/// A **build-hold-drop** (S-shaped) directional profile: a [`BuildHold`] that,
/// after `drop_start_md`, drops inclination back toward `final_incl_deg` at
/// `drop_rate_deg_per_30m` — the well that returns toward vertical to land a
/// reservoir section closer to plumb (a common appraisal geometry).
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct BuildHoldDrop {
    /// The build-and-hold part.
    pub build_hold: BuildHold,
    /// MD (m) at which the drop begins (must be at or after the build completes).
    pub drop_start_md: f64,
    /// Drop rate, degrees of inclination per 30 m MD (believable ~1–4).
    pub drop_rate_deg_per_30m: f64,
    /// Inclination (deg) the drop settles at (`0` = back to vertical; must be
    /// `≤ hold_incl`).
    pub final_incl_deg: f64,
}

impl BuildHoldDrop {
    /// Validate an S-shaped profile. Errors unless the [`BuildHold`] part is valid,
    /// `0 < drop_rate ≤ 6` (deg/30 m), `0 ≤ final_incl ≤ hold_incl`, and the drop
    /// starts at or after the build ends (`drop_start_md ≥ kickoff + build_len`).
    pub fn new(
        build_hold: BuildHold,
        drop_start_md: f64,
        drop_rate_deg_per_30m: f64,
        final_incl_deg: f64,
    ) -> Result<BuildHoldDrop> {
        if !(drop_rate_deg_per_30m.is_finite()
            && drop_rate_deg_per_30m > 0.0
            && drop_rate_deg_per_30m <= MAX_BUILD_RATE_DEG_PER_30M)
        {
            return Err(AlgoError::InvalidArgument(format!(
                "BuildHoldDrop: drop_rate must be finite in (0, {MAX_BUILD_RATE_DEG_PER_30M}] deg/30m"
            )));
        }
        if !(final_incl_deg.is_finite() && final_incl_deg >= 0.0)
            || final_incl_deg > build_hold.hold_incl_deg
        {
            return Err(AlgoError::InvalidArgument(
                "BuildHoldDrop: final_incl must be finite in [0, hold_incl]".to_string(),
            ));
        }
        let build_end = build_hold.kickoff_md + build_hold.build_len();
        if !(drop_start_md.is_finite() && drop_start_md >= build_end - 1e-9) {
            return Err(AlgoError::InvalidArgument(
                "BuildHoldDrop: drop_start_md must be finite and at/after the build end"
                    .to_string(),
            ));
        }
        Ok(BuildHoldDrop {
            build_hold,
            drop_start_md,
            drop_rate_deg_per_30m,
            final_incl_deg,
        })
    }
}

/// A believable directional-well profile — the analytic `(inclination, azimuth)`
/// schedule the survey stations follow.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum WellProfile {
    /// Straight down: `INCL = AZIM = 0`, `MD == TVD` — identical to
    /// [`synth_trajectory`].
    Vertical,
    /// Kick off, build to a hold inclination, hold on a target azimuth.
    BuildHold(BuildHold),
    /// Build-hold-drop (S-shape): hold, then drop back toward vertical.
    BuildHoldDrop(BuildHoldDrop),
}

impl WellProfile {
    /// The `(inclination_deg, azimuth_deg)` the bore is pointing at measured depth
    /// `md`. Inclination is `0` (and azimuth `0`) above the kickoff; azimuth is the
    /// profile's target once building. Piecewise-linear in `md` within each
    /// build/hold/drop segment (⇒ constant dogleg severity per segment).
    fn angles_at(&self, md: f64) -> (f64, f64) {
        match self {
            WellProfile::Vertical => (0.0, 0.0),
            WellProfile::BuildHold(bh) => build_hold_angles(bh, md),
            WellProfile::BuildHoldDrop(bhd) => {
                let bh = &bhd.build_hold;
                if md <= bhd.drop_start_md {
                    // vertical / build / hold — same as build-and-hold up to here.
                    build_hold_angles(bh, md)
                } else {
                    let drop_len = (bh.hold_incl_deg - bhd.final_incl_deg)
                        / (bhd.drop_rate_deg_per_30m / 30.0);
                    let incl = if md >= bhd.drop_start_md + drop_len {
                        bhd.final_incl_deg
                    } else {
                        bh.hold_incl_deg
                            - (md - bhd.drop_start_md) * (bhd.drop_rate_deg_per_30m / 30.0)
                    };
                    (incl, bh.azimuth_deg)
                }
            }
        }
    }
}

/// `(inclination_deg, azimuth_deg)` of a build-and-hold profile at `md`.
fn build_hold_angles(bh: &BuildHold, md: f64) -> (f64, f64) {
    if md <= bh.kickoff_md {
        (0.0, 0.0)
    } else if md >= bh.kickoff_md + bh.build_len() {
        (bh.hold_incl_deg, bh.azimuth_deg)
    } else {
        let incl = (md - bh.kickoff_md) * (bh.build_rate_deg_per_30m / 30.0);
        (incl, bh.azimuth_deg)
    }
}

/// Normalize an azimuth in degrees into `[0, 360)`.
fn normalize_azimuth(az: f64) -> f64 {
    let m = az % 360.0;
    if m < 0.0 {
        m + 360.0
    } else {
        m
    }
}

/// Shared validation for a build-and-hold's four parameters.
fn validate_build(
    kickoff_md: f64,
    build_rate_deg_per_30m: f64,
    hold_incl_deg: f64,
    azimuth_deg: f64,
) -> Result<()> {
    if !(kickoff_md.is_finite() && kickoff_md >= 0.0) {
        return Err(AlgoError::InvalidArgument(
            "BuildHold: kickoff_md must be finite and >= 0".to_string(),
        ));
    }
    if !(build_rate_deg_per_30m.is_finite()
        && build_rate_deg_per_30m > 0.0
        && build_rate_deg_per_30m <= MAX_BUILD_RATE_DEG_PER_30M)
    {
        return Err(AlgoError::InvalidArgument(format!(
            "BuildHold: build_rate must be finite in (0, {MAX_BUILD_RATE_DEG_PER_30M}] deg/30m"
        )));
    }
    if !(hold_incl_deg.is_finite() && hold_incl_deg > 0.0 && hold_incl_deg < 90.0) {
        return Err(AlgoError::InvalidArgument(
            "BuildHold: hold_incl must be finite in (0, 90)".to_string(),
        ));
    }
    if !azimuth_deg.is_finite() {
        return Err(AlgoError::InvalidArgument(
            "BuildHold: azimuth must be finite".to_string(),
        ));
    }
    Ok(())
}

/// Generate a **directional** well trajectory following `profile` from
/// `wellhead_xy` (world), a KB elevation (`kb_elevation`, subsea positive up), to
/// total depth `td` (**MD** below KB), with a station every `md_step` metres (the
/// final station lands exactly on `td`).
///
/// Station positions are placed by the **minimum-curvature** method between
/// adjacent stations' `(inclination, azimuth)` — the standard directional-survey
/// geometry (each segment is the circular arc that matches both end tangents). The
/// angle schedule itself comes from the analytic [`WellProfile`], so the path is
/// smooth and fully deterministic (no RNG; `seed` is reserved for future survey
/// scatter). [`WellProfile::Vertical`] delegates to [`synth_trajectory`] for a
/// bit-identical vertical path.
///
/// `td` is measured **along hole** (MD), so a deviated well of a given MD reaches a
/// shallower TVD than a vertical one. Pick `md_step` small enough (≈ 15–30 m for a
/// deviated bore) that the swept `x/y` crosses many areal columns. World `x` = easting,
/// `y` = northing; `z = kb_elevation − tvd`
/// (subsea, positive up) — the convention the `.wellpath` writer consumes.
///
/// Errors unless `td > 0`, `md_step > 0`, and the inputs are finite.
pub fn synth_trajectory_profile(
    wellhead_xy: [f64; 2],
    kb_elevation: f64,
    td: f64,
    md_step: f64,
    profile: &WellProfile,
    seed: u64,
) -> Result<Trajectory> {
    let _ = seed; // reserved: the analytic profile is deterministic.
    if let WellProfile::Vertical = profile {
        return synth_trajectory(wellhead_xy, kb_elevation, td, md_step, seed);
    }
    if !(wellhead_xy[0].is_finite() && wellhead_xy[1].is_finite() && kb_elevation.is_finite()) {
        return Err(AlgoError::InvalidArgument(
            "synth_trajectory_profile: wellhead and kb_elevation must be finite".to_string(),
        ));
    }
    if !(td.is_finite() && td > 0.0) {
        return Err(AlgoError::InvalidArgument(
            "synth_trajectory_profile: td must be finite and > 0".to_string(),
        ));
    }
    if !(md_step.is_finite() && md_step > 0.0) {
        return Err(AlgoError::InvalidArgument(
            "synth_trajectory_profile: md_step must be finite and > 0".to_string(),
        ));
    }

    // Station MDs: 0, md_step, 2·md_step, … then TD exactly (if not already hit).
    let n_full = (td / md_step).floor() as usize;
    let mut mds: Vec<f64> = (0..=n_full).map(|k| k as f64 * md_step).collect();
    if (mds.last().copied().unwrap_or(0.0) - td).abs() > 1e-9 {
        mds.push(td);
    }

    // Minimum-curvature integration of the analytic angle schedule.
    let (mut east, mut north, mut tvd) = (0.0_f64, 0.0_f64, 0.0_f64);
    let mut stations = Vec::with_capacity(mds.len());
    let mut prev: Option<(f64, f64, f64)> = None; // (md, incl_rad, azim_rad)
    for &md in &mds {
        let (incl_deg, azim_deg) = profile.angles_at(md);
        let (i2, a2) = (incl_deg.to_radians(), azim_deg.to_radians());
        if let Some((md1, i1, a1)) = prev {
            let dmd = md - md1;
            let (de, dn, dv) = min_curvature_step(dmd, i1, a1, i2, a2);
            east += de;
            north += dn;
            tvd += dv;
        }
        stations.push(Station {
            md,
            x: wellhead_xy[0] + east,
            y: wellhead_xy[1] + north,
            z: kb_elevation - tvd,
            tvd,
            incl: incl_deg,
            azim: azim_deg,
        });
        prev = Some((md, i2, a2));
    }
    Ok(Trajectory { stations })
}

/// One minimum-curvature step: the `(ΔEast, ΔNorth, ΔTVD)` between two survey
/// stations `ΔMD` apart with inclinations `i1, i2` and azimuths `a1, a2` (radians).
/// The ratio factor `tan(β/2)/(β/2)` (`→ 1` as the dogleg `β → 0`) turns the two
/// end tangents into the connecting circular arc.
fn min_curvature_step(dmd: f64, i1: f64, a1: f64, i2: f64, a2: f64) -> (f64, f64, f64) {
    let cos_dl = (i1.cos() * i2.cos() + i1.sin() * i2.sin() * (a2 - a1).cos()).clamp(-1.0, 1.0);
    let dl = cos_dl.acos();
    let rf = if dl.abs() < 1e-9 {
        1.0
    } else {
        (dl / 2.0).tan() / (dl / 2.0)
    };
    let half = dmd / 2.0 * rf;
    let de = half * (i1.sin() * a1.sin() + i2.sin() * a2.sin()); // East  = sin(I)·sin(A)
    let dn = half * (i1.sin() * a1.cos() + i2.sin() * a2.cos()); // North = sin(I)·cos(A)
    let dv = half * (i1.cos() + i2.cos()); // TVD (down)
    (de, dn, dv)
}

/// The maximum **dogleg severity** (degrees of hole-angle change per 30 m of MD)
/// over a trajectory — the believability yardstick for a directional path. `0` for
/// a vertical well; equal to the build/drop rate through a constant-curvature
/// section. Returns `0` for a trajectory with fewer than two stations.
pub fn max_dogleg_severity(traj: &Trajectory) -> f64 {
    let mut worst = 0.0_f64;
    for w in traj.stations.windows(2) {
        let (s1, s2) = (&w[0], &w[1]);
        let dmd = s2.md - s1.md;
        if dmd <= 0.0 {
            continue;
        }
        let (i1, a1) = (s1.incl.to_radians(), s1.azim.to_radians());
        let (i2, a2) = (s2.incl.to_radians(), s2.azim.to_radians());
        let cos_dl = (i1.cos() * i2.cos() + i1.sin() * i2.sin() * (a2 - a1).cos()).clamp(-1.0, 1.0);
        let dls = cos_dl.acos().to_degrees() / dmd * 30.0;
        worst = worst.max(dls);
    }
    worst
}
