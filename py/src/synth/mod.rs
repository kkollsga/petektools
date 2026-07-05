//! `synth` bindings — the believable synthetic-data front-door.
//!
//! Mirrors `petektools::synth`: zone-conformant logs, truncated-Gaussian facies +
//! facies-composed porosity, 2-D structural recipes (dome / isochore / trend map),
//! well placement + surface picks + trajectories, and closure/study-area outlines.
//! Every generator is seeded and bit-reproducible. Grids are nested lists
//! (`field[col][row]`, `ncol × nrow`); `[x, y]` locations are 2-lists; a facies
//! series is a list of ints (`1` = sand, `0` = shale). Reuses the `Lattice`,
//! `Variogram` and `Sampler` classes from the other bindings.
//!
//! Split by generator family: [`logs`] (log series), [`facies`], [`petro`],
//! [`surface`] (dome / isochore / trend map), [`wells`] (placement / tops /
//! trajectories), [`outline`], and [`georef`].

mod facies;
mod georef;
mod logs;
mod outline;
mod petro;
mod surface;
mod wells;

pub use facies::{synth_facies_series, synth_por_with_facies};
pub use georef::Georef;
pub use logs::{synth_log_series, zone_sample_counts, ZoneSpec};
pub use outline::{closure_outline, study_area_outline};
pub use petro::{ntg_curve, synth_petro_curves, PetroZoneSpec};
pub use surface::{
    synth_dome_surface, synth_dome_surface_flat, synth_isochore, synth_isochore_flat,
    synth_trend_map, synth_trend_map_flat,
};
pub use wells::{
    max_dogleg_severity, place_wells, place_wells_in_polygon, synth_trajectory,
    synth_trajectory_profile, tops_from_surface,
};

use ndarray::Array2;
use pyo3::prelude::*;

/// A nested list `field[col][row]` → `(ncol × nrow)` `Array2`. Errors on a ragged
/// grid or a shape mismatch with `(ncol, nrow)`.
pub(super) fn to_array2(field: &[Vec<f64>], ncol: usize, nrow: usize) -> PyResult<Array2<f64>> {
    if field.len() != ncol || field.iter().any(|c| c.len() != nrow) {
        return Err(pyo3::exceptions::PyValueError::new_err(format!(
            "field must be a rectangular {ncol}x{nrow} nested list (field[col][row])"
        )));
    }
    let mut a = Array2::from_elem((ncol, nrow), 0.0);
    for (i, col) in field.iter().enumerate() {
        for (j, &v) in col.iter().enumerate() {
            a[[i, j]] = v;
        }
    }
    Ok(a)
}
