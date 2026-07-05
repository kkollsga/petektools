//! Variogram models — the spatial-continuity structure ordinary kriging needs.
//!
//! A variogram `γ(h)` (the *semivariance* at lag distance `h`) is built from a
//! **nugget** `c₀`, a structured **partial sill** `c`, and a **range** `a`. The
//! total sill is `c₀ + c`. `γ(0) = 0`; for `h > 0` the nugget contributes `c₀`
//! discontinuously and the structured component rises from `0` toward `c`.
//!
//! Implemented from the standard geostatistical definitions:
//! - Journel, A.G. & Huijbregts, C.J. (1978), *Mining Geostatistics*, ch. III.
//! - Isaaks, E.H. & Srivastava, R.M. (1989), *An Introduction to Applied
//!   Geostatistics*, ch. 7 (the variogram) & 16 (models).
//! - Cressie, N. (1993), *Statistics for Spatial Data*, §2.3.1.
//! - Deutsch, C.V. & Journel, A.G. (1998), *GSLIB*, §II.3 (the practical-range
//!   convention used here for the exponential/Gaussian models).
//!
//! **Range convention.** For the exponential and Gaussian models the range `a`
//! is the *practical* range: the lag at which the structured component reaches
//! 95 % of its sill (the `−3h/a` / `−3(h/a)²` scalings). The spherical model
//! reaches its sill exactly at `h = a`.

/// The structured-component family of a variogram model.
///
/// `Nugget` is the pure-nugget (no spatial structure) case: `γ(h) = c₀` for all
/// `h > 0`; its `sill`/`range` are ignored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum VariogramModel {
    /// Pure nugget — no spatial correlation. `γ(h > 0) = c₀`.
    Nugget,
    /// Spherical — linear near the origin, reaches the sill exactly at `h = a`.
    Spherical,
    /// Exponential — reaches ~95 % of the sill at the practical range `a`.
    Exponential,
    /// Gaussian — parabolic near the origin (very smooth), 95 % sill at `a`.
    Gaussian,
}

/// A fully-specified variogram: a [`VariogramModel`] plus its nugget, partial
/// sill and range. Evaluate the semivariance with [`gamma`](Self::gamma).
///
/// Construct via [`Variogram::new`], which validates the parameters (a valid
/// variogram is what keeps the ordinary-kriging system non-singular).
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Variogram {
    /// Structured-component family.
    pub model: VariogramModel,
    /// Nugget effect `c₀ ≥ 0` — the discontinuity at the origin.
    pub nugget: f64,
    /// Structured partial sill `c ≥ 0` — the correlated variance.
    pub sill: f64,
    /// Range `a > 0` (practical range for exponential/Gaussian).
    pub range: f64,
}

impl Variogram {
    /// Build a variogram, validating the parameters.
    ///
    /// Requires `nugget ≥ 0`, `sill ≥ 0`, `range > 0` (the range is still
    /// required — and must be finite/positive — for the `Nugget` model even
    /// though it is unused), and that the model produces a **positive**
    /// semivariance at positive lag. Because the `Nugget` model ignores `sill`
    /// (γ(h>0) = c₀), a `Nugget` with `nugget = 0` is rejected here — it would
    /// otherwise pass a naïve `nugget + sill > 0` check yet yield an all-zero Γ
    /// and a singular kriging system (surfacing at krige-time as a bogus
    /// "duplicate points" error). Invalid parameters yield
    /// [`AlgoError::InvalidArgument`](crate::foundation::AlgoError::InvalidArgument).
    pub fn new(
        model: VariogramModel,
        nugget: f64,
        sill: f64,
        range: f64,
    ) -> crate::foundation::Result<Variogram> {
        use crate::foundation::AlgoError;
        if !(nugget.is_finite() && sill.is_finite() && range.is_finite()) {
            return Err(AlgoError::InvalidArgument(
                "variogram: nugget, sill and range must be finite".to_string(),
            ));
        }
        if nugget < 0.0 || sill < 0.0 {
            return Err(AlgoError::InvalidArgument(
                "variogram: nugget and sill must be non-negative".to_string(),
            ));
        }
        // Validate on the variance the model's `gamma()` actually consumes at
        // positive lag. The `Nugget` model uses only its nugget (`sill` is
        // ignored), so its effective variance is `nugget` alone; every other
        // model consumes both. A non-positive effective variance yields an
        // all-zero Γ and a singular kriging system.
        let effective_sill = match model {
            VariogramModel::Nugget => nugget,
            _ => nugget + sill,
        };
        if effective_sill <= 0.0 {
            return Err(AlgoError::InvalidArgument(
                match model {
                    VariogramModel::Nugget => {
                        "variogram: the Nugget model uses only its nugget (sill is ignored), so nugget must be positive"
                    }
                    _ => "variogram: total sill (nugget + sill) must be positive",
                }
                .to_string(),
            ));
        }
        if range <= 0.0 {
            return Err(AlgoError::InvalidArgument(
                "variogram: range must be positive".to_string(),
            ));
        }
        Ok(Variogram {
            model,
            nugget,
            sill,
            range,
        })
    }

    /// Total sill `c₀ + c` — the plateau the semivariance approaches at large
    /// lags (reached exactly at `h ≥ a` for the spherical model).
    pub fn total_sill(&self) -> f64 {
        self.nugget + self.sill
    }

    /// Semivariance `γ(h)` at lag distance `h ≥ 0`.
    ///
    /// `γ(0) = 0`. For `h > 0` the result is `c₀` (nugget) plus the structured
    /// component of [`self.model`](Variogram::model). A negative `h` is treated
    /// as its absolute value (a variogram is a function of the lag magnitude).
    pub fn gamma(&self, h: f64) -> f64 {
        let h = h.abs();
        if h == 0.0 {
            return 0.0;
        }
        let structured = match self.model {
            VariogramModel::Nugget => 0.0,
            VariogramModel::Spherical => {
                let r = h / self.range;
                if r >= 1.0 {
                    self.sill
                } else {
                    self.sill * (1.5 * r - 0.5 * r * r * r)
                }
            }
            VariogramModel::Exponential => self.sill * (1.0 - (-3.0 * h / self.range).exp()),
            VariogramModel::Gaussian => {
                let r = h / self.range;
                self.sill * (1.0 - (-3.0 * r * r).exp())
            }
        };
        self.nugget + structured
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn rejects_invalid_parameters() {
        assert!(Variogram::new(VariogramModel::Spherical, -1.0, 1.0, 10.0).is_err());
        assert!(Variogram::new(VariogramModel::Spherical, 0.0, -1.0, 10.0).is_err());
        assert!(Variogram::new(VariogramModel::Spherical, 0.0, 0.0, 10.0).is_err()); // zero sill
        assert!(Variogram::new(VariogramModel::Spherical, 0.0, 1.0, 0.0).is_err()); // zero range
        assert!(Variogram::new(VariogramModel::Spherical, 0.0, 1.0, f64::NAN).is_err());
        assert!(Variogram::new(VariogramModel::Spherical, 0.0, 1.0, 10.0).is_ok());
        // Bad parameters are argument errors, not geometry errors (the singular
        // *system* is the geometry case, raised at krige-time).
        assert!(matches!(
            Variogram::new(VariogramModel::Spherical, 0.0, 1.0, 0.0),
            Err(crate::foundation::AlgoError::InvalidArgument(_))
        ));
    }

    #[test]
    fn nugget_model_rejects_zero_nugget() {
        // Regression: the Nugget model ignores `sill`, so `nugget = 0` yields an
        // all-zero variogram and a singular kriging system. It must be rejected
        // at construction with an honest message — not surface at krige-time as
        // a bogus "duplicate points" singularity.
        let err = Variogram::new(VariogramModel::Nugget, 0.0, 5.0, 10.0);
        assert!(err.is_err(), "zero-nugget Nugget must fail at construction");
        // A positive nugget is fine (sill is genuinely irrelevant here).
        assert!(Variogram::new(VariogramModel::Nugget, 1.0, 0.0, 10.0).is_ok());
        // The structured models still accept a zero nugget with a positive sill.
        assert!(Variogram::new(VariogramModel::Spherical, 0.0, 1.0, 10.0).is_ok());
    }

    #[test]
    fn gamma_is_zero_at_origin() {
        for model in [
            VariogramModel::Nugget,
            VariogramModel::Spherical,
            VariogramModel::Exponential,
            VariogramModel::Gaussian,
        ] {
            let v = Variogram::new(model, 0.5, 2.0, 10.0).unwrap();
            assert_eq!(v.gamma(0.0), 0.0, "{model:?}");
        }
    }

    #[test]
    fn nugget_jumps_then_flat() {
        // Pure nugget: 0 at the origin, c0 for every positive lag.
        let v = Variogram::new(VariogramModel::Nugget, 3.0, 5.0, 10.0).unwrap();
        assert_eq!(v.gamma(0.0), 0.0);
        assert_eq!(v.gamma(0.01), 3.0);
        assert_eq!(v.gamma(1e6), 3.0);
    }

    #[test]
    fn spherical_reaches_sill_exactly_at_range() {
        // No nugget: γ(a) = c and stays there beyond a.
        let v = Variogram::new(VariogramModel::Spherical, 0.0, 4.0, 10.0).unwrap();
        assert_relative_eq!(v.gamma(10.0), 4.0, epsilon = 1e-12);
        assert_relative_eq!(v.gamma(15.0), 4.0, epsilon = 1e-12);
        // Half-range value: 1.5·0.5 − 0.5·0.125 = 0.6875 of the sill.
        assert_relative_eq!(v.gamma(5.0), 4.0 * 0.687_5, epsilon = 1e-12);
    }

    #[test]
    fn exponential_and_gaussian_hit_95pct_at_practical_range() {
        // The −3 scaling puts the structured component at 1 − e⁻³ ≈ 0.9502 of
        // the sill at h = a (the GSLIB practical-range convention).
        let expected = 1.0 - (-3.0_f64).exp();
        let e = Variogram::new(VariogramModel::Exponential, 0.0, 1.0, 20.0).unwrap();
        assert_relative_eq!(e.gamma(20.0), expected, epsilon = 1e-12);
        let g = Variogram::new(VariogramModel::Gaussian, 0.0, 1.0, 20.0).unwrap();
        assert_relative_eq!(g.gamma(20.0), expected, epsilon = 1e-12);
    }

    #[test]
    fn monotone_non_decreasing_and_bounded_by_total_sill() {
        let v = Variogram::new(VariogramModel::Exponential, 1.0, 3.0, 15.0).unwrap();
        let mut prev = v.gamma(1e-9);
        let mut h = 0.0;
        while h < 100.0 {
            h += 0.5;
            let g = v.gamma(h);
            assert!(g >= prev - 1e-12, "not monotone at h={h}: {g} < {prev}");
            assert!(g <= v.total_sill() + 1e-12, "exceeds sill at h={h}: {g}");
            prev = g;
        }
    }

    #[test]
    fn gamma_is_symmetric_in_lag_sign() {
        let v = Variogram::new(VariogramModel::Gaussian, 0.2, 1.0, 5.0).unwrap();
        assert_eq!(v.gamma(3.0), v.gamma(-3.0));
    }
}
