//! **Coupled petrophysics** — a synthetic porosity curve whose **net-to-gross is
//! DERIVED from the porosity itself** by a net cutoff, not generated as an
//! independent second channel.
//!
//! In a real well the net flag is a *consequence* of the porosity: a sample is
//! **net** when its effective porosity clears a cutoff (`φ ≥ c`, commonly
//! `c = 0.10`) and **non-net** (shale / tight) below it. Generating porosity and
//! NTG independently lets them contradict — a "net" sample sitting at 4 % porosity,
//! or an average porosity that cannot reproduce the quoted net-rock number. This
//! module removes the contradiction: it emits one [`PetroCurves`] where
//! `net_flag = (phie ≥ net_cutoff)` by construction, and *calibrates the generator
//! so the realized series still hits the numbers a petrophysicist quotes* — the
//! zone NTG and the mean/std **of the net rock**.
//!
//! ## The model — a facies mixture, then a cutoff
//!
//! Porosity is a two-facies mixture drawn on the thin-bedded architecture of
//! [`synth_facies_series`](crate::synth::synth_facies_series):
//!
//! ```text
//!   sand  facies  (proportion f):   φ ~ X_s = logistic(a_s + b_s·Z)
//!   shale facies  (proportion 1−f): φ ~ X_h = logistic(a_h + b_h·Z)
//!   net_flag = 1{ φ ≥ c }
//! ```
//!
//! The shale porosity `X_h` is the user's [`PetroZoneSpec::nonnet_por`] — a fixed
//! low-porosity distribution centred below the cutoff. The **sand** distribution
//! `X_s` and the **facies proportion** `f` are *solved* (they are not user inputs):
//! the numbers a petrophysicist supplies are net-rock statistics, and the sand
//! facies is the latent that reproduces them.
//!
//! ## Why net ≠ sand — the leak that must be accounted for
//!
//! The cutoff does **not** coincide with the facies boundary. A sand bed has a
//! **below-cutoff tail** (tight sand that logs as non-net); a shale bed has an
//! **above-cutoff tail** (silty shale that logs as net). Both tails leak across
//! the flag, so:
//!
//! - the realized **NTG is not `f`** — it is the mixture exceedance probability,
//!   and the facies proportion must *compensate* for the two leaks; and
//! - the **net rock is a mixture** of above-cutoff sand *and* above-cutoff shale —
//!   its mean is not the sand mean.
//!
//! ## The calibration (solved against the population)
//!
//! For a fitted logit-normal `D = logistic(a + b·Z)`, `Z ~ N(0,1)`, three
//! **exceedance functionals** capture how it sits relative to the cutoff. The cutoff
//! maps to a threshold in `Z` — `X ≥ c ⟺ Z ≥ z* = (logit(c) − a)/b` — so they have
//! smooth closed / one-integral forms (no hard-indicator staircase, which would give
//! the solver a noisy Jacobian):
//!
//! ```text
//!   p(D) = P(X ≥ c)      = 1 − Φ(z*)                                (exceedance prob)
//!   Q(D) = E[X·1{X≥c}]   = ∫_{z*}^∞ logistic(a+b·z) φ(z) dz          (above-cut mean mass)
//!   R(D) = E[X²·1{X≥c}]  = ∫_{z*}^∞ logistic(a+b·z)² φ(z) dz         (above-cut 2nd mass)
//! ```
//!
//! `Q, R` run by Simpson over the smooth tail; this matches the realized generation
//! exactly (both use the `N(0,1)` marginal). With `τ = ntg_target`, net-rock target
//! `{m_net, s_net}`, shale functionals `(p_h, Q_h, R_h)` fixed by `nonnet_por`, and
//! sand functionals `(p_s, Q_s, R_s)` a function of the unknown `(a_s, b_s)`, the
//! realized series must satisfy three equations in three unknowns `(a_s, b_s, f)`:
//!
//! ```text
//!   (I)   NTG:       f·p_s + (1−f)·p_h                 = τ
//!   (II)  net mean:  [ f·Q_s + (1−f)·Q_h ] / τ         = m_net
//!   (III) net std:   [ f·R_s + (1−f)·R_h ] / τ − m_net² = s_net²
//! ```
//!
//! Equation (I) pins the proportion, `f = (τ − p_h) / (p_s − p_h)`, leaving a
//! smooth 2-D root-find for `(a_s, b_s)` on the residuals `(II)`, `(III)`. It is
//! solved by a damped Newton iteration (numerical Jacobian, backtracking line
//! search) seeded from the moment-match of `{m_net, s_net}` — an excellent start,
//! since net rock *is* mostly sand when the shale leak is small. `a_s` moves the net
//! mean, `b_s` the net spread, so the Jacobian is diagonally dominant.
//!
//! ## Feasibility
//!
//! Two hard bounds are pre-checked and reported ([`AlgoError::InvalidArgument`],
//! with the offending number):
//!
//! - **NTG floor** — NTG cannot fall below the shale leak `p_h = P(X_h ≥ c)`; even
//!   with no sand the silty-shale tail is net.
//! - **Net-std floor** — a heavy leak makes the net rock **bimodal** (sand mixed
//!   with silty-shale net), so the net std has a floor equal to that between-facies
//!   spread (the `b_s → 0` limit). A `net_por.std` below it is unreachable at any
//!   sand spread; the fix is a wider `net_por.std` or a smaller leak.
//!
//! Derived independently from the logit-normal and truncated-Gaussian definitions
//! cited on the sibling modules; no third-party code was consulted.

use crate::foundation::{AlgoError, Result};
use crate::sampling::seeded_rng;
use crate::synth::correlated::{ar1_phi, correlated_gaussian};
use crate::synth::facies::{mix_seed, synth_facies_series, MomentSpec};
use crate::synth::transform::LogitNormal;
use statrs::distribution::{Continuous, ContinuousCDF, Normal as StatrsNormal};

/// The conventional effective-porosity net cutoff (`φ < 10 %` ⇒ non-net).
pub const DEFAULT_NET_CUTOFF: f64 = 0.10;

/// Population tolerance the calibration solves each residual (II)/(III) to.
const SOLVE_TOL: f64 = 1e-9;

/// One zone's **coupled** petrophysics target: a porosity generator whose net flag
/// is derived from the porosity by [`net_cutoff`](Self::net_cutoff), calibrated so
/// the realized series hits the quoted zone NTG and net-rock moments.
///
/// The **sand** porosity distribution and the facies proportion are *not* fields —
/// they are solved from these targets (see the [module docs](crate::synth::petro)).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PetroZoneSpec {
    /// Net cutoff on effective porosity: `net_flag = (phie ≥ net_cutoff)`
    /// (`0 < net_cutoff < 1`; conventionally [`DEFAULT_NET_CUTOFF`] = 0.10).
    pub net_cutoff: f64,
    /// Target net-to-gross — the realized fraction of samples with `phie ≥ cutoff`
    /// (`0 < ntg_target < 1`).
    pub ntg_target: f64,
    /// Target mean/std **of the net rock** (`phie` conditioned on `phie ≥ cutoff`)
    /// — the numbers a petrophysicist quotes for the reservoir.
    pub net_por: MomentSpec,
    /// The non-net (shale / tight) facies porosity distribution — a low-porosity
    /// `{mean, std}` centred below the cutoff. Its above-cutoff tail is the "leak"
    /// the calibration accounts for.
    pub nonnet_por: MomentSpec,
    /// Facies bed autocorrelation length in metres (`> 0`) — the mean bed scale of
    /// the sand/shale alternation.
    pub bed_scale_m: f64,
    /// Porosity within-facies autocorrelation length in metres (`> 0`) — the depth
    /// memory of the porosity fluctuation inside a bed.
    pub correlation_len_m: f64,
}

impl PetroZoneSpec {
    /// Build and validate a coupled petrophysics spec. Errors
    /// ([`AlgoError::InvalidArgument`]) unless `0 < net_cutoff < 1`,
    /// `0 < ntg_target < 1`, both moment specs are feasible `[0,1]` targets, and the
    /// two length scales are positive. Feasibility of the *coupling* (that the NTG /
    /// net-rock targets are jointly reachable) is checked when the generator solves
    /// the calibration — see [`synth_petro_curves`].
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        net_cutoff: f64,
        ntg_target: f64,
        net_por: MomentSpec,
        nonnet_por: MomentSpec,
        bed_scale_m: f64,
        correlation_len_m: f64,
    ) -> Result<PetroZoneSpec> {
        if !(net_cutoff.is_finite()) || net_cutoff <= 0.0 || net_cutoff >= 1.0 {
            return Err(AlgoError::InvalidArgument(
                "PetroZoneSpec: need 0 < net_cutoff < 1".to_string(),
            ));
        }
        if !(ntg_target.is_finite()) || ntg_target <= 0.0 || ntg_target >= 1.0 {
            return Err(AlgoError::InvalidArgument(
                "PetroZoneSpec: need 0 < ntg_target < 1".to_string(),
            ));
        }
        if !(bed_scale_m.is_finite() && bed_scale_m > 0.0) {
            return Err(AlgoError::InvalidArgument(
                "PetroZoneSpec: bed_scale_m must be finite and > 0".to_string(),
            ));
        }
        if !(correlation_len_m.is_finite() && correlation_len_m > 0.0) {
            return Err(AlgoError::InvalidArgument(
                "PetroZoneSpec: correlation_len_m must be finite and > 0".to_string(),
            ));
        }
        // Both moment targets must be feasible [0,1] logit-normal targets.
        LogitNormal::match_moments(net_por.mean, net_por.std)?;
        LogitNormal::match_moments(nonnet_por.mean, nonnet_por.std)?;
        Ok(PetroZoneSpec {
            net_cutoff,
            ntg_target,
            net_por,
            nonnet_por,
            bed_scale_m,
            correlation_len_m,
        })
    }

    /// As [`new`](Self::new) with the conventional [`DEFAULT_NET_CUTOFF`] (0.10).
    pub fn with_default_cutoff(
        ntg_target: f64,
        net_por: MomentSpec,
        nonnet_por: MomentSpec,
        bed_scale_m: f64,
        correlation_len_m: f64,
    ) -> Result<PetroZoneSpec> {
        PetroZoneSpec::new(
            DEFAULT_NET_CUTOFF,
            ntg_target,
            net_por,
            nonnet_por,
            bed_scale_m,
            correlation_len_m,
        )
    }
}

/// The output of [`synth_petro_curves`]: a porosity curve and its **derived** net
/// flag, aligned sample-for-sample (`net_flag[i] == phie[i] >= net_cutoff`).
#[derive(Debug, Clone, PartialEq)]
pub struct PetroCurves {
    /// Effective porosity in `[0, 1]`, one value per depth sample.
    pub phie: Vec<f64>,
    /// The derived net flag — `true` where `phie ≥ net_cutoff`.
    pub net_flag: Vec<bool>,
}

/// The solved facies mixture that makes the realized coupled series hit the spec.
#[derive(Debug, Clone, Copy)]
struct Calibration {
    /// Facies proportion `f = P(sand)`.
    sand_fraction: f64,
    /// Solved sand porosity distribution.
    sand: LogitNormal,
    /// Fixed shale porosity distribution (from `nonnet_por`).
    shale: LogitNormal,
}

/// Exceedance functionals `(p, Q, R) = (P(X≥c), E[X·1{X≥c}], E[X²·1{X≥c}])` of a
/// fitted logit-normal `X = logistic(a + b·Z)`, `Z ~ N(0,1)`.
///
/// Computed **analytically-smoothly**, not by a hard indicator over fixed nodes: the
/// cutoff maps to a threshold in `Z`, `X ≥ c ⟺ Z ≥ z* = (logit(c) − a)/b`, so
/// `p = 1 − Φ(z*)` is exact and smooth in `(a, b)`, and the mass integrals `Q, R`
/// run by Simpson over the smooth tail `[z*, 8]`. Smoothness is what lets the Newton
/// calibration converge — a staircase indicator sum has a noisy Jacobian. It also
/// matches the realized generation exactly (both use the `N(0,1)` marginal).
fn exceedance(ln: &LogitNormal, c: f64) -> (f64, f64, f64) {
    let (a, b) = ln.ab();
    let snorm = StatrsNormal::new(0.0, 1.0).expect("standard normal");
    let logit_c = (c / (1.0 - c)).ln();
    let zc = (logit_c - a) / b; // b > 0 by construction
    let p = (1.0 - snorm.cdf(zc)).clamp(0.0, 1.0);
    let lo = zc.max(-8.0);
    let hi = 8.0;
    if lo >= hi {
        return (p, 0.0, 0.0);
    }
    // Composite Simpson over [lo, 8] (even panel count).
    const M: usize = 2000;
    let step = (hi - lo) / M as f64;
    let (mut sq, mut sr) = (0.0, 0.0);
    for k in 0..=M {
        let z = lo + k as f64 * step;
        let w = if k == 0 || k == M {
            1.0
        } else if k % 2 == 1 {
            4.0
        } else {
            2.0
        };
        let x = ln.apply(z); // logistic(a + b·z)
        let pdf = snorm.pdf(z);
        sq += w * x * pdf;
        sr += w * x * x * pdf;
    }
    (p, sq * step / 3.0, sr * step / 3.0)
}

/// The net-conditioned `(mean, std)` residual against `net_por` for a candidate sand
/// `(a_s, b_s)`, plus the proportion `f` that (I) pins. `None` ⇒ the candidate is
/// degenerate (`p_s == p_h`); an out-of-range `f` is returned so the solver can
/// back off toward the feasible interior.
#[allow(clippy::too_many_arguments)]
fn residual(
    a: f64,
    b: f64,
    c: f64,
    tau: f64,
    m_net: f64,
    s_net: f64,
    ph: f64,
    qh: f64,
    rh: f64,
) -> Option<(f64, f64, f64)> {
    let sand = LogitNormal::from_ab(a, b);
    let (ps, qs, rs) = exceedance(&sand, c);
    let denom = ps - ph;
    if denom.abs() < 1e-12 {
        return None;
    }
    let f = (tau - ph) / denom;
    let net_mean = (f * qs + (1.0 - f) * qh) / tau;
    let net_var = ((f * rs + (1.0 - f) * rh) / tau - net_mean * net_mean).max(0.0);
    Some((net_mean - m_net, net_var.sqrt() - s_net, f))
}

/// Solve the facies mixture `(f, sand, shale)` that makes the realized coupled
/// series satisfy (I)–(III). Errors with the achievable bound when infeasible.
fn calibrate(zone: &PetroZoneSpec) -> Result<Calibration> {
    let c = zone.net_cutoff;
    let tau = zone.ntg_target;
    let (m_net, s_net) = (zone.net_por.mean, zone.net_por.std);

    // Shale distribution is fixed by nonnet_por; its exceedance functionals set the
    // hard NTG floor p_h (the silty-shale leak that is net even with no sand).
    let shale = LogitNormal::match_moments(zone.nonnet_por.mean, zone.nonnet_por.std)?;
    let (ph, qh, rh) = exceedance(&shale, c);
    if tau <= ph {
        return Err(AlgoError::InvalidArgument(format!(
            "synth_petro_curves: ntg_target {tau:.4} is at/below the achievable floor \
             {ph:.4} = P(nonnet porosity ≥ cutoff {c:.3}) — the shale above-cutoff leak \
             alone meets or exceeds it. Raise ntg_target, lower nonnet_por, or lower net_cutoff."
        )));
    }

    // --- Net-std FLOOR (the leak makes the net rock bimodal) ---
    // As the sand within-facies spread b → 0 (sand collapses to a spike at level v),
    // the net rock is `v` with weight f·1 plus the above-cutoff shale tail. Its std
    // is the between-facies spread — the MINIMUM net std achievable at any b ≥ 0.
    // A target below it cannot be reached: raise net_por.std or shrink the leak.
    let f0 = (tau - ph) / (1.0 - ph); // b→0 ⇒ P(sand≥c)=1 ⇒ f from (I)
    let v = (m_net * tau - (1.0 - f0) * qh) / f0; // spike level from the net-mean eq
    if !(v > c && v < 1.0) {
        return Err(AlgoError::InvalidArgument(format!(
            "synth_petro_curves: net_por mean {m_net:.4} is not reachable at ntg_target \
             {tau:.4} with this nonnet_por/cutoff — the implied sand level {v:.4} falls \
             outside (cutoff {c:.3}, 1). Raise net_por mean or ntg_target."
        )));
    }
    let net2_floor = (f0 * v * v + (1.0 - f0) * rh) / tau;
    let std_floor = (net2_floor - m_net * m_net).max(0.0).sqrt();
    if s_net <= std_floor {
        return Err(AlgoError::InvalidArgument(format!(
            "synth_petro_curves: net_por std {s_net:.4} is below the achievable floor \
             {std_floor:.4} — with ntg_target {tau:.4} and this nonnet_por/cutoff {c:.3} the \
             shale above-cutoff leak (P={ph:.4}) alone makes the net rock spread at least this \
             wide (the net rock is bimodal: sand ≈{v:.3} mixed with silty-shale net). Raise \
             net_por.std, or reduce the leak (lower nonnet_por mean/std, or the cutoff)."
        )));
    }

    let res = |a: f64, b: f64| residual(a, b, c, tau, m_net, s_net, ph, qh, rh);
    let norm = |g: (f64, f64, f64)| (g.0 * g.0 + g.1 * g.1).sqrt();
    let feasible = |g: (f64, f64, f64)| g.2 > 1e-9 && g.2 < 1.0 - 1e-9;

    // Seed from the moment-match of the net-rock target: net rock is mostly sand,
    // so LN(m_net, s_net) is an excellent starting sand distribution. Solve the 2-D
    // root (a moves the net mean, b the net spread) by a damped Newton with a
    // numerical Jacobian; b is clamped strictly positive (b→0 is the floor corner).
    let (mut a, mut b) = LogitNormal::match_moments(m_net, s_net)?.ab();
    let h = 1e-5_f64;
    let b_min = 1e-4_f64;
    let b_max = 60.0_f64;
    let mut solved = false;
    for _ in 0..200 {
        let g0 = res(a, b).ok_or_else(degenerate_err)?;
        if g0.0.abs() < SOLVE_TOL && g0.1.abs() < SOLVE_TOL && feasible(g0) {
            solved = true;
            break;
        }
        let ga_p = res(a + h, b).ok_or_else(degenerate_err)?;
        let ga_m = res(a - h, b).ok_or_else(degenerate_err)?;
        let gb_p = res(a, (b + h).min(b_max)).ok_or_else(degenerate_err)?;
        let gb_m = res(a, (b - h).max(b_min)).ok_or_else(degenerate_err)?;
        let j00 = (ga_p.0 - ga_m.0) / (2.0 * h);
        let j10 = (ga_p.1 - ga_m.1) / (2.0 * h);
        let j01 = (gb_p.0 - gb_m.0) / (2.0 * h);
        let j11 = (gb_p.1 - gb_m.1) / (2.0 * h);
        let det = j00 * j11 - j01 * j10;
        if det.abs() < 1e-16 {
            break;
        }
        let da = -(j11 * g0.0 - j01 * g0.1) / det;
        let db = -(-j10 * g0.0 + j00 * g0.1) / det;

        // Backtracking line search: keep b ∈ [b_min, b_max], f feasible, ‖g‖ down.
        let mut step = 1.0_f64;
        let mut accepted = false;
        for _ in 0..50 {
            let na = a + step * da;
            let nb = (b + step * db).clamp(b_min, b_max);
            if let Some(gn) = res(na, nb) {
                if feasible(gn) && norm(gn) < norm(g0) {
                    a = na;
                    b = nb;
                    accepted = true;
                    break;
                }
            }
            step *= 0.5;
        }
        if !accepted {
            break;
        }
    }

    let g = res(a, b).ok_or_else(degenerate_err)?;
    if !solved && (g.0.abs() >= 1e-7 || g.1.abs() >= 1e-7) {
        return Err(AlgoError::InvalidArgument(format!(
            "synth_petro_curves: calibration failed to converge for ntg_target {tau:.4}, \
             net_por (mean {m_net:.4}, std {s_net:.4}), cutoff {c:.3} (residual net mean \
             {:.5}, net std {:.5}). Adjust the targets.",
            g.0, g.1
        )));
    }
    if !feasible(g) {
        let (ps, _, _) = exceedance(&LogitNormal::from_ab(a, b), c);
        return Err(AlgoError::InvalidArgument(format!(
            "synth_petro_curves: ntg_target {tau:.4} is unreachable for this net_por — the \
             matching sand has P(sand≥cutoff) = {ps:.4}, so the achievable NTG lies strictly \
             between the shale floor {ph:.4} and {ps:.4}. Adjust ntg_target or net_por."
        )));
    }

    Ok(Calibration {
        sand_fraction: g.2,
        sand: LogitNormal::from_ab(a, b),
        shale,
    })
}

fn degenerate_err() -> AlgoError {
    AlgoError::InvalidArgument(
        "synth_petro_curves: calibration hit a degenerate sand distribution \
         (P(sand≥cutoff) == P(shale≥cutoff)); check the specs."
            .to_string(),
    )
}

/// Generate a **coupled** porosity + derived net-flag curve for one zone, sampled
/// every `depth_step` metres over `n_samples` samples (top first).
///
/// The net flag is `phie ≥ net_cutoff` by construction; the generator solves a
/// facies mixture (see the [module docs](crate::synth::petro)) so the realized
/// series hits `ntg_target` and the net-rock `{mean, std}` in `net_por` within
/// sampling tolerance. Porosity is depth-autocorrelated (bed architecture at
/// `bed_scale_m`, within-facies memory at `correlation_len_m`) and strictly inside
/// `[0, 1]`.
///
/// Errors on `n_samples == 0`, a non-positive `depth_step`, or an **infeasible**
/// spec (with the achievable NTG bound stated). Bit-reproducible per `seed`.
pub fn synth_petro_curves(
    zone: &PetroZoneSpec,
    depth_step: f64,
    n_samples: usize,
    seed: u64,
) -> Result<PetroCurves> {
    if n_samples == 0 {
        return Err(AlgoError::EmptyInput("synth_petro_curves: n_samples = 0"));
    }
    if !(depth_step.is_finite() && depth_step > 0.0) {
        return Err(AlgoError::InvalidArgument(
            "synth_petro_curves: depth_step must be finite and > 0".to_string(),
        ));
    }

    let cal = calibrate(zone)?;

    // Facies architecture at the solved proportion (its own stream, seed).
    let facies = synth_facies_series(
        n_samples,
        depth_step,
        cal.sand_fraction,
        zone.bed_scale_m,
        seed,
    )?;

    // Porosity on an INDEPENDENT sub-stream (mix_seed) so facies selection does not
    // bias the per-facies porosity — the same decoupling synth_por_with_facies uses,
    // and the independence the calibration's exceedance functionals assume.
    let phi = ar1_phi(depth_step, zone.correlation_len_m);
    let mut rng = seeded_rng(mix_seed(seed));
    let driver = correlated_gaussian(n_samples, |_| phi, &mut rng);

    let phie: Vec<f64> = facies
        .iter()
        .zip(driver.iter())
        .map(|(f, &z)| {
            if f.is_sand() {
                cal.sand.apply(z)
            } else {
                cal.shale.apply(z)
            }
        })
        .collect();
    let net_flag: Vec<bool> = phie.iter().map(|&p| p >= zone.net_cutoff).collect();

    Ok(PetroCurves { phie, net_flag })
}

/// A continuous NTG **display** curve from a derived `net_flag`: the centred running
/// mean of the flag over a `window_m`-metre window (samples spaced `depth_step` m).
///
/// Log displays show NTG as a smooth curve, not a strip of 0/1 flags; this is that
/// curve — `1.0` in a fully net interval, `0.0` in a fully non-net one, graded across
/// bed boundaries. Errors on an empty `net_flag` or a non-positive `depth_step` /
/// `window_m`.
pub fn ntg_curve(net_flag: &[bool], depth_step: f64, window_m: f64) -> Result<Vec<f64>> {
    if net_flag.is_empty() {
        return Err(AlgoError::EmptyInput("ntg_curve: empty net_flag"));
    }
    if !(depth_step.is_finite() && depth_step > 0.0) {
        return Err(AlgoError::InvalidArgument(
            "ntg_curve: depth_step must be finite and > 0".to_string(),
        ));
    }
    if !(window_m.is_finite() && window_m > 0.0) {
        return Err(AlgoError::InvalidArgument(
            "ntg_curve: window_m must be finite and > 0".to_string(),
        ));
    }
    let n = net_flag.len();
    // Half-window in samples (at least one sample either side is honoured via max(1)).
    let half = ((window_m / depth_step).round() as usize / 2).max(1);
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let lo = i.saturating_sub(half);
        let hi = (i + half + 1).min(n);
        let net = net_flag[lo..hi].iter().filter(|&&b| b).count();
        out.push(net as f64 / (hi - lo) as f64);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stats::{mean, std_dev};
    use crate::synth::correlated::lag1_autocorr;

    fn spec(ntg: f64) -> PetroZoneSpec {
        PetroZoneSpec::with_default_cutoff(
            ntg,
            MomentSpec::new(0.24, 0.04).unwrap(), // net rock: mean/std of φ | net
            MomentSpec::new(0.06, 0.015).unwrap(), // shale facies porosity (small leak)
            2.0,                                  // bed scale
            1.5,                                  // porosity correlation length
        )
        .unwrap()
    }

    /// Realized (NTG, net mean, net std) of a generated series.
    fn realized(c: &PetroCurves) -> (f64, f64, f64) {
        let ntg = c.net_flag.iter().filter(|&&b| b).count() as f64 / c.net_flag.len() as f64;
        let net: Vec<f64> = c
            .phie
            .iter()
            .zip(&c.net_flag)
            .filter(|(_, &f)| f)
            .map(|(&p, _)| p)
            .collect();
        (ntg, mean(&net).unwrap(), std_dev(&net).unwrap())
    }

    #[test]
    fn bad_args_error() {
        let s = spec(0.6);
        assert!(synth_petro_curves(&s, 0.0, 100, 1).is_err());
        assert!(synth_petro_curves(&s, 0.25, 0, 1).is_err());
        assert!(PetroZoneSpec::with_default_cutoff(
            1.0,
            MomentSpec::new(0.24, 0.03).unwrap(),
            MomentSpec::new(0.06, 0.02).unwrap(),
            2.0,
            1.5
        )
        .is_err());
    }

    #[test]
    fn bit_reproducible() {
        let s = spec(0.6);
        let a = synth_petro_curves(&s, 0.25, 500, 2026).unwrap();
        let b = synth_petro_curves(&s, 0.25, 500, 2026).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn net_flag_is_exactly_the_cutoff_of_phie() {
        let s = spec(0.7);
        let c = synth_petro_curves(&s, 0.25, 2000, 11).unwrap();
        assert_eq!(c.phie.len(), c.net_flag.len());
        for (&p, &f) in c.phie.iter().zip(&c.net_flag) {
            assert_eq!(f, p >= s.net_cutoff, "flag must equal phie >= cutoff");
            assert!(p > 0.0 && p < 1.0, "phie {p} out of (0,1)");
        }
    }

    #[test]
    fn hits_ntg_and_net_moments_across_seeds() {
        // Acceptance: realized NTG within 0.02, net mean/std within 0.02, per-seed,
        // over ≥5 seeds and several NTG targets. Long series to suppress the facies
        // autocorrelation's sampling scatter in the realized NTG.
        let depth_step = 0.25;
        let n = 30_000;
        for &ntg in &[0.35_f64, 0.55, 0.75, 0.9] {
            let s = spec(ntg);
            for seed in 0..6u64 {
                let c = synth_petro_curves(&s, depth_step, n, seed).unwrap();
                let (rntg, rmean, rstd) = realized(&c);
                assert!(
                    (rntg - ntg).abs() < 0.02,
                    "ntg={ntg} seed={seed}: realized {rntg:.4}"
                );
                assert!(
                    (rmean - s.net_por.mean).abs() < 0.02,
                    "ntg={ntg} seed={seed}: net mean {rmean:.4} vs {}",
                    s.net_por.mean
                );
                assert!(
                    (rstd - s.net_por.std).abs() < 0.02,
                    "ntg={ntg} seed={seed}: net std {rstd:.4} vs {}",
                    s.net_por.std
                );
            }
        }
    }

    #[test]
    fn fat_shale_above_cutoff_tail_still_hits_ntg() {
        // A deliberately silty shale (mean 0.08, just below the 0.10 cutoff): its
        // above-cutoff leak is heavy (P(shale≥cutoff) ≈ 0.15). The facies proportion
        // must compensate so the realized NTG still lands on target, and the net-rock
        // std must accommodate the bimodality the leak imposes (net = sand + a fat
        // silty-shale-net tail).
        let depth_step = 0.25;
        let n = 30_000;
        let s = PetroZoneSpec::with_default_cutoff(
            0.5,
            MomentSpec::new(0.20, 0.06).unwrap(),
            MomentSpec::new(0.08, 0.02).unwrap(), // fat above-cutoff leak
            2.0,
            1.5,
        )
        .unwrap();
        // The leak is material: the sand proportion must sit BELOW the NTG target —
        // the silty-shale net makes up the difference (f + leak == NTG).
        let cal = calibrate(&s).unwrap();
        assert!(
            cal.sand_fraction < 0.5,
            "with a heavy shale leak the sand proportion must sit below the NTG target \
             (f + leak == NTG); got f={:.3}",
            cal.sand_fraction
        );
        for seed in 0..5u64 {
            let c = synth_petro_curves(&s, depth_step, n, seed).unwrap();
            let (rntg, rmean, rstd) = realized(&c);
            assert!(
                (rntg - 0.5).abs() < 0.02,
                "seed={seed}: realized NTG {rntg:.4}"
            );
            assert!(
                (rmean - 0.20).abs() < 0.02,
                "seed={seed}: net mean {rmean:.4}"
            );
            assert!((rstd - 0.06).abs() < 0.02, "seed={seed}: net std {rstd:.4}");
        }
    }

    #[test]
    fn net_rock_is_a_mixture_not_pure_sand() {
        // Prove net ≠ sand: some net samples are above-cutoff shale, and some sand
        // samples are non-net (below-cutoff sand). Both leaks are non-trivial here.
        let s = PetroZoneSpec::with_default_cutoff(
            0.5,
            MomentSpec::new(0.20, 0.06).unwrap(),
            MomentSpec::new(0.08, 0.02).unwrap(),
            2.0,
            1.5,
        )
        .unwrap();
        let cal = calibrate(&s).unwrap();
        let (ps, _, _) = exceedance(&cal.sand, s.net_cutoff);
        let (ph, _, _) = exceedance(&cal.shale, s.net_cutoff);
        assert!(
            ps < 1.0,
            "sand has some below-cutoff mass: P(sand≥c)={ps:.4}"
        );
        assert!(
            ph > 0.05,
            "shale has a real above-cutoff leak: P(shale≥c)={ph:.3}"
        );
        // NTG identity: f·P(sand≥c) + (1−f)·P(shale≥c) == ntg_target.
        let ntg_pop = cal.sand_fraction * ps + (1.0 - cal.sand_fraction) * ph;
        assert!(
            (ntg_pop - s.ntg_target).abs() < 1e-6,
            "population NTG {ntg_pop:.6}"
        );
    }

    #[test]
    fn autocorrelation_preserved() {
        // The derived net flag (as 0/1) retains bed-scale memory — not white noise.
        let s = spec(0.6);
        let c = synth_petro_curves(&s, 0.25, 20_000, 3).unwrap();
        let flag01: Vec<f64> = c
            .net_flag
            .iter()
            .map(|&b| if b { 1.0 } else { 0.0 })
            .collect();
        let r = lag1_autocorr(&flag01);
        assert!(r > 0.5, "net-flag lag-1 autocorr {r} — beds should persist");
        // Porosity likewise remembers depth.
        assert!(lag1_autocorr(&c.phie) > 0.5, "phie autocorr too low");
    }

    #[test]
    fn infeasible_ntg_below_shale_floor_errors() {
        // A high, wide shale (large leak) with an NTG target beneath the floor.
        let s = PetroZoneSpec::with_default_cutoff(
            0.05, // below P(shale ≥ 0.10) for this shale
            MomentSpec::new(0.24, 0.03).unwrap(),
            MomentSpec::new(0.09, 0.03).unwrap(),
            2.0,
            1.5,
        )
        .unwrap();
        let err = synth_petro_curves(&s, 0.25, 1000, 1).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("floor"), "error should state the floor: {msg}");
    }

    #[test]
    fn infeasible_net_std_below_leak_floor_errors() {
        // A fat leak forces the net rock bimodal; a too-tight net std is unreachable.
        // The error must state the achievable net-std floor.
        let s = PetroZoneSpec::with_default_cutoff(
            0.5,
            MomentSpec::new(0.22, 0.035).unwrap(), // std too small for this leak
            MomentSpec::new(0.085, 0.03).unwrap(), // heavy above-cutoff leak
            2.0,
            1.5,
        )
        .unwrap();
        let err = synth_petro_curves(&s, 0.25, 1000, 1).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("floor") && msg.contains("bimodal"),
            "error should state the net-std floor + bimodality: {msg}"
        );
    }

    #[test]
    fn ntg_curve_tracks_flag_density() {
        let s = spec(0.7);
        let c = synth_petro_curves(&s, 0.25, 4000, 9).unwrap();
        let curve = ntg_curve(&c.net_flag, 0.25, 8.0).unwrap();
        assert_eq!(curve.len(), c.net_flag.len());
        assert!(curve.iter().all(|&v| (0.0..=1.0).contains(&v)));
        // The windowed-average curve's overall mean tracks the raw NTG.
        let raw = c.net_flag.iter().filter(|&&b| b).count() as f64 / c.net_flag.len() as f64;
        assert!((mean(&curve).unwrap() - raw).abs() < 0.03);
        assert!(ntg_curve(&[], 0.25, 8.0).is_err());
    }
}
