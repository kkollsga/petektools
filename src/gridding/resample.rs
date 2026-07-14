//! `resample` — resample a native regular grid onto a foreign regular
//! [`Lattice`] (grid → grid), the counterpart to the scattered → grid kernels.
//!
//! The family has surface loaders and fast scattered → lattice gridding, but no
//! first-class resample of an already-gridded field onto a *different* lattice —
//! consumers hand-rolled it (a private trend-surface resampler downstream will
//! retire onto this one). This is that kernel: given a source field on its own
//! georeferencing lattice, sample it at the world positions of a target
//! lattice's nodes.
//!
//! ## Georeferencing (no new type)
//!
//! The source grid's georeference **is** a [`Lattice`] — it already carries the
//! origin (`xori`, `yori`) + spacing (`xinc`, `yinc`) + node counts in world
//! coordinates, so no new georef type is introduced (house style: convert /
//! reuse at the seam rather than add a parallel type). The source values are an
//! `Array2<f64>` shaped `(ncol, nrow)` to match `src_georef`, `NaN` where a node
//! is undefined.
//!
//! ## Exact frame transform
//!
//! Source and target may independently carry intrinsic rotation and a flipped J
//! axis. Every target node is mapped to world through
//! [`Lattice::intrinsic_to_world`] and then through the exact inverse source
//! transform [`Lattice::world_to_intrinsic`]. Interpolation itself remains the
//! same axis-aligned index-space kernel; frame handling is composed at this one
//! seam rather than duplicated inside bilinear/nearest sampling.
//!
//! ## Null / extent policy (chosen, fixed, documented)
//!
//! - **Outside the source extent → `NaN`.** A target node whose world position
//!   maps outside `[0, ncol−1] × [0, nrow−1]` in source index space is **never**
//!   extrapolated; it is left `NaN`.
//! - **[`ResampleMethod::Nearest`]** snaps to the single closest source node; if
//!   that node is `NaN`, the result is `NaN`.
//! - **[`ResampleMethod::Bilinear`] null policy:** if the *nearest* of the four
//!   surrounding source corners is `NaN`, the result is `NaN`; otherwise the
//!   estimate is the weight-weighted mean over the **finite** corners with the
//!   weights **renormalized** to sum to 1 (a `NaN` corner is dropped, not
//!   treated as zero). This keeps a hole from silently bleeding a low value into
//!   its neighbours while still filling the finite-supported fringe.

use crate::foundation::{AlgoError, Lattice, Result};
use ndarray::Array2;

/// Snap tolerance in **index space**: a fractional source index within this of
/// an integer is snapped onto it, so an identity resample stays bit-exact and a
/// floating-point boundary point does not spuriously fall out of extent. At
/// sub-`1e-9` of a node it is far below any real sampling resolution.
const SNAP_EPS: f64 = 1e-9;

/// Interpolation method for [`resample`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResampleMethod {
    /// Bilinear over the four surrounding source nodes — exact for affine
    /// (planar) fields. Null-aware (see the module's bilinear null policy).
    Bilinear,
    /// Value of the single areally-nearest source node (blocky, exact at nodes).
    Nearest,
}

/// Resample `src_grid` (node values on `src_georef`) onto the node lattice of
/// `target`, returning the `(target.ncol × target.nrow)` field. A target node
/// outside the source extent — and, per the module null policy, one whose
/// controlling source corner is `NaN` — is `NaN`.
///
/// Errors if `src_grid`'s shape does not match `src_georef`'s `(ncol, nrow)`, or
/// if the source geometry is degenerate (zero spacing / empty grid).
pub fn resample(
    src_grid: &Array2<f64>,
    src_georef: &Lattice,
    target: &Lattice,
    method: ResampleMethod,
) -> Result<Array2<f64>> {
    let (ncol, nrow) = (src_georef.ncol, src_georef.nrow);
    if src_grid.dim() != (ncol, nrow) {
        return Err(AlgoError::InvalidArgument(format!(
            "resample: src_grid shape {:?} does not match src_georef ({ncol}, {nrow})",
            src_grid.dim()
        )));
    }
    if ncol == 0 || nrow == 0 || src_georef.xinc == 0.0 || src_georef.yinc == 0.0 {
        return Err(AlgoError::InvalidGeometry(
            "resample: degenerate source geometry (empty grid or zero node spacing)",
        ));
    }

    let mut out = Array2::from_elem((target.ncol, target.nrow), f64::NAN);
    let imax = (ncol - 1) as f64;
    let jmax = (nrow - 1) as f64;

    for tj in 0..target.nrow {
        for ti in 0..target.ncol {
            let (x, y) = target.intrinsic_to_world(ti as f64, tj as f64);
            // Map the target node's WORLD position into source index space (this
            // is what honours the georeference — not an index-for-index copy).
            let Some((fi, fj)) = src_georef.world_to_intrinsic(x, y) else {
                continue; // degenerate source (already guarded) → leave NaN
            };
            let fi = snap(fi);
            let fj = snap(fj);
            // Extent policy: outside the source node span → NaN (no extrapolation).
            if fi < 0.0 || fi > imax || fj < 0.0 || fj > jmax {
                continue;
            }
            out[[ti, tj]] = match method {
                ResampleMethod::Nearest => sample_nearest(src_grid, fi, fj),
                ResampleMethod::Bilinear => sample_bilinear(src_grid, fi, fj, ncol, nrow),
            };
        }
    }
    Ok(out)
}

/// Snap a fractional index onto the nearest integer when within [`SNAP_EPS`].
fn snap(f: f64) -> f64 {
    if (f - f.round()).abs() < SNAP_EPS {
        f.round()
    } else {
        f
    }
}

/// Value of the source node nearest to fractional index `(fi, fj)`. `fi`/`fj` are
/// guaranteed in `[0, ncol−1] × [0, nrow−1]`, so the rounded indices are valid.
fn sample_nearest(src: &Array2<f64>, fi: f64, fj: f64) -> f64 {
    src[[fi.round() as usize, fj.round() as usize]]
}

/// Bilinear sample at fractional index `(fi, fj)` with the module null policy.
fn sample_bilinear(src: &Array2<f64>, fi: f64, fj: f64, ncol: usize, nrow: usize) -> f64 {
    // Null policy: NaN if the *nearest* corner is NaN.
    if src[[fi.round() as usize, fj.round() as usize]].is_nan() {
        return f64::NAN;
    }
    let i0 = fi.floor() as usize;
    let j0 = fj.floor() as usize;
    // Clamp the far corner at the boundary; there the fractional weight is 0, so
    // the duplicated corner contributes nothing (no double counting).
    let i1 = (i0 + 1).min(ncol - 1);
    let j1 = (j0 + 1).min(nrow - 1);
    let ri = fi - i0 as f64; // fractional offset in [0, 1]
    let rj = fj - j0 as f64;

    let corners = [
        (src[[i0, j0]], (1.0 - ri) * (1.0 - rj)),
        (src[[i1, j0]], ri * (1.0 - rj)),
        (src[[i0, j1]], (1.0 - ri) * rj),
        (src[[i1, j1]], ri * rj),
    ];
    // Weighted mean over the finite corners, weights renormalized (drop NaNs).
    let mut acc = 0.0;
    let mut wsum = 0.0;
    for (v, w) in corners {
        if w > 0.0 && v.is_finite() {
            acc += v * w;
            wsum += w;
        }
    }
    if wsum > 0.0 {
        acc / wsum
    } else {
        f64::NAN
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;
    use ndarray::arr2;

    /// An affine (planar) field — bilinear resampling is exact on it.
    fn plane(x: f64, y: f64) -> f64 {
        3.0 + 0.5 * x - 0.25 * y
    }

    /// Fill a lattice's nodes from a closure of world `(x, y)`.
    fn sample_lattice(lat: &Lattice, f: impl Fn(f64, f64) -> f64) -> Array2<f64> {
        let mut a = Array2::zeros((lat.ncol, lat.nrow));
        for j in 0..lat.nrow {
            for i in 0..lat.ncol {
                let (x, y) = lat.node_xy(i, j);
                a[[i, j]] = f(x, y);
            }
        }
        a
    }

    #[test]
    fn identity_resample_is_bit_equal() {
        // Same lattice in and out ⇒ every node value copied bit-for-bit, for
        // BOTH methods, and a NaN hole propagates identically.
        let lat = Lattice::regular(1000.0, 2000.0, 25.0, 50.0, 6, 5);
        let mut src = sample_lattice(&lat, plane);
        src[[2, 3]] = f64::NAN; // a hole must survive an identity resample
        for method in [ResampleMethod::Bilinear, ResampleMethod::Nearest] {
            let out = resample(&src, &lat, &lat, method).unwrap();
            assert_eq!(out.dim(), src.dim());
            for (o, s) in out.iter().zip(src.iter()) {
                if s.is_nan() {
                    assert!(o.is_nan(), "hole must stay NaN under {method:?}");
                } else {
                    assert_eq!(o, s, "identity must be bit-equal under {method:?}");
                }
            }
        }
    }

    #[test]
    fn bilinear_exact_on_affine_2x_refinement() {
        // Bilinear reproduces an affine field exactly; refine 2× and every new
        // node must equal the analytic plane.
        let src_lat = Lattice::regular(0.0, 0.0, 10.0, 10.0, 5, 5);
        let src = sample_lattice(&src_lat, plane);
        // 2× finer, same extent (0..40 in x and y).
        let target = Lattice::regular(0.0, 0.0, 5.0, 5.0, 9, 9);
        let out = resample(&src, &src_lat, &target, ResampleMethod::Bilinear).unwrap();
        for j in 0..target.nrow {
            for i in 0..target.ncol {
                let (x, y) = target.node_xy(i, j);
                assert_relative_eq!(out[[i, j]], plane(x, y), epsilon = 1e-9);
            }
        }
    }

    #[test]
    fn rotated_source_and_target_are_exact_on_affine_world_field() {
        let src_lat =
            Lattice::oriented(431_000.0, 6_521_000.0, 10.0, 12.0, 5, 5, 30.0, true).unwrap();
        let src = sample_lattice(&src_lat, plane);
        let target = Lattice::oriented(431_000.0, 6_521_000.0, 5.0, 6.0, 9, 9, 30.0, true).unwrap();
        let out = resample(&src, &src_lat, &target, ResampleMethod::Bilinear).unwrap();
        for j in 0..target.nrow {
            for i in 0..target.ncol {
                let (x, y) = target.node_xy(i, j);
                assert_relative_eq!(out[[i, j]], plane(x, y), epsilon = 1e-8);
            }
        }
    }

    #[test]
    fn rotated_source_inverse_samples_an_unrotated_world_target() {
        let src_lat = Lattice::oriented(1000.0, 2000.0, 10.0, 10.0, 5, 5, 30.0, false).unwrap();
        let src = sample_lattice(&src_lat, plane);
        let (x, y) = src_lat.intrinsic_to_world(1.25, 2.5);
        let target = Lattice::regular(x, y, 1.0, 1.0, 1, 1);
        let out = resample(&src, &src_lat, &target, ResampleMethod::Bilinear).unwrap();
        assert_relative_eq!(out[[0, 0]], plane(x, y), epsilon = 1e-9);
    }

    #[test]
    fn nearest_snaps_to_closest_node() {
        // Source values distinct per column so a snap is observable.
        let src_lat = Lattice::regular(0.0, 0.0, 10.0, 10.0, 3, 1);
        let src = arr2(&[[0.0], [10.0], [20.0]]); // col 0→0, col 1→10, col 2→20
                                                  // Target nodes at world x = 2 (→ fi 0.2, nearest col 0) and x = 8
                                                  // (→ fi 0.8, nearest col 1).
        let target = Lattice::regular(2.0, 0.0, 6.0, 10.0, 2, 1);
        let out = resample(&src, &src_lat, &target, ResampleMethod::Nearest).unwrap();
        assert_eq!(out[[0, 0]], 0.0);
        assert_eq!(out[[1, 0]], 10.0);
    }

    #[test]
    fn null_hole_propagation_bilinear() {
        // 3×3 source with a NaN at the centre node (1,1).
        let src_lat = Lattice::regular(0.0, 0.0, 10.0, 10.0, 3, 3);
        let mut src = arr2(&[[0.0, 10.0, 0.0], [10.0, 0.0, 0.0], [0.0, 0.0, 0.0]]);
        src[[1, 1]] = f64::NAN;

        // (a) A target node whose nearest corner IS the hole → NaN.
        //     world (5,5) → fi=fj=0.5, round → corner (1,1) = the hole.
        let t_hole = Lattice::regular(5.0, 5.0, 10.0, 10.0, 1, 1);
        let oh = resample(&src, &src_lat, &t_hole, ResampleMethod::Bilinear).unwrap();
        assert!(oh[[0, 0]].is_nan(), "nearest corner NaN ⇒ NaN");

        // (b) A target node whose nearest corner is FINITE but one of the four
        //     corners is the hole → finite, weighted over the finite corners
        //     with weights renormalized. world (3,3) → fi=fj=0.3.
        let t_fringe = Lattice::regular(3.0, 3.0, 10.0, 10.0, 1, 1);
        let of = resample(&src, &src_lat, &t_fringe, ResampleMethod::Bilinear).unwrap();
        // corners: (0,0)=0 w=.49, (1,0)=10 w=.21, (0,1)=10 w=.21, (1,1)=NaN w=.09
        let expected = (0.0 * 0.49 + 10.0 * 0.21 + 10.0 * 0.21) / (0.49 + 0.21 + 0.21);
        assert!(
            of[[0, 0]].is_finite(),
            "finite corners must fill the fringe"
        );
        assert_relative_eq!(of[[0, 0]], expected, epsilon = 1e-12);
    }

    #[test]
    fn outside_extent_is_nan() {
        let src_lat = Lattice::regular(0.0, 0.0, 10.0, 10.0, 3, 3); // x,y span 0..20
        let src = sample_lattice(&src_lat, plane);
        // Target reaching well outside the source on both sides.
        let target = Lattice::regular(-50.0, 0.0, 60.0, 10.0, 3, 3);
        // node 0 at x=-50 (left of extent), node 2 at x=70 (right of extent).
        let out = resample(&src, &src_lat, &target, ResampleMethod::Bilinear).unwrap();
        assert!(out[[0, 0]].is_nan(), "left of extent → NaN");
        assert!(out[[2, 0]].is_nan(), "right of extent → NaN");
        // The middle node (x=10) is inside → finite.
        assert!(out[[1, 0]].is_finite(), "inside extent → finite");
    }

    #[test]
    fn offset_origin_honours_world_coords() {
        // Source georeferenced at a non-zero origin; a target offset half a cell.
        // The result must be the plane sampled at the target's WORLD position —
        // proving the georeference is honoured, not an index-for-index copy.
        let src_lat = Lattice::regular(1000.0, 2000.0, 10.0, 10.0, 5, 5);
        let src = sample_lattice(&src_lat, plane);
        let target = Lattice::regular(1005.0, 2005.0, 10.0, 10.0, 3, 3);
        let out = resample(&src, &src_lat, &target, ResampleMethod::Bilinear).unwrap();
        let (x, y) = target.node_xy(0, 0); // (1005, 2005)
        assert_relative_eq!(out[[0, 0]], plane(x, y), epsilon = 1e-9);
        // An index-space copy would have returned src[[0,0]] = plane(1000,2000).
        assert!((out[[0, 0]] - plane(1000.0, 2000.0)).abs() > 1e-6);
    }

    #[test]
    fn shape_mismatch_and_degenerate_error() {
        let src_lat = Lattice::regular(0.0, 0.0, 10.0, 10.0, 3, 3);
        let wrong = Array2::<f64>::zeros((2, 2));
        assert!(matches!(
            resample(&wrong, &src_lat, &src_lat, ResampleMethod::Nearest),
            Err(AlgoError::InvalidArgument(_))
        ));
        let degen = Lattice::regular(0.0, 0.0, 0.0, 10.0, 3, 3);
        let ok_shape = Array2::<f64>::zeros((3, 3));
        assert!(matches!(
            resample(&ok_shape, &degen, &src_lat, ResampleMethod::Nearest),
            Err(AlgoError::InvalidGeometry(_))
        ));
    }
}
