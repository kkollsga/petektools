//! Oilfield-unit conversion constants and helpers.
//!
//! ## Family convention: SI / metric is the standard (imperial is opt-in)
//!
//! Per the suite units standard (`decision_si_units_standard`), the petek family
//! reports in **SI / metric**: metres; **mcm** (`1e6 m³`) and **MSm³** for oil
//! volumes; **bcm** (`1e9 Sm³`) for gas; **Sm³/d** for rates. The imperial /
//! oilfield factors below (acre, bbl, ft, psi, °F, mD) stay for **opt-in**
//! conversion of imperial inputs and legacy data — a consumer flips imperial
//! internals to SI for reporting through these helpers.
//!
//! ## `Sm³` (standard cubic metre) semantics at this layer
//!
//! `Sm³` denotes a volume at standard conditions. At this **units-labeling**
//! layer `1 Sm³ ≡ 1 m³` numerically — the `m³ → MSm³/bcm` and `scf/stb → Sm³`
//! helpers are a **labeling + geometric-scale** convention, **not** a PVT
//! (formation-volume-factor / gas-expansion) conversion. Any temperature /
//! pressure standard-condition correction between differing standards (e.g. scf
//! at 60 °F vs Sm³ at 15 °C) belongs to a PVT model downstream (petekSim), not
//! here; the `scf ↔ Sm³` factor below is the **pure geometric** `ft³ ↔ m³`
//! factor and applies **no** such correction.

/// Square feet per acre.
pub const ACRE_TO_FT2: f64 = 43_560.0;
/// Cubic feet per reservoir/stock-tank barrel.
pub const FT3_PER_BBL: f64 = 5.614_583_333_333_333;

/// Metres per foot (the international foot, exact by definition).
pub const FT_TO_M: f64 = 0.304_8;
/// Cubic metres per (oil) barrel — 42 US gallons, exact (`42 × 231 in³`).
pub const M3_PER_BBL: f64 = 0.158_987_294_928;
/// Bar per psi (`1 psi = 6894.757293168 Pa`, `1 bar = 100 000 Pa`).
pub const BAR_PER_PSI: f64 = 0.068_947_572_931_683_6;
/// Square metres per millidarcy — the standard `9.869233e-16` conversion.
pub const MD_TO_M2: f64 = 9.869_233e-16;

/// Area: acres -> square feet.
#[must_use]
pub fn acres_to_ft2(acres: f64) -> f64 {
    acres * ACRE_TO_FT2
}

/// Volume: acre-feet -> cubic feet.
#[must_use]
pub fn acre_ft_to_ft3(acre_ft: f64) -> f64 {
    acre_ft * ACRE_TO_FT2
}

/// Volume: cubic feet -> acre-feet.
#[must_use]
pub fn ft3_to_acre_ft(ft3: f64) -> f64 {
    ft3 / ACRE_TO_FT2
}

/// Volume: cubic feet -> barrels (reservoir bbl).
#[must_use]
pub fn ft3_to_rb(ft3: f64) -> f64 {
    ft3 / FT3_PER_BBL
}

/// Volume: barrels -> cubic feet.
#[must_use]
pub fn rb_to_ft3(bbl: f64) -> f64 {
    bbl * FT3_PER_BBL
}

/// Temperature: degrees Fahrenheit -> degrees Rankine.
#[must_use]
pub fn degf_to_degr(degf: f64) -> f64 {
    degf + 459.67
}

/// Length: feet -> metres (international foot, exact).
#[must_use]
pub fn ft_to_m(ft: f64) -> f64 {
    ft * FT_TO_M
}

/// Length: metres -> feet.
#[must_use]
pub fn m_to_ft(m: f64) -> f64 {
    m / FT_TO_M
}

/// Volume: cubic metres -> (oil) barrels.
#[must_use]
pub fn m3_to_bbl(m3: f64) -> f64 {
    m3 / M3_PER_BBL
}

/// Volume: (oil) barrels -> cubic metres.
#[must_use]
pub fn bbl_to_m3(bbl: f64) -> f64 {
    bbl * M3_PER_BBL
}

/// Pressure: psi -> bar.
#[must_use]
pub fn psi_to_bar(psi: f64) -> f64 {
    psi * BAR_PER_PSI
}

/// Pressure: bar -> psi.
#[must_use]
pub fn bar_to_psi(bar: f64) -> f64 {
    bar / BAR_PER_PSI
}

/// Permeability: millidarcy -> square metres (`9.869233e-16` per mD).
#[must_use]
pub fn md_to_m2(md: f64) -> f64 {
    md * MD_TO_M2
}

/// Permeability: square metres -> millidarcy.
#[must_use]
pub fn m2_to_md(m2: f64) -> f64 {
    m2 / MD_TO_M2
}

// ---- SI / metric reporting scales (the family standard) ---------------------

/// Cubic metres per **mcm** (million cubic metres), `1e6`.
pub const M3_PER_MCM: f64 = 1.0e6;
/// Standard cubic metres per **MSm³** (million Sm³) — the oil-volume report unit
/// (`Sm³` labeling; see the module note), `1e6`.
pub const SM3_PER_MSM3: f64 = 1.0e6;
/// Standard cubic metres per **bcm** (billion Sm³) — the gas-volume report unit,
/// `1e9`.
pub const SM3_PER_BCM: f64 = 1.0e9;
/// Standard cubic feet per **Sm³** — the pure geometric `ft³/m³` factor
/// `(1 / 0.3048)³ = 35.314666721488594` (NO standard-condition correction; see
/// the module note).
pub const SCF_PER_SM3: f64 = 35.314_666_721_488_59;
/// Cubic metres (= Sm³ at this layer) per **stb** (stock-tank barrel) — the same
/// geometric barrel volume as [`M3_PER_BBL`], `0.158_987_294_928` (the
/// "stock-tank" qualifier is a standard-condition label, not a different volume).
pub const SM3_PER_STB: f64 = M3_PER_BBL;
/// Square metres per **km²** (square kilometre), `1e6` — the areal report scale
/// (GRV/outline areas quoted in km²), mirroring [`M3_PER_MCM`] on the volume side.
pub const M2_PER_KM2: f64 = 1.0e6;

/// Volume: cubic metres -> mcm (million m³).
#[must_use]
pub fn m3_to_mcm(m3: f64) -> f64 {
    m3 / M3_PER_MCM
}

/// Volume: mcm (million m³) -> cubic metres.
#[must_use]
pub fn mcm_to_m3(mcm: f64) -> f64 {
    mcm * M3_PER_MCM
}

/// Volume: cubic metres (Sm³) -> MSm³ (million Sm³) — oil reporting.
#[must_use]
pub fn m3_to_msm3(m3: f64) -> f64 {
    m3 / SM3_PER_MSM3
}

/// Volume: MSm³ (million Sm³) -> cubic metres (Sm³).
#[must_use]
pub fn msm3_to_m3(msm3: f64) -> f64 {
    msm3 * SM3_PER_MSM3
}

/// Volume: cubic metres (Sm³) -> bcm (billion Sm³) — gas reporting.
#[must_use]
pub fn m3_to_bcm(m3: f64) -> f64 {
    m3 / SM3_PER_BCM
}

/// Volume: bcm (billion Sm³) -> cubic metres (Sm³).
#[must_use]
pub fn bcm_to_m3(bcm: f64) -> f64 {
    bcm * SM3_PER_BCM
}

/// Gas volume: standard cubic feet -> standard cubic metres (geometric factor).
#[must_use]
pub fn scf_to_sm3(scf: f64) -> f64 {
    scf / SCF_PER_SM3
}

/// Gas volume: standard cubic metres -> standard cubic feet (geometric factor).
#[must_use]
pub fn sm3_to_scf(sm3: f64) -> f64 {
    sm3 * SCF_PER_SM3
}

/// Oil volume: stock-tank barrels -> standard cubic metres.
#[must_use]
pub fn stb_to_sm3(stb: f64) -> f64 {
    stb * SM3_PER_STB
}

/// Oil volume: standard cubic metres -> stock-tank barrels.
#[must_use]
pub fn sm3_to_stb(sm3: f64) -> f64 {
    sm3 / SM3_PER_STB
}

/// Area: square kilometres -> square metres.
#[must_use]
pub fn km2_to_m2(km2: f64) -> f64 {
    km2 * M2_PER_KM2
}

/// Area: square metres -> square kilometres.
#[must_use]
pub fn m2_to_km2(m2: f64) -> f64 {
    m2 / M2_PER_KM2
}

/// Format a volume in `m³` (= `Sm³` at this layer) with an SI report unit chosen
/// by magnitude: `bcm` (`≥ 1e9`), `mcm` (`≥ 1e6`), else `m³`. A convenience for
/// human-readable output (e.g. `format_volume(12_400_000.0) == "12.4 mcm"`);
/// the constants above are the load-bearing surface.
#[must_use]
pub fn format_volume(v_m3: f64) -> String {
    let a = v_m3.abs();
    if a >= SM3_PER_BCM {
        format!("{:.1} bcm", v_m3 / SM3_PER_BCM)
    } else if a >= M3_PER_MCM {
        format!("{:.1} mcm", v_m3 / M3_PER_MCM)
    } else {
        format!("{v_m3:.1} m³")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acre_roundtrips_through_ft3() {
        // 1 acre-ft is 43,560 ft^3 by definition.
        assert!((acre_ft_to_ft3(1.0) - 43_560.0).abs() < 1e-9);
        assert!((ft3_to_acre_ft(43_560.0) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn barrel_roundtrips() {
        let v = 12_345.6_f64;
        assert!((rb_to_ft3(ft3_to_rb(v)) - v).abs() < 1e-6);
    }

    #[test]
    fn rankine_offset() {
        assert!((degf_to_degr(60.0) - 519.67).abs() < 1e-9);
    }

    #[test]
    fn feet_metres_roundtrip_and_known() {
        // 1 ft = 0.3048 m exactly; 100 ft = 30.48 m.
        assert!((ft_to_m(1.0) - 0.3048).abs() < 1e-15);
        assert!((ft_to_m(100.0) - 30.48).abs() < 1e-12);
        assert!((m_to_ft(0.3048) - 1.0).abs() < 1e-12);
        assert!((m_to_ft(ft_to_m(1234.5)) - 1234.5).abs() < 1e-9);
    }

    #[test]
    fn cubic_metres_barrels_known() {
        // 1 bbl = 0.158987294928 m^3; 1000 m^3 ≈ 6289.8108 bbl.
        assert!((bbl_to_m3(1.0) - 0.158_987_294_928).abs() < 1e-15);
        assert!((m3_to_bbl(0.158_987_294_928) - 1.0).abs() < 1e-12);
        assert!((m3_to_bbl(1000.0) - 6_289.810_770_432_105).abs() < 1e-6);
        assert!((bbl_to_m3(m3_to_bbl(42.0)) - 42.0).abs() < 1e-9);
    }

    #[test]
    fn psi_bar_known() {
        // 1 psi ≈ 0.0689475729 bar; 1 bar ≈ 14.5037738 psi.
        assert!((psi_to_bar(1.0) - 0.068_947_572_931_683_6).abs() < 1e-15);
        assert!((bar_to_psi(1.0) - 14.503_773_773_022_1).abs() < 1e-6);
        assert!((bar_to_psi(psi_to_bar(2500.0)) - 2500.0).abs() < 1e-9);
    }

    #[test]
    fn millidarcy_square_metres_known() {
        // 1 mD = 9.869233e-16 m^2 (the standard factor).
        assert!((md_to_m2(1.0) - 9.869_233e-16).abs() < 1e-30);
        assert!((m2_to_md(9.869_233e-16) - 1.0).abs() < 1e-9);
        assert!((m2_to_md(md_to_m2(150.0)) - 150.0).abs() < 1e-9);
    }

    #[test]
    fn si_report_scales_known() {
        // mcm / MSm³ = 1e6, bcm = 1e9 (exact scale labels).
        assert_eq!(m3_to_mcm(2.5e6), 2.5);
        assert_eq!(mcm_to_m3(2.5), 2.5e6);
        assert_eq!(m3_to_msm3(3.0e6), 3.0);
        assert_eq!(msm3_to_m3(3.0), 3.0e6);
        assert_eq!(m3_to_bcm(4.0e9), 4.0);
        assert_eq!(bcm_to_m3(4.0), 4.0e9);
        assert!((m3_to_mcm(mcm_to_m3(7.25)) - 7.25).abs() < 1e-12);
        assert!((m3_to_bcm(bcm_to_m3(1.5)) - 1.5).abs() < 1e-12);
    }

    #[test]
    fn scf_sm3_geometric_factor() {
        // 1 Sm³ = (1/0.3048)³ ft³ ≈ 35.31466672 scf (pure geometric).
        assert!((sm3_to_scf(1.0) - 35.314_666_721_488_59).abs() < 1e-9);
        assert!((scf_to_sm3(35.314_666_721_488_59) - 1.0).abs() < 1e-12);
        assert!((scf_to_sm3(sm3_to_scf(123.4)) - 123.4).abs() < 1e-9);
    }

    #[test]
    fn stb_sm3_shares_barrel_volume() {
        // stb carries the geometric barrel volume (== M3_PER_BBL).
        assert_eq!(SM3_PER_STB, M3_PER_BBL);
        assert!((stb_to_sm3(1.0) - 0.158_987_294_928).abs() < 1e-15);
        assert!((sm3_to_stb(stb_to_sm3(1000.0)) - 1000.0).abs() < 1e-9);
    }

    #[test]
    fn km2_m2_area_scale_known() {
        // 1 km² = 1e6 m² (exact scale label); mirrors the mcm volume scale.
        assert_eq!(M2_PER_KM2, 1.0e6);
        assert_eq!(km2_to_m2(2.5), 2.5e6);
        assert_eq!(m2_to_km2(2.5e6), 2.5);
        assert!((m2_to_km2(km2_to_m2(7.25)) - 7.25).abs() < 1e-12);
    }

    #[test]
    fn format_volume_picks_scale() {
        assert_eq!(format_volume(12_400_000.0), "12.4 mcm");
        assert_eq!(format_volume(4_000_000_000.0), "4.0 bcm");
        assert_eq!(format_volume(950.0), "950.0 m³");
    }
}
