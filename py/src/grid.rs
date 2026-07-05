//! Grid boundary crossing — the shared `Array2<f64>` ↔ Python marshalling.
//!
//! Two crossings, both shaped `field[col][row]` (`ncol × nrow`, `NaN` =
//! undefined):
//!
//! - **nested** ([`rows`]) — the original, ergonomic `list[list[float]]`
//!   (`np.array(field)`-friendly). Boxed list-of-lists: every element becomes a
//!   Python `float` object (≈ 1M allocations at a 1M-node grid), and a nested
//!   input is re-copied element-by-element into the `Array2`.
//! - **flat** ([`to_flat`] / [`from_flat`]) — a single little-endian `f64`
//!   **`bytes`** buffer (row-major, `field[col][row]`) plus the `(ncol, nrow)`
//!   shape. The crossing is *one `memcpy`* each way — no per-element Python
//!   objects. Wrap on the Python side with
//!   `np.frombuffer(buf, dtype='<f8').reshape(ncol, nrow)` (and `.tobytes()` to
//!   feed one back). All target platforms are little-endian, matching the
//!   `store` / v3-wire convention, so the in-memory `f64` bytes are the wire
//!   bytes.
//!
//! The nested API is unchanged; the flat variants are strictly additive.

use ndarray::Array2;
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyBytes;

/// A `(ncol × nrow)` `Array2` → nested list `out[col][row]` (the original
/// crossing). Kept for the ergonomic, numpy-free path.
pub fn rows(a: &Array2<f64>) -> Vec<Vec<f64>> {
    a.outer_iter().map(|r| r.to_vec()).collect()
}

/// A `(ncol × nrow)` `Array2` → `(bytes, (ncol, nrow))`: the field's contiguous
/// little-endian `f64` buffer (row-major, `field[col][row]`) in a single Python
/// `bytes`, plus its shape. One `memcpy` across the boundary.
pub fn to_flat<'py>(py: Python<'py>, a: &Array2<f64>) -> (Bound<'py, PyBytes>, (usize, usize)) {
    let (ncol, nrow) = a.dim();
    // Contiguous, row-major view (a no-op borrow for our freshly-built arrays).
    let std = a.as_standard_layout();
    let slice = std
        .as_slice()
        .expect("standard-layout Array2 is contiguous");
    // All targets are little-endian, so the in-memory f64 bytes ARE the LE wire
    // bytes; `PyBytes::new` performs the single copy into the Python buffer.
    let bytes: &[u8] = bytemuck::cast_slice(slice);
    (PyBytes::new(py, bytes), (ncol, nrow))
}

/// A flat little-endian `f64` `bytes` buffer + `(ncol, nrow)` shape → a
/// `(ncol × nrow)` `Array2` (`field[col][row]`, row-major). The inverse of
/// [`to_flat`]; one pass, no per-element Python objects. Errors if the buffer
/// length does not match `ncol · nrow · 8`.
pub fn from_flat(bytes: &[u8], ncol: usize, nrow: usize) -> PyResult<Array2<f64>> {
    let expected = ncol
        .checked_mul(nrow)
        .and_then(|n| n.checked_mul(8))
        .ok_or_else(|| PyValueError::new_err("flat grid shape overflow"))?;
    if bytes.len() != expected {
        return Err(PyValueError::new_err(format!(
            "flat grid is {} bytes, expected {ncol}×{nrow}×8 = {expected} (little-endian f64, field[col][row])",
            bytes.len()
        )));
    }
    // The PyBytes buffer is not guaranteed 8-aligned, so read each f64 from its
    // LE bytes (still one linear pass — no Python float objects).
    let mut data = Vec::with_capacity(ncol * nrow);
    for chunk in bytes.chunks_exact(8) {
        data.push(f64::from_le_bytes(chunk.try_into().unwrap()));
    }
    Array2::from_shape_vec((ncol, nrow), data)
        .map_err(|e| PyValueError::new_err(format!("flat grid shape: {e}")))
}
