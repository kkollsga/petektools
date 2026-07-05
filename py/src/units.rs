//! `units` bindings — the SI/metric reporting layer over `petektools::units`.
//!
//! The family standard is SI/metric (`decision_si_units_standard`): metres,
//! **mcm**/**MSm³** (oil), **bcm** (gas). These free functions expose the SI
//! reporting scales + the `scf/stb ↔ Sm³` conversions so downstream can flip
//! imperial internals to SI reporting. `Sm³` is a scale label at this layer, not
//! a PVT conversion (see the Rust `units::convert` module docs).

use petektools::units;
use pyo3::prelude::*;

/// Cubic metres -> mcm (million m³).
#[pyfunction]
pub fn m3_to_mcm(m3: f64) -> f64 {
    units::m3_to_mcm(m3)
}

/// mcm (million m³) -> cubic metres.
#[pyfunction]
pub fn mcm_to_m3(mcm: f64) -> f64 {
    units::mcm_to_m3(mcm)
}

/// Cubic metres (Sm³) -> MSm³ (million Sm³) — oil reporting.
#[pyfunction]
pub fn m3_to_msm3(m3: f64) -> f64 {
    units::m3_to_msm3(m3)
}

/// MSm³ (million Sm³) -> cubic metres (Sm³).
#[pyfunction]
pub fn msm3_to_m3(msm3: f64) -> f64 {
    units::msm3_to_m3(msm3)
}

/// Cubic metres (Sm³) -> bcm (billion Sm³) — gas reporting.
#[pyfunction]
pub fn m3_to_bcm(m3: f64) -> f64 {
    units::m3_to_bcm(m3)
}

/// bcm (billion Sm³) -> cubic metres (Sm³).
#[pyfunction]
pub fn bcm_to_m3(bcm: f64) -> f64 {
    units::bcm_to_m3(bcm)
}

/// Standard cubic feet -> standard cubic metres (pure geometric factor).
#[pyfunction]
pub fn scf_to_sm3(scf: f64) -> f64 {
    units::scf_to_sm3(scf)
}

/// Standard cubic metres -> standard cubic feet (pure geometric factor).
#[pyfunction]
pub fn sm3_to_scf(sm3: f64) -> f64 {
    units::sm3_to_scf(sm3)
}

/// Stock-tank barrels -> standard cubic metres.
#[pyfunction]
pub fn stb_to_sm3(stb: f64) -> f64 {
    units::stb_to_sm3(stb)
}

/// Standard cubic metres -> stock-tank barrels.
#[pyfunction]
pub fn sm3_to_stb(sm3: f64) -> f64 {
    units::sm3_to_stb(sm3)
}

/// Square kilometres -> square metres (areal report scale).
#[pyfunction]
pub fn km2_to_m2(km2: f64) -> f64 {
    units::km2_to_m2(km2)
}

/// Square metres -> square kilometres (areal report scale).
#[pyfunction]
pub fn m2_to_km2(m2: f64) -> f64 {
    units::m2_to_km2(m2)
}

/// Format a volume in m³ with an SI report unit chosen by magnitude
/// (`bcm` ≥ 1e9, `mcm` ≥ 1e6, else `m³`), e.g. `format_volume(12.4e6) ==
/// "12.4 mcm"`.
#[pyfunction]
pub fn format_volume(v_m3: f64) -> String {
    units::format_volume(v_m3)
}
