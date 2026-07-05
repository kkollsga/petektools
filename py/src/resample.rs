//! `resample` binding — grid → grid resampling over a georeferencing `Lattice`.
//!
//! `src_grid` is a nested list (or numpy array) shaped `field[col][row]`
//! (`ncol × nrow`), matching `src_georef` and the geostat field convention;
//! `NaN` = undefined. Both lattices are `Lattice` objects. `method` is
//! `"bilinear"` (default) or `"nearest"`. Returns the resampled
//! `target.ncol × target.nrow` field as nested lists (`NaN` where undefined /
//! outside the source extent).

use ndarray::Array2;
use petektools::{resample as rs_resample, ResampleMethod};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyBytes;

use crate::geostat::Lattice;
use crate::grid::{from_flat, rows, to_flat};
use crate::to_pyerr;

/// Parse a resample method name (`"bilinear"` / `"nearest"`, case-insensitive).
fn parse_method(s: &str) -> PyResult<ResampleMethod> {
    match s.trim().to_ascii_lowercase().as_str() {
        "bilinear" | "linear" => Ok(ResampleMethod::Bilinear),
        "nearest" | "nn" => Ok(ResampleMethod::Nearest),
        other => Err(PyValueError::new_err(format!(
            "unknown resample method '{other}' (expected 'bilinear' or 'nearest')"
        ))),
    }
}

/// Build an `(ncol × nrow)` `Array2` from a nested list `field[col][row]`,
/// checking the rows are rectangular and match `src_georef`.
fn to_array2(grid: &[Vec<f64>], ncol: usize, nrow: usize) -> PyResult<Array2<f64>> {
    if grid.len() != ncol || grid.iter().any(|c| c.len() != nrow) {
        return Err(PyValueError::new_err(format!(
            "src_grid must be a rectangular {ncol}×{nrow} (ncol×nrow) nested list matching src_georef"
        )));
    }
    let mut a = Array2::<f64>::zeros((ncol, nrow));
    for (i, col) in grid.iter().enumerate() {
        for (j, &v) in col.iter().enumerate() {
            a[[i, j]] = v;
        }
    }
    Ok(a)
}

/// Resample `src_grid` (values on `src_georef`) onto `target`'s node lattice.
/// `src_grid` is nested lists `field[col][row]` (`ncol × nrow`, `NaN` =
/// undefined); `method` is `"bilinear"` (default) or `"nearest"`. Returns the
/// `target.ncol × target.nrow` field as nested lists (`NaN` outside the source
/// extent or where the null policy propagates a hole).
#[pyfunction]
#[pyo3(signature = (src_grid, src_georef, target, method = "bilinear"))]
pub fn resample(
    py: Python<'_>,
    src_grid: Vec<Vec<f64>>,
    src_georef: &Lattice,
    target: &Lattice,
    method: &str,
) -> PyResult<Vec<Vec<f64>>> {
    let m = parse_method(method)?;
    let src = to_array2(&src_grid, src_georef.inner.ncol, src_georef.inner.nrow)?;
    let sg = src_georef.inner.clone();
    let tg = target.inner.clone();
    let out = py
        .detach(|| rs_resample(&src, &sg, &tg, m))
        .map_err(to_pyerr)?;
    Ok(rows(&out))
}

/// Flat crossing of [`resample`]: `src_grid` is a little-endian `f64` `bytes`
/// buffer (`field[col][row]`, from `np.ascontiguousarray(a, '<f8').tobytes()`)
/// matching `src_georef`; returns `(field_bytes, (ncol, nrow))` for the target.
/// Both crossings are one `memcpy` (no boxed nested lists / per-cell floats).
/// `np.frombuffer(field_bytes, dtype='<f8').reshape(ncol, nrow)`.
#[pyfunction]
#[pyo3(signature = (src_grid, src_georef, target, method = "bilinear"))]
pub fn resample_flat<'py>(
    py: Python<'py>,
    src_grid: &[u8],
    src_georef: &Lattice,
    target: &Lattice,
    method: &str,
) -> PyResult<(Bound<'py, PyBytes>, (usize, usize))> {
    let m = parse_method(method)?;
    let src = from_flat(src_grid, src_georef.inner.ncol, src_georef.inner.nrow)?;
    let sg = src_georef.inner.clone();
    let tg = target.inner.clone();
    let out = py
        .detach(|| rs_resample(&src, &sg, &tg, m))
        .map_err(to_pyerr)?;
    Ok(to_flat(py, &out))
}
