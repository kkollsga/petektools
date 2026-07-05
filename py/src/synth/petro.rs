//! Coupled-petrophysics bindings — the `PetroZoneSpec` target, the coupled
//! porosity + derived net-flag generator, and the NTG display curve.

use std::collections::HashMap;

use petektools::synth::{
    ntg_curve as rs_ntg_curve, synth_petro_curves as rs_petro, MomentSpec,
    PetroZoneSpec as RsPetroZoneSpec,
};
use pyo3::prelude::*;

use crate::to_pyerr;

/// One zone's **coupled** petrophysics target: a porosity generator whose net flag
/// is *derived* from porosity by `net_cutoff` (`net_flag = phie ≥ net_cutoff`),
/// calibrated so the realized series hits the quoted `ntg_target` and the net-rock
/// `(net_por_mean, net_por_std)`. `nonnet_por_*` is the shale (non-net) porosity
/// distribution. The sand porosity distribution and facies proportion are solved
/// internally. Requires `0 < net_cutoff < 1`, `0 < ntg_target < 1`, feasible `[0,1]`
/// moment targets, and positive length scales.
#[pyclass(name = "PetroZoneSpec", frozen, from_py_object)]
#[derive(Clone)]
pub struct PetroZoneSpec {
    pub(crate) inner: RsPetroZoneSpec,
}

#[pymethods]
impl PetroZoneSpec {
    #[new]
    #[pyo3(signature = (
        ntg_target,
        net_por_mean,
        net_por_std,
        nonnet_por_mean,
        nonnet_por_std,
        bed_scale_m,
        correlation_len_m,
        net_cutoff = petektools::synth::DEFAULT_NET_CUTOFF,
    ))]
    #[allow(clippy::too_many_arguments)]
    fn new(
        ntg_target: f64,
        net_por_mean: f64,
        net_por_std: f64,
        nonnet_por_mean: f64,
        nonnet_por_std: f64,
        bed_scale_m: f64,
        correlation_len_m: f64,
        net_cutoff: f64,
    ) -> PyResult<PetroZoneSpec> {
        let net_por = MomentSpec::new(net_por_mean, net_por_std).map_err(to_pyerr)?;
        let nonnet_por = MomentSpec::new(nonnet_por_mean, nonnet_por_std).map_err(to_pyerr)?;
        RsPetroZoneSpec::new(
            net_cutoff,
            ntg_target,
            net_por,
            nonnet_por,
            bed_scale_m,
            correlation_len_m,
        )
        .map(|inner| PetroZoneSpec { inner })
        .map_err(to_pyerr)
    }

    #[getter]
    fn net_cutoff(&self) -> f64 {
        self.inner.net_cutoff
    }
    #[getter]
    fn ntg_target(&self) -> f64 {
        self.inner.ntg_target
    }
    #[getter]
    fn net_por_mean(&self) -> f64 {
        self.inner.net_por.mean
    }
    #[getter]
    fn net_por_std(&self) -> f64 {
        self.inner.net_por.std
    }
    #[getter]
    fn nonnet_por_mean(&self) -> f64 {
        self.inner.nonnet_por.mean
    }
    #[getter]
    fn nonnet_por_std(&self) -> f64 {
        self.inner.nonnet_por.std
    }
    #[getter]
    fn bed_scale_m(&self) -> f64 {
        self.inner.bed_scale_m
    }
    #[getter]
    fn correlation_len_m(&self) -> f64 {
        self.inner.correlation_len_m
    }

    fn __repr__(&self) -> String {
        let z = &self.inner;
        format!(
            "PetroZoneSpec(net_cutoff={}, ntg_target={}, net_por=({}, {}), \
             nonnet_por=({}, {}), bed_scale_m={}, correlation_len_m={})",
            z.net_cutoff,
            z.ntg_target,
            z.net_por.mean,
            z.net_por.std,
            z.nonnet_por.mean,
            z.nonnet_por.std,
            z.bed_scale_m,
            z.correlation_len_m
        )
    }
}

/// The **coupled** porosity + derived net-flag curve for one `zone`, `n_samples`
/// samples spaced `depth_step` m (top first). The net flag is `phie ≥ net_cutoff`
/// by construction; the generator solves a facies mixture so the realized series
/// hits `ntg_target` and the net-rock moments (see `PetroZoneSpec`). Returns a dict
/// `{"phie": [float], "net_flag": [int] (1/0)}`. Errors on an infeasible spec (with
/// the achievable bound stated). Seeded/reproducible.
#[pyfunction]
pub fn synth_petro_curves(
    py: Python<'_>,
    zone: PetroZoneSpec,
    depth_step: f64,
    n_samples: usize,
    seed: u64,
) -> PyResult<HashMap<String, Vec<f64>>> {
    let zi = &zone.inner;
    let curves = py
        .detach(|| rs_petro(zi, depth_step, n_samples, seed))
        .map_err(to_pyerr)?;
    let mut out: HashMap<String, Vec<f64>> = HashMap::new();
    out.insert("phie".to_string(), curves.phie);
    out.insert(
        "net_flag".to_string(),
        curves
            .net_flag
            .into_iter()
            .map(|b| if b { 1.0 } else { 0.0 })
            .collect(),
    );
    Ok(out)
}

/// A continuous NTG **display** curve from a derived `net_flag` (list of numbers,
/// non-zero = net — accepts the `1.0`/`0.0` floats `synth_petro_curves` returns, or
/// `1`/`0` ints): the centred running mean of the flag over a `window_m`-metre window
/// (samples spaced `depth_step` m). Returns a `[0,1]` list aligned with `net_flag`.
#[pyfunction]
pub fn ntg_curve(net_flag: Vec<f64>, depth_step: f64, window_m: f64) -> PyResult<Vec<f64>> {
    let flags: Vec<bool> = net_flag.iter().map(|&v| v != 0.0).collect();
    rs_ntg_curve(&flags, depth_step, window_m).map_err(to_pyerr)
}
