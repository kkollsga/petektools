//! Facies bindings — the truncated-Gaussian sand/shale series and the
//! facies-composed porosity generator.

use petektools::synth::{
    synth_facies_series as rs_facies, synth_por_with_facies as rs_por, Facies, MomentSpec,
};
use pyo3::prelude::*;

use crate::to_pyerr;

/// A binary sand/shale series of `n` samples at `depth_step` m, sand proportion =
/// `ntg_target`, mean bed thickness ~ `bed_scale_m`. Returns a list of ints
/// (`1` = sand, `0` = shale). Seeded/reproducible.
#[pyfunction]
pub fn synth_facies_series(
    py: Python<'_>,
    n: usize,
    depth_step: f64,
    ntg_target: f64,
    bed_scale_m: f64,
    seed: u64,
) -> PyResult<Vec<u8>> {
    let f = py
        .detach(|| rs_facies(n, depth_step, ntg_target, bed_scale_m, seed))
        .map_err(to_pyerr)?;
    Ok(f.into_iter().map(|x| x.code()).collect())
}

/// Porosity composed onto a `facies` series (list of ints, `1` = sand): each
/// sample drawn from the `sand`/`shale` `{mean, std}` target per its facies, over a
/// shared AR(1) driver of length = `facies` (correlation length `corr_length_m`).
/// Returns a `[0,1]` porosity list aligned with `facies`. Seeded/reproducible.
#[pyfunction]
#[allow(clippy::too_many_arguments)]
pub fn synth_por_with_facies(
    py: Python<'_>,
    facies: Vec<i64>,
    depth_step: f64,
    sand_mean: f64,
    sand_std: f64,
    shale_mean: f64,
    shale_std: f64,
    corr_length_m: f64,
    seed: u64,
) -> PyResult<Vec<f64>> {
    let fac: Vec<Facies> = facies
        .iter()
        .map(|&c| if c != 0 { Facies::Sand } else { Facies::Shale })
        .collect();
    let sand = MomentSpec::new(sand_mean, sand_std).map_err(to_pyerr)?;
    let shale = MomentSpec::new(shale_mean, shale_std).map_err(to_pyerr)?;
    py.detach(|| rs_por(&fac, depth_step, sand, shale, corr_length_m, seed))
        .map_err(to_pyerr)
}
