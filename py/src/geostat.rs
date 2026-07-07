//! `geostat` + geometry bindings — the geostatistics front-door.
//!
//! Mirrors `petektools::geostat` plus the `Lattice`/`Variogram` vocabulary the
//! kernels speak. Coordinates are `[x, y, z]` rows (the value in `z`), accepted
//! as a list of 3-lists **or** an `(n, 3)` numpy array (iteration protocol, no
//! numpy dependency). Grid fields come back as nested lists shaped
//! `field[col][row]` (`ncol × nrow`), numpy-friendly via `np.array(field)`; an
//! unestimated node is `NaN` (`float('nan')`).

use petektools::geostat::{experimental_variogram as rs_expvar, sgs as rs_sgs, SgsParams};
use petektools::geostat::{ExperimentalVariogram as RsExpVar, LocalKriging};
use petektools::{
    AnisotropicVariogram as RsAnisotropicVariogram, Lattice as RsLattice,
    SpatialVariogram as RsSpatialVariogram, Variogram as RsVariogram, VariogramModel,
};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyList};

use crate::grid::{rows, to_flat};
use crate::to_pyerr;

/// Parse a variogram model name (`"nugget"`, `"spherical"`, `"exponential"`,
/// `"gaussian"`, case-insensitive).
fn parse_model(s: &str) -> PyResult<VariogramModel> {
    match s.trim().to_ascii_lowercase().as_str() {
        "nugget" => Ok(VariogramModel::Nugget),
        "spherical" | "sph" => Ok(VariogramModel::Spherical),
        "exponential" | "exp" => Ok(VariogramModel::Exponential),
        "gaussian" | "gauss" => Ok(VariogramModel::Gaussian),
        other => Err(PyValueError::new_err(format!(
            "unknown variogram model '{other}' (expected 'nugget', 'spherical', 'exponential', or 'gaussian')"
        ))),
    }
}

fn extract_spatial_variogram(obj: &Bound<'_, PyAny>) -> PyResult<RsSpatialVariogram> {
    if let Ok(v) = obj.extract::<PyRef<'_, Variogram>>() {
        return Ok(RsSpatialVariogram::from(v.inner));
    }
    if let Ok(v) = obj.extract::<PyRef<'_, AnisotropicVariogram>>() {
        return Ok(RsSpatialVariogram::from(v.inner));
    }
    Err(PyValueError::new_err(
        "expected Variogram or AnisotropicVariogram",
    ))
}

/// A regular 2-D lattice — the target grid geometry. `Lattice(xori, yori, xinc,
/// yinc, ncol, nrow)` builds an axis-aligned grid; node `(col, row)` sits at
/// `(xori + col*xinc, yori + row*yinc)`. World units throughout.
#[pyclass(name = "Lattice", frozen)]
pub struct Lattice {
    pub(crate) inner: RsLattice,
}

#[pymethods]
impl Lattice {
    #[new]
    fn new(xori: f64, yori: f64, xinc: f64, yinc: f64, ncol: usize, nrow: usize) -> Lattice {
        Lattice {
            inner: RsLattice::regular(xori, yori, xinc, yinc, ncol, nrow),
        }
    }

    #[getter]
    fn ncol(&self) -> usize {
        self.inner.ncol
    }
    #[getter]
    fn nrow(&self) -> usize {
        self.inner.nrow
    }
    /// Origin x of node `(0, 0)` (world units).
    #[getter]
    fn xori(&self) -> f64 {
        self.inner.xori
    }
    /// Origin y of node `(0, 0)` (world units).
    #[getter]
    fn yori(&self) -> f64 {
        self.inner.yori
    }
    /// Node spacing along the column/x axis (world units).
    #[getter]
    fn xinc(&self) -> f64 {
        self.inner.xinc
    }
    /// Node spacing along the row/y axis (world units).
    #[getter]
    fn yinc(&self) -> f64 {
        self.inner.yinc
    }

    fn __repr__(&self) -> String {
        format!(
            "Lattice(xori={}, yori={}, xinc={}, yinc={}, ncol={}, nrow={})",
            self.inner.xori,
            self.inner.yori,
            self.inner.xinc,
            self.inner.yinc,
            self.inner.ncol,
            self.inner.nrow
        )
    }
}

/// A fully-specified variogram: a model shape plus `nugget` `c₀`, partial `sill`
/// `c`, and `range` `a`. Build directly (`Variogram(model, nugget, sill,
/// range)`) or infer with `Variogram.fit(model, experimental)`. For the
/// exponential/Gaussian models `range` is the *practical* range (95 % of sill).
#[pyclass(name = "Variogram", frozen)]
pub struct Variogram {
    pub(crate) inner: RsVariogram,
}

#[pymethods]
impl Variogram {
    #[new]
    fn new(model: &str, nugget: f64, sill: f64, range: f64) -> PyResult<Variogram> {
        let m = parse_model(model)?;
        RsVariogram::new(m, nugget, sill, range)
            .map(|inner| Variogram { inner })
            .map_err(to_pyerr)
    }

    /// Fit `(nugget, sill, range)` of `model` to an `ExperimentalVariogram` by
    /// pair-count weighted least squares (closed-form nugget+sill for each
    /// candidate range, range by grid search). The grid-search fit runs with the
    /// GIL released.
    #[staticmethod]
    fn fit(
        py: Python<'_>,
        model: &str,
        experimental: &ExperimentalVariogram,
    ) -> PyResult<Variogram> {
        let m = parse_model(model)?;
        // Borrow only the pure-Rust inner (the wrapper caches `Py<PyList>`s, which
        // must not cross the GIL-release boundary).
        let exp = &experimental.inner;
        py.detach(|| RsVariogram::fit(m, exp))
            .map(|inner| Variogram { inner })
            .map_err(to_pyerr)
    }

    #[getter]
    fn nugget(&self) -> f64 {
        self.inner.nugget
    }
    #[getter]
    fn sill(&self) -> f64 {
        self.inner.sill
    }
    #[getter]
    fn range(&self) -> f64 {
        self.inner.range
    }

    fn __repr__(&self) -> String {
        format!(
            "Variogram(nugget={}, sill={}, range={})",
            self.inner.nugget, self.inner.sill, self.inner.range
        )
    }
}

/// Directional variogram with horizontal major/minor ranges, vertical range,
/// and major-axis azimuth in degrees clockwise from north.
#[pyclass(name = "AnisotropicVariogram", frozen)]
pub struct AnisotropicVariogram {
    pub(crate) inner: RsAnisotropicVariogram,
}

#[pymethods]
impl AnisotropicVariogram {
    #[new]
    #[pyo3(signature = (model, major, minor, vertical, azimuth, sill=1.0, nugget=0.0))]
    fn new(
        model: &str,
        major: f64,
        minor: f64,
        vertical: f64,
        azimuth: f64,
        sill: f64,
        nugget: f64,
    ) -> PyResult<AnisotropicVariogram> {
        let m = parse_model(model)?;
        RsAnisotropicVariogram::new(m, nugget, sill, major, minor, vertical, azimuth)
            .map(|inner| AnisotropicVariogram { inner })
            .map_err(to_pyerr)
    }

    #[staticmethod]
    fn isotropic(
        model: &str,
        nugget: f64,
        sill: f64,
        range: f64,
    ) -> PyResult<AnisotropicVariogram> {
        let m = parse_model(model)?;
        RsAnisotropicVariogram::isotropic(m, nugget, sill, range)
            .map(|inner| AnisotropicVariogram { inner })
            .map_err(to_pyerr)
    }

    #[getter]
    fn nugget(&self) -> f64 {
        self.inner.nugget
    }
    #[getter]
    fn sill(&self) -> f64 {
        self.inner.sill
    }
    #[getter]
    fn major(&self) -> f64 {
        self.inner.major
    }
    #[getter]
    fn minor(&self) -> f64 {
        self.inner.minor
    }
    #[getter]
    fn vertical(&self) -> f64 {
        self.inner.vertical
    }
    #[getter]
    fn azimuth(&self) -> f64 {
        self.inner.azimuth
    }

    #[pyo3(signature = (dx, dy, dz=0.0))]
    fn anisotropic_distance(&self, dx: f64, dy: f64, dz: f64) -> f64 {
        self.inner.anisotropic_distance(dx, dy, dz)
    }

    #[pyo3(signature = (dx, dy, dz=0.0))]
    fn gamma_offset(&self, dx: f64, dy: f64, dz: f64) -> f64 {
        self.inner.gamma_offset(dx, dy, dz)
    }

    fn __repr__(&self) -> String {
        format!(
            "AnisotropicVariogram(major={}, minor={}, vertical={}, azimuth={}, nugget={}, sill={})",
            self.inner.major,
            self.inner.minor,
            self.inner.vertical,
            self.inner.azimuth,
            self.inner.nugget,
            self.inner.sill
        )
    }
}

/// An experimental (empirical) variogram: aligned `lags` / `semivariances` /
/// `counts` per populated lag class. Feed it to `Variogram.fit`.
///
/// The three aligned lists are materialized **once** at construction and cached,
/// so `.lags` / `.semivariances` / `.counts` are cheap (`Py` refcount bumps) —
/// no Vec clone + list rebuild per access.
#[pyclass(name = "ExperimentalVariogram", frozen)]
pub struct ExperimentalVariogram {
    pub(crate) inner: RsExpVar,
    lags: Py<PyList>,
    semivariances: Py<PyList>,
    counts: Py<PyList>,
}

impl ExperimentalVariogram {
    /// Build the wrapper once, pre-materializing the aligned Python lists.
    pub(crate) fn build(py: Python<'_>, inner: RsExpVar) -> PyResult<ExperimentalVariogram> {
        let lags = PyList::new(py, inner.lags.iter().copied())?.unbind();
        let semivariances = PyList::new(py, inner.semivariances.iter().copied())?.unbind();
        let counts = PyList::new(py, inner.counts.iter().copied())?.unbind();
        Ok(ExperimentalVariogram {
            inner,
            lags,
            semivariances,
            counts,
        })
    }
}

#[pymethods]
impl ExperimentalVariogram {
    /// Mean pair separation `h̄ₖ` per retained lag class.
    #[getter]
    fn lags(&self, py: Python<'_>) -> Py<PyList> {
        self.lags.clone_ref(py)
    }
    /// Average semivariance `γ̂(hₖ)` per retained lag class.
    #[getter]
    fn semivariances(&self, py: Python<'_>) -> Py<PyList> {
        self.semivariances.clone_ref(py)
    }
    /// Data-pair count per retained lag class.
    #[getter]
    fn counts(&self, py: Python<'_>) -> Py<PyList> {
        self.counts.clone_ref(py)
    }

    fn __len__(&self) -> usize {
        self.inner.len()
    }

    fn __repr__(&self) -> String {
        format!("ExperimentalVariogram({} lag classes)", self.inner.len())
    }
}

/// Omnidirectional experimental variogram of `coords` (`[x, y, z]` rows, value
/// in `z`): `n_lags` bins of width `lag`, empty bins dropped, each class
/// reporting its mean pair separation. Errors on < 2 data or non-positive
/// `lag` / zero `n_lags`. The O(n²) pairing runs with the GIL released.
#[pyfunction]
pub fn experimental_variogram(
    py: Python<'_>,
    coords: Vec<[f64; 3]>,
    lag: f64,
    n_lags: usize,
) -> PyResult<ExperimentalVariogram> {
    let inner = py
        .detach(|| rs_expvar(&coords, lag, n_lags))
        .map_err(to_pyerr)?;
    ExperimentalVariogram::build(py, inner)
}

/// A pair of `ncol × nrow` nested-list fields (`field[col][row]`).
type FieldPair = (Vec<Vec<f64>>, Vec<Vec<f64>>);

/// The flat crossing of a field pair: two little-endian `f64` `bytes` buffers +
/// the shared `(ncol, nrow)` shape.
type FlatFieldPair<'py> = (Bound<'py, PyBytes>, Bound<'py, PyBytes>, (usize, usize));

/// Moving-neighbourhood ordinary kriging of `coords` onto `lattice` with
/// `variogram`, using up to `max_neighbours` data within `radius` per node.
/// Returns `(estimate, variance)` — two `ncol × nrow` nested-list fields
/// (`field[col][row]`); a node with no data in range is `NaN` in both. The solve
/// runs with the GIL released. For the flat crossing see `local_kriging_grid_flat`.
#[pyfunction]
pub fn local_kriging_grid(
    py: Python<'_>,
    coords: Vec<[f64; 3]>,
    lattice: &Lattice,
    variogram: &Variogram,
    max_neighbours: usize,
    radius: f64,
) -> PyResult<FieldPair> {
    let lk = LocalKriging::new(variogram.inner, max_neighbours, radius).map_err(to_pyerr)?;
    let lat = lattice.inner.clone();
    let (est, var) = py.detach(|| lk.krige(&coords, &lat)).map_err(to_pyerr)?;
    Ok((rows(&est), rows(&var)))
}

/// Flat crossing of [`local_kriging_grid`]: returns
/// `(estimate_bytes, variance_bytes, (ncol, nrow))` — the two fields as single
/// little-endian `f64` `bytes` buffers (`field[col][row]`) instead of boxed
/// nested lists. `np.frombuffer(estimate_bytes, dtype='<f8').reshape(ncol, nrow)`.
#[pyfunction]
pub fn local_kriging_grid_flat<'py>(
    py: Python<'py>,
    coords: Vec<[f64; 3]>,
    lattice: &Lattice,
    variogram: &Variogram,
    max_neighbours: usize,
    radius: f64,
) -> PyResult<FlatFieldPair<'py>> {
    let lk = LocalKriging::new(variogram.inner, max_neighbours, radius).map_err(to_pyerr)?;
    let lat = lattice.inner.clone();
    let (est, var) = py.detach(|| lk.krige(&coords, &lat)).map_err(to_pyerr)?;
    let (eb, shape) = to_flat(py, &est);
    let (vb, _) = to_flat(py, &var);
    Ok((eb, vb, shape))
}

/// Sequential Gaussian simulation of `coords` onto `lattice`, conditioned
/// exactly on the data, seeded (`seed` reproduces the field bit-for-bit). The
/// `variogram` should be fitted on normal-score data (total sill ~1). Returns
/// the `ncol × nrow` simulated field in **data space** as nested lists
/// (`field[col][row]`). Errors on empty input or invalid neighbourhood params.
/// The simulation runs with the GIL released. For the flat crossing see `sgs_flat`.
#[pyfunction]
pub fn sgs(
    py: Python<'_>,
    coords: Vec<[f64; 3]>,
    lattice: &Lattice,
    variogram: &Bound<'_, PyAny>,
    max_neighbours: usize,
    radius: f64,
    seed: u64,
) -> PyResult<Vec<Vec<f64>>> {
    let variogram = extract_spatial_variogram(variogram)?;
    let params = SgsParams::new(variogram, max_neighbours, radius, seed).map_err(to_pyerr)?;
    let lat = lattice.inner.clone();
    let field = py
        .detach(|| rs_sgs(&coords, &lat, &params))
        .map_err(to_pyerr)?;
    Ok(rows(&field))
}

/// Flat crossing of [`sgs`]: returns `(field_bytes, (ncol, nrow))` — the
/// simulated field as one little-endian `f64` `bytes` buffer (`field[col][row]`)
/// instead of a boxed nested list.
/// `np.frombuffer(field_bytes, dtype='<f8').reshape(ncol, nrow)`.
#[pyfunction]
pub fn sgs_flat<'py>(
    py: Python<'py>,
    coords: Vec<[f64; 3]>,
    lattice: &Lattice,
    variogram: &Bound<'_, PyAny>,
    max_neighbours: usize,
    radius: f64,
    seed: u64,
) -> PyResult<(Bound<'py, PyBytes>, (usize, usize))> {
    let variogram = extract_spatial_variogram(variogram)?;
    let params = SgsParams::new(variogram, max_neighbours, radius, seed).map_err(to_pyerr)?;
    let lat = lattice.inner.clone();
    let field = py
        .detach(|| rs_sgs(&coords, &lat, &params))
        .map_err(to_pyerr)?;
    Ok(to_flat(py, &field))
}
