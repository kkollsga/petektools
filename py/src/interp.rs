//! `interp1d` binding — 1-D interpolation over strictly increasing samples.

use petektools::{interp1d as rs_interp1d, Interp1dMethod};
use pyo3::prelude::*;

use crate::to_pyerr;

/// Interpolate a 1-D series at `query` positions.
///
/// `x` must be finite and strictly increasing, with the same length as `y`.
/// Supported methods are `"nearest"`/`"closest"`, `"previous"`/`"ffill"`,
/// `"next"`/`"bfill"`, `"linear"`, and `"cubic"`/`"spline"` (natural cubic).
/// Out-of-bounds queries return `NaN` unless `extrapolate=True`.
#[pyfunction]
#[pyo3(signature = (x, y, query, method = "linear", extrapolate = false))]
pub fn interp1d(
    py: Python<'_>,
    x: Vec<f64>,
    y: Vec<f64>,
    query: Vec<f64>,
    method: &str,
    extrapolate: bool,
) -> PyResult<Vec<f64>> {
    let method = Interp1dMethod::parse(method).map_err(to_pyerr)?;
    py.detach(|| rs_interp1d(&x, &y, &query, method, extrapolate))
        .map_err(to_pyerr)
}
