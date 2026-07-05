//! Log-series bindings — the `ZoneSpec` target and the zone-conformant,
//! depth-autocorrelated `synth_log_series` generator.

use petektools::synth::{
    synth_log_series as rs_log, zone_sample_counts as rs_counts, ZoneSpec as RsZoneSpec,
};
use pyo3::prelude::*;

use crate::to_pyerr;

/// One zone's petrophysical target for a synthetic log: a `thickness_m`, the
/// property target `{mean, std}` (a `[0,1]` fraction), and the depth
/// autocorrelation length `corr_length_m` (bed scale). Requires `0 < mean < 1`,
/// `std > 0` with `std² < mean·(1−mean)`, and positive thickness / correlation
/// length.
#[pyclass(name = "ZoneSpec", frozen, from_py_object)]
#[derive(Clone)]
pub struct ZoneSpec {
    pub(crate) inner: RsZoneSpec,
}

#[pymethods]
impl ZoneSpec {
    #[new]
    fn new(thickness_m: f64, mean: f64, std: f64, corr_length_m: f64) -> PyResult<ZoneSpec> {
        RsZoneSpec::new(thickness_m, mean, std, corr_length_m)
            .map(|inner| ZoneSpec { inner })
            .map_err(to_pyerr)
    }

    #[getter]
    fn thickness_m(&self) -> f64 {
        self.inner.thickness_m
    }
    #[getter]
    fn mean(&self) -> f64 {
        self.inner.mean
    }
    #[getter]
    fn std(&self) -> f64 {
        self.inner.std
    }
    #[getter]
    fn corr_length_m(&self) -> f64 {
        self.inner.corr_length_m
    }

    fn __repr__(&self) -> String {
        format!(
            "ZoneSpec(thickness_m={}, mean={}, std={}, corr_length_m={})",
            self.inner.thickness_m, self.inner.mean, self.inner.std, self.inner.corr_length_m
        )
    }
}

/// Per-zone depth-sample counts of the `zones` stack at `depth_step` — the shared
/// depth layout of a stack's logs.
#[pyfunction]
pub fn zone_sample_counts(zones: Vec<ZoneSpec>, depth_step: f64) -> Vec<usize> {
    let z: Vec<RsZoneSpec> = zones.iter().map(|z| z.inner).collect();
    rs_counts(&z, depth_step)
}

/// One continuous, depth-autocorrelated log over the `zones` stack, sampled every
/// `depth_step` m (top first). Each zone hits its `{mean, std}` in `[0,1]`;
/// `transition_beds` blends the statistics across each internal boundary
/// (`0` = hard). Seeded/reproducible. Returns the series (a list of floats).
#[pyfunction]
pub fn synth_log_series(
    py: Python<'_>,
    zones: Vec<ZoneSpec>,
    depth_step: f64,
    transition_beds: usize,
    seed: u64,
) -> PyResult<Vec<f64>> {
    let z: Vec<RsZoneSpec> = zones.iter().map(|z| z.inner).collect();
    py.detach(|| rs_log(&z, depth_step, transition_beds, seed))
        .map_err(to_pyerr)
}
