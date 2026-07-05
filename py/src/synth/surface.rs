//! Structural-surface bindings — the dome, isochore and trend-map recipes, each
//! with a boxed nested-list crossing and a FLAT bytes crossing.

use petektools::synth::{
    synth_dome_surface as rs_dome, synth_isochore as rs_isochore, synth_trend_map as rs_trend,
    NoiseSpec,
};
use pyo3::prelude::*;
use pyo3::types::PyBytes;

use super::to_array2;
use crate::geostat::{Lattice, Variogram};
use crate::grid::{rows, to_flat};
use crate::to_pyerr;

/// A synthetic dome structure on `lattice`: an elliptical four-way closure of
/// amplitude `relief`, elongation `aspect`, a regional `tilt`, and correlated
/// noise (`noise_variance` amplitude², continuity `noise_variogram`; variance `0`
/// ⇒ none). Returns the `ncol × nrow` relief field (crest = max) as nested lists.
#[pyfunction]
#[allow(clippy::too_many_arguments)]
pub fn synth_dome_surface(
    py: Python<'_>,
    lattice: &Lattice,
    relief: f64,
    aspect: f64,
    tilt: f64,
    noise_variance: f64,
    noise_variogram: &Variogram,
    seed: u64,
) -> PyResult<Vec<Vec<f64>>> {
    let noise = NoiseSpec::new(noise_variance, noise_variogram.inner).map_err(to_pyerr)?;
    let lat = lattice.inner.clone();
    let s = py
        .detach(|| rs_dome(&lat, relief, aspect, tilt, &noise, seed))
        .map_err(to_pyerr)?;
    Ok(rows(&s))
}

/// Flat crossing of [`synth_dome_surface`]: `(field_bytes, (ncol, nrow))`
/// (little-endian `f64`, `field[col][row]`) instead of a boxed nested list.
#[pyfunction]
#[allow(clippy::too_many_arguments)]
pub fn synth_dome_surface_flat<'py>(
    py: Python<'py>,
    lattice: &Lattice,
    relief: f64,
    aspect: f64,
    tilt: f64,
    noise_variance: f64,
    noise_variogram: &Variogram,
    seed: u64,
) -> PyResult<(Bound<'py, PyBytes>, (usize, usize))> {
    let noise = NoiseSpec::new(noise_variance, noise_variogram.inner).map_err(to_pyerr)?;
    let lat = lattice.inner.clone();
    let s = py
        .detach(|| rs_dome(&lat, relief, aspect, tilt, &noise, seed))
        .map_err(to_pyerr)?;
    Ok(to_flat(py, &s))
}

/// A synthetic isochore (thickness map) on `lattice`: a correlated field about
/// `mean_thickness` with std `variability` and continuity `variogram`, clamped at
/// zero. Returns the `ncol × nrow` field as nested lists. Seeded/reproducible.
#[pyfunction]
pub fn synth_isochore(
    py: Python<'_>,
    lattice: &Lattice,
    mean_thickness: f64,
    variability: f64,
    variogram: &Variogram,
    seed: u64,
) -> PyResult<Vec<Vec<f64>>> {
    let lat = lattice.inner.clone();
    let vg = variogram.inner;
    let s = py
        .detach(|| rs_isochore(&lat, mean_thickness, variability, &vg, seed))
        .map_err(to_pyerr)?;
    Ok(rows(&s))
}

/// Flat crossing of [`synth_isochore`]: `(field_bytes, (ncol, nrow))`
/// (little-endian `f64`, `field[col][row]`) instead of a boxed nested list.
#[pyfunction]
pub fn synth_isochore_flat<'py>(
    py: Python<'py>,
    lattice: &Lattice,
    mean_thickness: f64,
    variability: f64,
    variogram: &Variogram,
    seed: u64,
) -> PyResult<(Bound<'py, PyBytes>, (usize, usize))> {
    let lat = lattice.inner.clone();
    let vg = variogram.inner;
    let s = py
        .detach(|| rs_isochore(&lat, mean_thickness, variability, &vg, seed))
        .map_err(to_pyerr)?;
    Ok(to_flat(py, &s))
}

/// A depositional trend map on `lattice`: a correlated field mapped to `[0,1]`
/// (Uniform marginal). With `correlate_with = (field, rho)` the trend is built to
/// correlate with `field` (nested lists, `ncol × nrow`) at ~`rho ∈ [-1,1]`.
/// Returns the `ncol × nrow` trend as nested lists. Seeded/reproducible.
#[pyfunction]
#[pyo3(signature = (lattice, variogram, seed, correlate_with=None))]
pub fn synth_trend_map(
    py: Python<'_>,
    lattice: &Lattice,
    variogram: &Variogram,
    seed: u64,
    correlate_with: Option<(Vec<Vec<f64>>, f64)>,
) -> PyResult<Vec<Vec<f64>>> {
    let (ncol, nrow) = (lattice.inner.ncol, lattice.inner.nrow);
    let field = match &correlate_with {
        Some((f, _)) => Some(to_array2(f, ncol, nrow)?),
        None => None,
    };
    let rho = correlate_with.as_ref().map(|(_, r)| *r);
    let lat = lattice.inner.clone();
    let vg = variogram.inner;
    let s = py
        .detach(|| {
            let cw = field.as_ref().map(|f| (f, rho.unwrap()));
            rs_trend(&lat, &vg, seed, cw)
        })
        .map_err(to_pyerr)?;
    Ok(rows(&s))
}

/// Flat crossing of [`synth_trend_map`]: `(field_bytes, (ncol, nrow))`
/// (little-endian `f64`, `field[col][row]`) instead of a boxed nested list.
/// `correlate_with` (if given) is still a nested list (rare path).
#[pyfunction]
#[pyo3(signature = (lattice, variogram, seed, correlate_with=None))]
pub fn synth_trend_map_flat<'py>(
    py: Python<'py>,
    lattice: &Lattice,
    variogram: &Variogram,
    seed: u64,
    correlate_with: Option<(Vec<Vec<f64>>, f64)>,
) -> PyResult<(Bound<'py, PyBytes>, (usize, usize))> {
    let (ncol, nrow) = (lattice.inner.ncol, lattice.inner.nrow);
    let field = match &correlate_with {
        Some((f, _)) => Some(to_array2(f, ncol, nrow)?),
        None => None,
    };
    let rho = correlate_with.as_ref().map(|(_, r)| *r);
    let lat = lattice.inner.clone();
    let vg = variogram.inner;
    let s = py
        .detach(|| {
            let cw = field.as_ref().map(|f| (f, rho.unwrap()));
            rs_trend(&lat, &vg, seed, cw)
        })
        .map_err(to_pyerr)?;
    Ok(to_flat(py, &s))
}
