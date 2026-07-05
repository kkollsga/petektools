//! Well bindings — placement (extent / polygon), surface tops, and trajectory
//! synthesis (vertical + directional profiles) with the dogleg-severity score.

use std::collections::HashMap;

use petektools::foundation::BBox;
use petektools::synth::{
    max_dogleg_severity as rs_max_dls, place_wells as rs_place,
    place_wells_in_polygon as rs_place_poly, synth_trajectory as rs_traj,
    synth_trajectory_profile as rs_traj_profile, tops_from_surface as rs_tops, BuildHold,
    BuildHoldDrop, Trajectory, WellProfile,
};
use pyo3::prelude::*;

use super::to_array2;
use crate::geostat::Lattice;
use crate::sampling::PySampler;
use crate::to_pyerr;

/// Place `n` seeded uniform-random well heads inside the rectangular extent
/// `(xmin, ymin, xmax, ymax)`. Returns `[x, y]` 2-lists. Seeded/reproducible.
#[pyfunction]
pub fn place_wells(
    xmin: f64,
    ymin: f64,
    xmax: f64,
    ymax: f64,
    n: usize,
    seed: u64,
) -> PyResult<Vec<[f64; 2]>> {
    let e = BBox {
        xmin,
        ymin,
        xmax,
        ymax,
    };
    rs_place(&e, n, seed).map_err(to_pyerr)
}

/// Place `n` seeded uniform-random well heads inside `polygon` (`[x, y]` 2-lists,
/// implicitly closed), by rejection sampling. Returns `[x, y]` 2-lists.
#[pyfunction]
pub fn place_wells_in_polygon(
    polygon: Vec<[f64; 2]>,
    n: usize,
    seed: u64,
) -> PyResult<Vec<[f64; 2]>> {
    rs_place_poly(&polygon, n, seed).map_err(to_pyerr)
}

/// Pick a top from `surface` (nested lists, `ncol × nrow`) on `lattice` at each
/// well in `well_xy` (`[x, y]` 2-lists), adding one `residual` draw per well (a
/// `Sampler`, e.g. `Sampler.uniform(-10, 10)`). A well outside the extent → `NaN`.
/// Returns one top per well. Seeded/reproducible.
#[pyfunction]
pub fn tops_from_surface(
    surface: Vec<Vec<f64>>,
    lattice: &Lattice,
    well_xy: Vec<[f64; 2]>,
    residual: &PySampler,
    seed: u64,
) -> PyResult<Vec<f64>> {
    let (ncol, nrow) = (lattice.inner.ncol, lattice.inner.nrow);
    let s = to_array2(&surface, ncol, nrow)?;
    Ok(rs_tops(&s, &lattice.inner, &well_xy, &residual.inner, seed))
}

/// A [`Trajectory`] as a **columnar** dict of equal-length lists: `md`, `x`, `y`,
/// `z` (elevation), `tvd`, `incl`, `azim`.
fn traj_to_dict(t: &Trajectory) -> HashMap<String, Vec<f64>> {
    let mut out: HashMap<String, Vec<f64>> = HashMap::new();
    let n = t.stations.len();
    for key in ["md", "x", "y", "z", "tvd", "incl", "azim"] {
        out.insert(key.to_string(), Vec::with_capacity(n));
    }
    for s in &t.stations {
        out.get_mut("md").unwrap().push(s.md);
        out.get_mut("x").unwrap().push(s.x);
        out.get_mut("y").unwrap().push(s.y);
        out.get_mut("z").unwrap().push(s.z);
        out.get_mut("tvd").unwrap().push(s.tvd);
        out.get_mut("incl").unwrap().push(s.incl);
        out.get_mut("azim").unwrap().push(s.azim);
    }
    out
}

/// A vertical well trajectory from `wellhead_xy` (`[x, y]`), KB elevation
/// `kb_elevation` (subsea +up), to TD `td` (TVD below KB), station spacing
/// `md_step` m (final station lands on `td`). Returns a **columnar** dict of equal-
/// length lists: `md`, `x`, `y`, `z` (elevation), `tvd`, `incl`, `azim` (vertical:
/// `MD==TVD`, constant `xy`, `incl=azim=0`). `seed` is reserved for the deviated
/// case. Seeded/reproducible.
#[pyfunction]
pub fn synth_trajectory(
    wellhead_xy: [f64; 2],
    kb_elevation: f64,
    td: f64,
    md_step: f64,
    seed: u64,
) -> PyResult<HashMap<String, Vec<f64>>> {
    let t = rs_traj(wellhead_xy, kb_elevation, td, md_step, seed).map_err(to_pyerr)?;
    Ok(traj_to_dict(&t))
}

/// Build a [`WellProfile`] from a `profile` name (`"vertical"` | `"build_hold"` |
/// `"build_hold_drop"`) and its parameters.
#[allow(clippy::too_many_arguments)]
fn build_profile(
    profile: &str,
    kickoff_md: f64,
    build_rate_deg_per_30m: f64,
    hold_incl_deg: f64,
    azimuth_deg: f64,
    drop_start_md: Option<f64>,
    drop_rate_deg_per_30m: f64,
    final_incl_deg: f64,
) -> PyResult<WellProfile> {
    match profile {
        "vertical" => Ok(WellProfile::Vertical),
        "build_hold" | "build-hold" => {
            let bh = BuildHold::new(
                kickoff_md,
                build_rate_deg_per_30m,
                hold_incl_deg,
                azimuth_deg,
            )
            .map_err(to_pyerr)?;
            Ok(WellProfile::BuildHold(bh))
        }
        "build_hold_drop" | "build-hold-drop" => {
            let bh = BuildHold::new(
                kickoff_md,
                build_rate_deg_per_30m,
                hold_incl_deg,
                azimuth_deg,
            )
            .map_err(to_pyerr)?;
            let ds = drop_start_md.ok_or_else(|| {
                pyo3::exceptions::PyValueError::new_err(
                    "build_hold_drop needs drop_start_md".to_string(),
                )
            })?;
            let bhd = BuildHoldDrop::new(bh, ds, drop_rate_deg_per_30m, final_incl_deg)
                .map_err(to_pyerr)?;
            Ok(WellProfile::BuildHoldDrop(bhd))
        }
        other => Err(pyo3::exceptions::PyValueError::new_err(format!(
            "unknown profile {other:?}; use 'vertical' | 'build_hold' | 'build_hold_drop'"
        ))),
    }
}

/// A **directional** well trajectory following `profile` from `wellhead_xy`
/// (`[x, y]`, world), KB elevation `kb_elevation` (subsea +up), to TD `td`
/// (**MD** below KB), station spacing `md_step` m (final station lands on `td`).
///
/// `profile` is `"vertical"` | `"build_hold"` | `"build_hold_drop"`:
/// - `build_hold` — kick off at `kickoff_md`, build to `hold_incl_deg` at
///   `build_rate_deg_per_30m` (believable ~1–4 °/30 m), hold on `azimuth_deg`.
/// - `build_hold_drop` — as above, then from `drop_start_md` drop back toward
///   `final_incl_deg` at `drop_rate_deg_per_30m` (an S-well).
///
/// Stations are placed by the minimum-curvature relation (this is trajectory
/// *synthesis*, not survey interpretation). Use `md_step` ≈ 15–30 m for a deviated
/// bore so it crosses many areal columns. Returns the same **columnar** dict as
/// `synth_trajectory` (`md`/`x`/`y`/`z`/`tvd`/`incl`/`azim`). Deterministic;
/// `seed` is reserved.
#[pyfunction]
#[pyo3(signature = (
    wellhead_xy, kb_elevation, td, md_step, seed, profile,
    kickoff_md=0.0, build_rate_deg_per_30m=3.0, hold_incl_deg=45.0, azimuth_deg=0.0,
    drop_start_md=None, drop_rate_deg_per_30m=3.0, final_incl_deg=0.0,
))]
#[allow(clippy::too_many_arguments)]
pub fn synth_trajectory_profile(
    wellhead_xy: [f64; 2],
    kb_elevation: f64,
    td: f64,
    md_step: f64,
    seed: u64,
    profile: &str,
    kickoff_md: f64,
    build_rate_deg_per_30m: f64,
    hold_incl_deg: f64,
    azimuth_deg: f64,
    drop_start_md: Option<f64>,
    drop_rate_deg_per_30m: f64,
    final_incl_deg: f64,
) -> PyResult<HashMap<String, Vec<f64>>> {
    let p = build_profile(
        profile,
        kickoff_md,
        build_rate_deg_per_30m,
        hold_incl_deg,
        azimuth_deg,
        drop_start_md,
        drop_rate_deg_per_30m,
        final_incl_deg,
    )?;
    let t = rs_traj_profile(wellhead_xy, kb_elevation, td, md_step, &p, seed).map_err(to_pyerr)?;
    Ok(traj_to_dict(&t))
}

/// The maximum **dogleg severity** (degrees of hole-angle change per 30 m MD) of a
/// survey given its columnar `md` / `incl` / `azim` lists (as returned by
/// `synth_trajectory_profile`). `0` for a vertical well; the believability yardstick
/// for a directional path. The three lists must be equal length.
#[pyfunction]
pub fn max_dogleg_severity(md: Vec<f64>, incl: Vec<f64>, azim: Vec<f64>) -> PyResult<f64> {
    if md.len() != incl.len() || md.len() != azim.len() {
        return Err(pyo3::exceptions::PyValueError::new_err(
            "max_dogleg_severity: md, incl and azim must be equal length".to_string(),
        ));
    }
    let stations: Vec<petektools::synth::Station> = (0..md.len())
        .map(|k| petektools::synth::Station {
            md: md[k],
            x: 0.0,
            y: 0.0,
            z: 0.0,
            tvd: 0.0,
            incl: incl[k],
            azim: azim[k],
        })
        .collect();
    Ok(rs_max_dls(&Trajectory { stations }))
}
