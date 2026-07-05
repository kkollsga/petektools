//! `units` — domain-agnostic oilfield-unit conversion constants and helpers.
//!
//! One home for every unit factor so downstream consumers can never disagree on
//! a conversion. Pure arithmetic over `f64` — no I/O, no domain types, no error
//! surface. Curated here (rather than a consumer's own module) so the whole
//! family shares one set of constants; moved out of petekSim's `srs-units`.
//!
//! **Family convention: SI / metric is the standard** (`decision_si_units_standard`)
//! — metres, **mcm**/**MSm³** (oil), **bcm** (gas), Sm³/d. The imperial factors
//! (acre, bbl, ft, psi, °F, mD) are **opt-in** for imperial inputs / legacy data.
//! See [`convert`] for the `Sm³` labeling semantics (a scale label, not PVT).
//!
//! ```
//! use petektools::units::{acres_to_ft2, ACRE_TO_FT2, m3_to_mcm};
//! assert_eq!(acres_to_ft2(2.0), 2.0 * ACRE_TO_FT2);
//! assert_eq!(m3_to_mcm(2.5e6), 2.5); // SI reporting scale
//! ```

pub mod convert;

pub use convert::{
    acre_ft_to_ft3, acres_to_ft2, bar_to_psi, bbl_to_m3, bcm_to_m3, degf_to_degr, format_volume,
    ft3_to_acre_ft, ft3_to_rb, ft_to_m, km2_to_m2, m2_to_km2, m2_to_md, m3_to_bbl, m3_to_bcm,
    m3_to_mcm, m3_to_msm3, m_to_ft, mcm_to_m3, md_to_m2, msm3_to_m3, psi_to_bar, rb_to_ft3,
    scf_to_sm3, sm3_to_scf, sm3_to_stb, stb_to_sm3, ACRE_TO_FT2, BAR_PER_PSI, FT3_PER_BBL, FT_TO_M,
    M2_PER_KM2, M3_PER_BBL, M3_PER_MCM, MD_TO_M2, SCF_PER_SM3, SM3_PER_BCM, SM3_PER_MSM3,
    SM3_PER_STB,
};
