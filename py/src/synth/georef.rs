//! World-frame binding — the fictional `Georef` origin that world-places a
//! `Lattice` and translates locally-built points into the same frame.

use petektools::synth::Georef as RsGeoref;
use pyo3::prelude::*;

use crate::geostat::Lattice;
use crate::to_pyerr;

/// A fictional **world-frame** origin (a UTM-style easting/northing) for placing a
/// synthetic asset in the world — the default posture (the frame escapes the
/// testing doctrine feeds trace to fixtures built in one tidy local frame). In
/// petekTools the georeference *is* the `Lattice`; `Georef` is a convenience over
/// that: it builds a world-placed `Lattice` and translates locally-built points
/// into the same frame. `Georef()` uses the documented fictional origin;
/// `Georef(east0, north0)` a chosen one.
#[pyclass(name = "Georef", frozen)]
pub struct Georef {
    inner: RsGeoref,
}

#[pymethods]
impl Georef {
    #[new]
    #[pyo3(signature = (east0=None, north0=None))]
    fn new(east0: Option<f64>, north0: Option<f64>) -> PyResult<Georef> {
        let inner = match (east0, north0) {
            (None, None) => RsGeoref::fictional(),
            (Some(e), Some(n)) => RsGeoref::new(e, n).map_err(to_pyerr)?,
            _ => {
                return Err(pyo3::exceptions::PyValueError::new_err(
                    "Georef: pass both east0 and north0, or neither (fictional default)"
                        .to_string(),
                ))
            }
        };
        Ok(Georef { inner })
    }

    #[getter]
    fn east0(&self) -> f64 {
        self.inner.east0
    }
    #[getter]
    fn north0(&self) -> f64 {
        self.inner.north0
    }

    /// The origin as an `[east, north]` world point.
    fn origin(&self) -> [f64; 2] {
        self.inner.origin()
    }

    /// A world-placed `Lattice` of `ncol × nrow` nodes at spacing `(xinc, yinc)`,
    /// node `(0, 0)` pinned to this origin.
    fn lattice(&self, xinc: f64, yinc: f64, ncol: usize, nrow: usize) -> Lattice {
        Lattice {
            inner: self.inner.lattice(xinc, yinc, ncol, nrow),
        }
    }

    /// Translate a local `[x, y]` (from `(0, 0)`) into this world frame.
    fn place_point(&self, local: [f64; 2]) -> [f64; 2] {
        self.inner.place_point(local)
    }

    /// Translate a list of local `[x, y]` points into this world frame.
    fn place_points(&self, locals: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
        self.inner.place_points(&locals)
    }

    fn __repr__(&self) -> String {
        format!(
            "Georef(east0={}, north0={})",
            self.inner.east0, self.inner.north0
        )
    }
}
