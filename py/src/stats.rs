//! `stats` bindings — the curated descriptive-statistics front-door.
//!
//! Free functions mirroring `petektools::stats`. Every vector argument accepts
//! any Python sequence (a `list` **or** a numpy array — extracted via iteration,
//! no numpy dependency); results are plain floats. Percentiles use the **type-7**
//! definition (Excel `PERCENTILE` / R default parity): `p` is in `[0, 100]`, so
//! `percentile([1, 2, 3, 4, 5], 25) == 2.0`.

use petektools::stats;
use pyo3::prelude::*;

use crate::to_pyerr;

/// Arithmetic mean of `data`. Errors on empty input.
#[pyfunction]
pub fn mean(data: Vec<f64>) -> PyResult<f64> {
    stats::mean(&data).map_err(to_pyerr)
}

/// Unbiased sample variance (`n − 1` denominator). A single value yields `0.0`.
#[pyfunction]
pub fn variance(data: Vec<f64>) -> PyResult<f64> {
    stats::variance(&data).map_err(to_pyerr)
}

/// Unbiased sample standard deviation (`√variance`).
#[pyfunction]
pub fn std(data: Vec<f64>) -> PyResult<f64> {
    stats::std_dev(&data).map_err(to_pyerr)
}

/// The `p`-th percentile (`p` in `[0, 100]`), type-7 (Excel `PERCENTILE`
/// parity): `percentile([1, 2, 3, 4, 5], 25) == 2.0`.
#[pyfunction]
pub fn percentile(data: Vec<f64>, p: f64) -> PyResult<f64> {
    stats::percentile(&data, p).map_err(to_pyerr)
}

/// The median (50th percentile) of `data`.
#[pyfunction]
pub fn median(data: Vec<f64>) -> PyResult<f64> {
    stats::median(&data).map_err(to_pyerr)
}

/// Weighted arithmetic mean of `values` under `weights` (equal length,
/// non-negative weights summing > 0).
#[pyfunction]
pub fn weighted_mean(values: Vec<f64>, weights: Vec<f64>) -> PyResult<f64> {
    stats::weighted_mean(&values, &weights).map_err(to_pyerr)
}

/// Weighted (reliability-weighted, unbiased) sample variance.
#[pyfunction]
pub fn weighted_variance(values: Vec<f64>, weights: Vec<f64>) -> PyResult<f64> {
    stats::weighted_variance(&values, &weights).map_err(to_pyerr)
}

/// Weighted sample standard deviation (`√weighted_variance`).
#[pyfunction]
pub fn weighted_std(values: Vec<f64>, weights: Vec<f64>) -> PyResult<f64> {
    stats::weighted_std_dev(&values, &weights).map_err(to_pyerr)
}

/// Weighted `p`-th percentile (`p` in `[0, 100]`), consistent with the
/// unweighted type-7 definition on equal weights.
#[pyfunction]
pub fn weighted_percentile(values: Vec<f64>, weights: Vec<f64>, p: f64) -> PyResult<f64> {
    stats::weighted_percentile(&values, &weights, p).map_err(to_pyerr)
}
