//! Thin PyO3 bindings over the `petektools` Rust library — the source of the
//! `petektools` Python wheel (built by maturin). Bindings only marshal; all
//! logic lives in Rust.
//!
//! The surface mirrors `API.md` §"Python (PyO3) surface", in priority order:
//! **sampling** (every `Sampler` variant + the `.clamped()` combinator + a
//! seeded `Rng` for reproducibility parity with the Rust engine), **stats** (the
//! curated descriptive + weighted family), the realization-set helpers
//! **aggregate** / **reservoir_summary**, the **geostat** front-door
//! (`experimental_variogram`, `Variogram` fit/params, `local_kriging_grid`,
//! `sgs`, with the `Lattice` geometry), the grid → grid **resample**, and the
//! SI/metric **units** reporting layer.
//!
//! Vector inputs accept a list *or* a numpy array (extracted via the iteration
//! protocol — no numpy dependency); outputs are plain floats/lists. The P90 =
//! low (exceedance) convention is documented once on `ReservoirSummary` and the
//! `reservoir_summary` docstring.

mod aggregate;
mod formula;
mod geostat;
mod grid;
mod resample;
mod sampling;
mod stats;
mod synth;
mod units;

use petektools::AlgoError;
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;

/// Convert a Rust `AlgoError` into a Python `ValueError`.
pub(crate) fn to_pyerr(e: AlgoError) -> PyErr {
    PyValueError::new_err(e.to_string())
}

/// The compiled extension module (`petektools._petektools`); re-exported by the
/// `petektools` Python package's `__init__`.
#[pymodule]
fn _petektools(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;

    // sampling
    m.add_class::<sampling::Rng>()?;
    m.add_class::<sampling::PySampler>()?;
    m.add_class::<sampling::PyClamped>()?;

    // stats
    m.add_function(wrap_pyfunction!(stats::mean, m)?)?;
    m.add_function(wrap_pyfunction!(stats::variance, m)?)?;
    m.add_function(wrap_pyfunction!(stats::std, m)?)?;
    m.add_function(wrap_pyfunction!(stats::percentile, m)?)?;
    m.add_function(wrap_pyfunction!(stats::median, m)?)?;
    m.add_function(wrap_pyfunction!(stats::weighted_mean, m)?)?;
    m.add_function(wrap_pyfunction!(stats::weighted_variance, m)?)?;
    m.add_function(wrap_pyfunction!(stats::weighted_std, m)?)?;
    m.add_function(wrap_pyfunction!(stats::weighted_percentile, m)?)?;

    // aggregate + reservoir_summary
    m.add_class::<aggregate::ReservoirSummary>()?;
    m.add_function(wrap_pyfunction!(aggregate::reservoir_summary, m)?)?;
    m.add_function(wrap_pyfunction!(aggregate::aggregate, m)?)?;

    // formula — domain-free expression parsing/evaluation
    m.add_function(wrap_pyfunction!(formula::formula_info, m)?)?;
    m.add_function(wrap_pyfunction!(formula::evaluate_formula, m)?)?;

    // geostat + geometry
    m.add_class::<geostat::Lattice>()?;
    m.add_class::<geostat::Variogram>()?;
    m.add_class::<geostat::AnisotropicVariogram>()?;
    m.add_class::<geostat::ExperimentalVariogram>()?;
    m.add_function(wrap_pyfunction!(geostat::experimental_variogram, m)?)?;
    m.add_function(wrap_pyfunction!(geostat::local_kriging_grid, m)?)?;
    m.add_function(wrap_pyfunction!(geostat::local_kriging_grid_flat, m)?)?;
    m.add_function(wrap_pyfunction!(geostat::sgs, m)?)?;
    m.add_function(wrap_pyfunction!(geostat::sgs_flat, m)?)?;

    // resample (grid → grid over the Lattice geometry)
    m.add_function(wrap_pyfunction!(resample::resample, m)?)?;
    m.add_function(wrap_pyfunction!(resample::resample_flat, m)?)?;

    // synth — believable synthetic data generators (the full asset)
    m.add_class::<synth::ZoneSpec>()?;
    m.add_function(wrap_pyfunction!(synth::zone_sample_counts, m)?)?;
    m.add_function(wrap_pyfunction!(synth::synth_log_series, m)?)?;
    m.add_function(wrap_pyfunction!(synth::synth_facies_series, m)?)?;
    m.add_function(wrap_pyfunction!(synth::synth_por_with_facies, m)?)?;
    m.add_class::<synth::PetroZoneSpec>()?;
    m.add_function(wrap_pyfunction!(synth::synth_petro_curves, m)?)?;
    m.add_function(wrap_pyfunction!(synth::ntg_curve, m)?)?;
    m.add_function(wrap_pyfunction!(synth::synth_dome_surface, m)?)?;
    m.add_function(wrap_pyfunction!(synth::synth_dome_surface_flat, m)?)?;
    m.add_function(wrap_pyfunction!(synth::synth_isochore, m)?)?;
    m.add_function(wrap_pyfunction!(synth::synth_isochore_flat, m)?)?;
    m.add_function(wrap_pyfunction!(synth::synth_trend_map, m)?)?;
    m.add_function(wrap_pyfunction!(synth::synth_trend_map_flat, m)?)?;
    m.add_function(wrap_pyfunction!(synth::place_wells, m)?)?;
    m.add_function(wrap_pyfunction!(synth::place_wells_in_polygon, m)?)?;
    m.add_function(wrap_pyfunction!(synth::tops_from_surface, m)?)?;
    m.add_function(wrap_pyfunction!(synth::synth_trajectory, m)?)?;
    m.add_function(wrap_pyfunction!(synth::synth_trajectory_profile, m)?)?;
    m.add_function(wrap_pyfunction!(synth::max_dogleg_severity, m)?)?;
    m.add_class::<synth::Georef>()?;
    m.add_function(wrap_pyfunction!(synth::closure_outline, m)?)?;
    m.add_function(wrap_pyfunction!(synth::study_area_outline, m)?)?;

    // units — the SI/metric reporting layer
    m.add_function(wrap_pyfunction!(units::m3_to_mcm, m)?)?;
    m.add_function(wrap_pyfunction!(units::mcm_to_m3, m)?)?;
    m.add_function(wrap_pyfunction!(units::m3_to_msm3, m)?)?;
    m.add_function(wrap_pyfunction!(units::msm3_to_m3, m)?)?;
    m.add_function(wrap_pyfunction!(units::m3_to_bcm, m)?)?;
    m.add_function(wrap_pyfunction!(units::bcm_to_m3, m)?)?;
    m.add_function(wrap_pyfunction!(units::scf_to_sm3, m)?)?;
    m.add_function(wrap_pyfunction!(units::sm3_to_scf, m)?)?;
    m.add_function(wrap_pyfunction!(units::stb_to_sm3, m)?)?;
    m.add_function(wrap_pyfunction!(units::sm3_to_stb, m)?)?;
    m.add_function(wrap_pyfunction!(units::km2_to_m2, m)?)?;
    m.add_function(wrap_pyfunction!(units::m2_to_km2, m)?)?;
    m.add_function(wrap_pyfunction!(units::format_volume, m)?)?;

    Ok(())
}
