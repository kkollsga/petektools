//! Outline bindings — the closing-contour (marching squares) and the
//! rectangular study-area ring.

use petektools::foundation::BBox;
use petektools::synth::{closure_outline as rs_closure, study_area_outline as rs_study};
use pyo3::prelude::*;

use super::to_array2;
use crate::geostat::Lattice;
use crate::to_pyerr;

/// The closing contour of `surface` (nested lists, `ncol × nrow`) on `lattice` at
/// level `spill_depth` — the largest closed ring as `[x, y]` 2-lists (empty if the
/// structure does not close at that level). Marching squares.
#[pyfunction]
pub fn closure_outline(
    surface: Vec<Vec<f64>>,
    lattice: &Lattice,
    spill_depth: f64,
) -> PyResult<Vec<[f64; 2]>> {
    let (ncol, nrow) = (lattice.inner.ncol, lattice.inner.nrow);
    let s = to_array2(&surface, ncol, nrow)?;
    rs_closure(&s, &lattice.inner, spill_depth).map_err(to_pyerr)
}

/// A rectangular (optionally corner-rounded) study-area outline for the extent
/// `(xmin, ymin, xmax, ymax)`: `corner_radius ≤ 0` ⇒ sharp corners; else each
/// corner is `arc_steps` segments. Returns a closed ring of `[x, y]` 2-lists.
#[pyfunction]
pub fn study_area_outline(
    xmin: f64,
    ymin: f64,
    xmax: f64,
    ymax: f64,
    corner_radius: f64,
    arc_steps: usize,
) -> Vec<[f64; 2]> {
    let e = BBox {
        xmin,
        ymin,
        xmax,
        ymax,
    };
    rs_study(&e, corner_radius, arc_steps)
}
