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

/// A variogram with directional ranges in a right-handed `(x, y, z)` frame.
///
/// `major` and `minor` are horizontal ranges, `vertical` is the vertical range,
/// and `azimuth` is degrees clockwise from north for the major axis. The scalar
/// model family, nugget, and partial sill use the same conventions as
/// [`Variogram`].
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AnisotropicVariogram {
    /// Structured-component family.
    pub model: VariogramModel,
    /// Nugget effect `c₀ ≥ 0` — the discontinuity at the origin.
    pub nugget: f64,
    /// Structured partial sill `c ≥ 0` — the correlated variance.
    pub sill: f64,
    /// Horizontal major-axis range `> 0`.
    pub major: f64,
    /// Horizontal minor-axis range `> 0`.
    pub minor: f64,
    /// Vertical range `> 0`.
    pub vertical: f64,
    /// Major-axis azimuth, normalized to `[0, 360)` degrees clockwise from north.
    pub azimuth: f64,
}

impl AnisotropicVariogram {
    /// Build an anisotropic variogram, validating ranges, sills, and azimuth.
    pub fn new(
        model: VariogramModel,
        nugget: f64,
        sill: f64,
        major: f64,
        minor: f64,
        vertical: f64,
        azimuth: f64,
    ) -> crate::foundation::Result<AnisotropicVariogram> {
        use crate::foundation::AlgoError;
        if ![nugget, sill, major, minor, vertical, azimuth]
            .into_iter()
            .all(f64::is_finite)
        {
            return Err(AlgoError::InvalidArgument(
                "anisotropic variogram: nugget, sill, ranges and azimuth must be finite"
                    .to_string(),
            ));
        }
        if nugget < 0.0 || sill < 0.0 {
            return Err(AlgoError::InvalidArgument(
                "anisotropic variogram: nugget and sill must be non-negative".to_string(),
            ));
        }
        let effective_sill = match model {
            VariogramModel::Nugget => nugget,
            _ => nugget + sill,
        };
        if effective_sill <= 0.0 {
            return Err(AlgoError::InvalidArgument(
                match model {
                    VariogramModel::Nugget => {
                        "anisotropic variogram: the Nugget model uses only its nugget (sill is ignored), so nugget must be positive"
                    }
                    _ => "anisotropic variogram: total sill (nugget + sill) must be positive",
                }
                .to_string(),
            ));
        }
        if major <= 0.0 || minor <= 0.0 || vertical <= 0.0 {
            return Err(AlgoError::InvalidArgument(
                "anisotropic variogram: major, minor and vertical ranges must be positive"
                    .to_string(),
            ));
        }
        Ok(AnisotropicVariogram {
            model,
            nugget,
            sill,
            major,
            minor,
            vertical,
            azimuth: azimuth.rem_euclid(360.0),
        })
    }

    /// Convenience constructor for an isotropic-equivalent anisotropic model.
    pub fn isotropic(
        model: VariogramModel,
        nugget: f64,
        sill: f64,
        range: f64,
    ) -> crate::foundation::Result<AnisotropicVariogram> {
        Self::new(model, nugget, sill, range, range, range, 0.0)
    }

    /// Total sill `c₀ + c`.
    pub fn total_sill(&self) -> f64 {
        self.nugget + self.sill
    }

    /// Anisotropic lag distance for an offset `(dx, dy, dz)`.
    ///
    /// The horizontal offset is rotated into major/minor coordinates, then
    /// minor and vertical components are stretched into major-range units. A
    /// point one `major` away along the major axis, one `minor` away along the
    /// minor axis, or one `vertical` away vertically all yield an effective lag
    /// of `major`.
    pub fn anisotropic_distance(&self, dx: f64, dy: f64, dz: f64) -> f64 {
        let az = self.azimuth.to_radians();
        let (sin_az, cos_az) = az.sin_cos();
        // x is east, y is north; azimuth is clockwise from north.
        let h_major = dx * sin_az + dy * cos_az;
        let h_minor = dx * cos_az - dy * sin_az;
        let minor_scaled = h_minor * self.major / self.minor;
        let vertical_scaled = dz * self.major / self.vertical;
        (h_major * h_major + minor_scaled * minor_scaled + vertical_scaled * vertical_scaled).sqrt()
    }

    /// Semivariance at an anisotropic offset.
    pub fn gamma_offset(&self, dx: f64, dy: f64, dz: f64) -> f64 {
        let h = self.anisotropic_distance(dx, dy, dz);
        Variogram {
            model: self.model,
            nugget: self.nugget,
            sill: self.sill,
            range: self.major,
        }
        .gamma(h)
    }
}

/// Spatial-continuity model accepted by local geostatistical kernels.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum SpatialVariogram {
    /// Existing scalar-range variogram behaviour.
    Isotropic(Variogram),
    /// Directional range variogram.
    Anisotropic(AnisotropicVariogram),
}

impl SpatialVariogram {
    /// Total sill `c₀ + c`.
    pub fn total_sill(&self) -> f64 {
        match self {
            SpatialVariogram::Isotropic(v) => v.total_sill(),
            SpatialVariogram::Anisotropic(v) => v.total_sill(),
        }
    }

    /// Semivariance at a 2-D offset.
    pub fn gamma_offset_2d(&self, dx: f64, dy: f64) -> f64 {
        match self {
            SpatialVariogram::Isotropic(v) => v.gamma((dx * dx + dy * dy).sqrt()),
            SpatialVariogram::Anisotropic(v) => v.gamma_offset(dx, dy, 0.0),
        }
    }

    /// Semivariance between two 2-D points.
    pub fn gamma_between_2d(&self, a: [f64; 2], b: [f64; 2]) -> f64 {
        self.gamma_offset_2d(a[0] - b[0], a[1] - b[1])
    }

    /// Semivariance at a scalar lag, preserving the old isotropic API where
    /// anisotropic callers intentionally pass a pre-transformed lag.
    pub fn gamma(&self, h: f64) -> f64 {
        match self {
            SpatialVariogram::Isotropic(v) => v.gamma(h),
            SpatialVariogram::Anisotropic(v) => v.gamma_offset(h, 0.0, 0.0),
        }
    }
}

impl From<Variogram> for SpatialVariogram {
    fn from(value: Variogram) -> Self {
        SpatialVariogram::Isotropic(value)
    }
}

impl From<&Variogram> for SpatialVariogram {
    fn from(value: &Variogram) -> Self {
        SpatialVariogram::Isotropic(*value)
    }
}

impl From<AnisotropicVariogram> for SpatialVariogram {
    fn from(value: AnisotropicVariogram) -> Self {
        SpatialVariogram::Anisotropic(value)
    }
}

impl From<&AnisotropicVariogram> for SpatialVariogram {
    fn from(value: &AnisotropicVariogram) -> Self {
        SpatialVariogram::Anisotropic(*value)
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

    #[test]
    fn anisotropic_rejects_invalid_parameters_and_normalizes_azimuth() {
        assert!(AnisotropicVariogram::new(
            VariogramModel::Spherical,
            0.0,
            1.0,
            0.0,
            10.0,
            5.0,
            0.0
        )
        .is_err());
        assert!(AnisotropicVariogram::new(
            VariogramModel::Spherical,
            0.0,
            1.0,
            20.0,
            -10.0,
            5.0,
            0.0
        )
        .is_err());
        assert!(AnisotropicVariogram::new(
            VariogramModel::Spherical,
            0.0,
            1.0,
            20.0,
            10.0,
            f64::NAN,
            0.0
        )
        .is_err());
        assert!(AnisotropicVariogram::new(
            VariogramModel::Spherical,
            0.0,
            0.0,
            20.0,
            10.0,
            5.0,
            0.0
        )
        .is_err());
        let v =
            AnisotropicVariogram::new(VariogramModel::Spherical, 0.05, 1.0, 20.0, 10.0, 5.0, 395.0)
                .unwrap();
        assert_relative_eq!(v.azimuth, 35.0, epsilon = 1e-12);
    }

    #[test]
    fn isotropic_anisotropic_distance_matches_scalar_distance() {
        let iso = Variogram::new(VariogramModel::Spherical, 0.05, 1.0, 25.0).unwrap();
        let aniso =
            AnisotropicVariogram::isotropic(VariogramModel::Spherical, 0.05, 1.0, 25.0).unwrap();
        let d = (3.0_f64 * 3.0 + 4.0 * 4.0 + 12.0 * 12.0).sqrt();
        assert_relative_eq!(
            aniso.anisotropic_distance(3.0, 4.0, 12.0),
            d,
            epsilon = 1e-12
        );
        assert_relative_eq!(
            aniso.gamma_offset(3.0, 4.0, 12.0),
            iso.gamma(d),
            epsilon = 1e-12
        );
    }

    #[test]
    fn anisotropic_continuity_is_longer_along_major_after_rotation() {
        let v =
            AnisotropicVariogram::new(VariogramModel::Spherical, 0.0, 1.0, 100.0, 25.0, 10.0, 90.0)
                .unwrap();
        // Azimuth 90° puts the major axis along +x and the minor along y.
        let major_gamma = v.gamma_offset(30.0, 0.0, 0.0);
        let minor_gamma = v.gamma_offset(0.0, 30.0, 0.0);
        assert!(
            major_gamma < minor_gamma,
            "same lag should be more continuous along major: {major_gamma} !< {minor_gamma}"
        );
    }
}
