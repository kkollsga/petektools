//! `aggregate` + `reservoir_summary` bindings — the realization-set helpers.

use petektools::sampling::{
    aggregate as rs_aggregate, reservoir_summary as rs_summary, Correlation,
};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;

use crate::to_pyerr;

/// The P90 (low) / P50 (mid) / P10 (high) / mean digest of a realization set.
///
/// Fields follow the **oil-industry exceedance convention** (P90 = low): `p90`
/// is the value exceeded 90 % of the time (statistical 10th percentile), `p10`
/// the high (statistical 90th), so `p90 <= p50 <= p10`. Percentiles are type-7
/// (Excel `PERCENTILE` parity). Read-only getters plus a `to_dict()`.
#[pyclass(name = "ReservoirSummary", frozen)]
pub struct ReservoirSummary {
    #[pyo3(get)]
    p90: f64,
    #[pyo3(get)]
    p50: f64,
    #[pyo3(get)]
    p10: f64,
    #[pyo3(get)]
    mean: f64,
}

#[pymethods]
impl ReservoirSummary {
    /// The four fields as a plain `dict` (`{"p90", "p50", "p10", "mean"}`).
    fn to_dict(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
        let d = pyo3::types::PyDict::new(py);
        d.set_item("p90", self.p90)?;
        d.set_item("p50", self.p50)?;
        d.set_item("p10", self.p10)?;
        d.set_item("mean", self.mean)?;
        Ok(d.into_any().unbind())
    }

    fn __repr__(&self) -> String {
        format!(
            "ReservoirSummary(p90={}, p50={}, p10={}, mean={})",
            self.p90, self.p50, self.p10, self.mean
        )
    }
}

/// Summarise `data` (one realization per element) into a [`ReservoirSummary`]
/// under the oil-industry P90 = low convention. Errors on empty input.
#[pyfunction]
pub fn reservoir_summary(data: Vec<f64>) -> PyResult<ReservoirSummary> {
    let s = rs_summary(&data).map_err(to_pyerr)?;
    Ok(ReservoirSummary {
        p90: s.p90,
        p50: s.p50,
        p10: s.p10,
        mean: s.mean,
    })
}

/// Sum per-segment realization vectors index-wise into a field total under a
/// dependence assumption. `correlation` is `"independent"` (sum as-is) or
/// `"comonotonic"` (sort each segment ascending, then sum rank-for-rank — the
/// fully-dependent low-together/high-together bound). The result length is the
/// shortest segment's; an empty input (or any empty segment) gives `[]`.
#[pyfunction]
#[pyo3(signature = (segments, correlation = "independent"))]
pub fn aggregate(segments: Vec<Vec<f64>>, correlation: &str) -> PyResult<Vec<f64>> {
    let corr = match correlation.trim().to_ascii_lowercase().as_str() {
        "independent" | "indep" => Correlation::Independent,
        "comonotonic" | "comono" => Correlation::Comonotonic,
        other => {
            return Err(PyValueError::new_err(format!(
                "unknown correlation '{other}' (expected 'independent' or 'comonotonic')"
            )))
        }
    };
    let views: Vec<&[f64]> = segments.iter().map(|s| s.as_slice()).collect();
    Ok(rs_aggregate(&views, corr))
}
