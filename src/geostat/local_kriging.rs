//! Moving-neighbourhood kriging: the same estimator as
//! [`OrdinaryKriging`](crate::OrdinaryKriging), but each node solves a small
//! dense system over only its nearby data instead of one global system over all
//! of them.
//!
//! ## Why local
//!
//! Global ordinary kriging factors one `(N+1)×(N+1)` matrix — fine for the
//! moderate scattered sets [`gridding`](crate::gridding) targets, but `O(N³)` to
//! factor and `O(N²)` per node, so it does not reach the tens of thousands of
//! conditioning points a well/log-derived model carries. With a moving
//! neighbourhood (the nearest `max_neighbours` within `radius`, via an R*-tree)
//! each node solves an `(n+1)×(n+1)` system with `n ≤ max_neighbours` — the far
//! data are screened by the near ones and safely dropped (Deutsch & Journel 1998,
//! *GSLIB* §II.4; Goovaerts 1997, §5.4). On a neighbourhood that contains **all**
//! the data this reproduces global OK exactly.
//!
//! ## Two kernels here
//!
//! - [`LocalKriging`] — moving-neighbourhood **ordinary** kriging (unknown local
//!   mean, unbiasedness constraint), returning estimate + OK variance, the
//!   gridding entry point.
//! - [`simple_kriging`] — the **simple**-kriging core (known mean, taken zero in
//!   normal-score space) with an optional **collocated-cokriging** secondary
//!   (Markov-1). This is the per-node engine [`sgs`](crate::geostat::sgs) draws
//!   from; kept here beside the OK solver.
//!
//! Derived from the ordinary/simple/collocated-cokriging systems in the cited
//! literature (Matheron 1963; Isaaks & Srivastava 1989 ch. 12; Goovaerts 1997
//! ch. 5–6; Xu et al. 1992; Almeida & Journel 1994). No third-party code was
//! consulted.

use crate::foundation::{AlgoError, Lattice, Result};
use crate::geostat::neighbourhood::Neighbourhood;
use crate::gridding::kriging::prep::{dedup_coincident, dist2d};
use crate::gridding::kriging::solve::{lu_factor_in_place, lu_solve_into};
use crate::gridding::kriging::Variogram;
use ndarray::Array2;

/// A moving-neighbourhood ordinary-kriging gridder: at most `max_neighbours`
/// data within `radius` enter each node's local solve.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LocalKriging {
    variogram: Variogram,
    max_neighbours: usize,
    radius: f64,
}

impl LocalKriging {
    /// Build a local-kriging gridder. Errors unless `max_neighbours ≥ 1` and
    /// `radius > 0` (finite).
    pub fn new(variogram: Variogram, max_neighbours: usize, radius: f64) -> Result<LocalKriging> {
        if max_neighbours == 0 || !radius.is_finite() || radius <= 0.0 {
            return Err(AlgoError::InvalidArgument(
                "LocalKriging: need max_neighbours >= 1 and radius > 0".to_string(),
            ));
        }
        Ok(LocalKriging {
            variogram,
            max_neighbours,
            radius,
        })
    }

    /// The variogram this gridder kriges with.
    pub fn variogram(&self) -> &Variogram {
        &self.variogram
    }

    /// Krige `coords` (`[x, y, z]` rows) onto `lattice`, returning the
    /// `(ncol × nrow)` estimate field **and** the matching ordinary-kriging
    /// variance field — each node estimated from its local neighbourhood.
    ///
    /// A node with no data inside `radius` is left `NaN` in both fields.
    /// Coincident data are averaged. Errors on empty input.
    pub fn krige(
        &self,
        coords: &[[f64; 3]],
        lattice: &Lattice,
    ) -> Result<(Array2<f64>, Array2<f64>)> {
        if coords.is_empty() {
            return Err(AlgoError::EmptyInput(
                "LocalKriging::krige: no points to grid",
            ));
        }
        let data = dedup_coincident(coords);
        let positions: Vec<[f64; 2]> = data.iter().map(|d| [d[0], d[1]]).collect();
        let nb = Neighbourhood::from_points(&positions);

        let mut est = Array2::from_elem((lattice.ncol, lattice.nrow), f64::NAN);
        let mut var = Array2::from_elem((lattice.ncol, lattice.nrow), f64::NAN);
        // One set of solver buffers threaded through every node's local solve —
        // no per-node matrix/rhs/solution allocation. The in-place LU twins run
        // the identical arithmetic (see `solve.rs`), so the fields are unchanged.
        let mut scratch = OkScratch::default();

        for jj in 0..lattice.nrow {
            for ii in 0..lattice.ncol {
                let (x, y) = lattice.node_xy(ii, jj);
                let near = nb.nearest([x, y], self.max_neighbours, self.radius);
                if near.is_empty() {
                    continue;
                }
                if let Some((z, s2)) = self.local_ok(&data, &near, &mut scratch) {
                    est[[ii, jj]] = z;
                    var[[ii, jj]] = s2.max(0.0);
                }
            }
        }
        Ok((est, var))
    }

    /// One local ordinary-kriging solve over `near` — `(index into `data`,
    /// distance to the target)` pairs, assembled and solved in the caller's
    /// retained [`OkScratch`] buffers. Returns `(estimate, variance)`, or `None`
    /// if the local system is singular. The target enters only through the
    /// precomputed neighbour distances, so it is not passed again here.
    fn local_ok(
        &self,
        data: &[[f64; 3]],
        near: &[(usize, f64)],
        scratch: &mut OkScratch,
    ) -> Option<(f64, f64)> {
        let n = near.len();
        let m = n + 1; // + Lagrange row/col
        scratch.mat.clear();
        scratch.mat.resize(m * m, 0.0);
        for (row, &(idi, _)) in near.iter().enumerate() {
            let pi = [data[idi][0], data[idi][1]];
            for (col, &(idj, _)) in near.iter().enumerate() {
                let pj = [data[idj][0], data[idj][1]];
                scratch.mat[row * m + col] = self.variogram.gamma(dist2d(pi, pj));
            }
            scratch.mat[row * m + n] = 1.0;
            scratch.mat[n * m + row] = 1.0;
        }
        scratch.mat[n * m + n] = 0.0;

        if !lu_factor_in_place(&mut scratch.mat, m, &mut scratch.perm) {
            return None; // singular local system
        }
        scratch.rhs.clear();
        scratch.rhs.resize(m, 0.0);
        for (row, &(_, di)) in near.iter().enumerate() {
            scratch.rhs[row] = self.variogram.gamma(di); // di already |xi − x0|
        }
        scratch.rhs[n] = 1.0;
        lu_solve_into(
            &scratch.mat,
            &scratch.perm,
            m,
            &scratch.rhs,
            &mut scratch.sol,
        );

        let mut z = 0.0;
        let mut sigma2 = scratch.sol[n]; // μ
        for (row, &(idi, _)) in near.iter().enumerate() {
            z += scratch.sol[row] * data[idi][2];
            sigma2 += scratch.sol[row] * scratch.rhs[row];
        }
        Some((z, sigma2))
    }
}

/// Reusable per-node solver scratch for [`LocalKriging`]: the ordinary-kriging
/// coefficient matrix, right-hand side, LU permutation, and solution vector —
/// one set of buffers reused across every node of a
/// [`krige`](LocalKriging::krige) pass so no local solve allocates. Empty is a
/// valid initial state (the buffers grow to the first system and are reused
/// thereafter). The moving-neighbourhood twin of the simulation path's
/// [`SkScratch`].
#[derive(Default)]
struct OkScratch {
    /// Row-major `m × m` OK matrix (becomes the packed LU).
    mat: Vec<f64>,
    /// The right-hand side `γ₀` (read after the solve for the kriging variance).
    rhs: Vec<f64>,
    /// LU partial-pivot permutation.
    perm: Vec<usize>,
    /// The solved weights `λ` (+ the Lagrange multiplier `μ`).
    sol: Vec<f64>,
}

/// One neighbour for a [`simple_kriging`] solve: its value and its distance to
/// the estimation target.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SkNeighbour {
    /// Position `[x, y]` (for the pairwise neighbour–neighbour covariances).
    pub pos: [f64; 2],
    /// The (normal-score) value at this neighbour.
    pub value: f64,
    /// Distance `|xᵢ − x₀|` to the estimation target.
    pub dist_to_target: f64,
}

/// **Simple kriging** of a zero-mean (normal-score) field at a target, with an
/// optional **collocated-cokriging** secondary datum (Markov-1). Returns the
/// kriging `(mean, variance)` in unit-variance (normal-score) space.
///
/// Works in the *correlogram* `ρ₁(h) = 1 − γ(h)/S` (with `S` the variogram's
/// total sill), so the a-priori variance is 1 and the returned variance is
/// `1 − Σᵢ λᵢ ρ₁(xᵢ,x₀)` — exactly the normal-score conditional variance an SGS
/// draw needs.
///
/// **Collocated cokriging** (`collocated = Some((y₂(x₀), ρ))`): the secondary
/// value `y₂` at the estimation location, standardised, folded in under the
/// Markov-1 screening `ρ₁₂(h) = ρ · ρ₁(h)`. The augmented system adds one
/// unknown `λ_s` for the collocated secondary; at `ρ = 0` the secondary row
/// decouples (`λ_s = 0`) and the result is **bit-identical** to plain simple
/// kriging, while `ρ → 1` pulls the estimate toward `y₂(x₀)` (Xu et al. 1992;
/// Almeida & Journel 1994; Goovaerts 1997 §6.2).
///
/// With no neighbours and no secondary the estimate is the mean (`0`) at the
/// a-priori variance (`1`).
/// Allocating convenience over [`simple_kriging_with`] (a fresh [`SkScratch`] per
/// call) — used by the unit tests; the production simulation path threads a
/// retained scratch instead.
#[cfg(test)]
pub(crate) fn simple_kriging(
    neighbours: &[SkNeighbour],
    variogram: &Variogram,
    collocated: Option<(f64, f64)>,
) -> (f64, f64) {
    let mut scratch = SkScratch::default();
    simple_kriging_with(neighbours, variogram, collocated, &mut scratch)
}

/// Reusable solver scratch for [`simple_kriging_with`]: the correlogram matrix,
/// the right-hand side, the LU permutation, and the solution vector — one set of
/// buffers threaded through an entire simulation sweep so no per-node solve
/// allocates. Empty is a valid initial state (the buffers grow to the first
/// system and are reused thereafter).
#[derive(Default)]
pub(crate) struct SkScratch {
    /// Row-major `dim × dim` correlogram matrix `K` (becomes the packed LU).
    mat: Vec<f64>,
    /// The right-hand side `k` (read after the solve for the kriging variance).
    rhs: Vec<f64>,
    /// LU partial-pivot permutation.
    perm: Vec<usize>,
    /// The solved weights `λ`.
    sol: Vec<f64>,
}

/// Simple kriging against caller-owned [`SkScratch`] — identical arithmetic, but
/// the correlogram system is assembled and solved in retained buffers instead of
/// freshly allocated ones. This is the per-node engine the sequential-Gaussian
/// session drives across every lattice node of every layer with **zero** solver
/// allocation. Bit-for-bit equal to the allocating `simple_kriging` for the same
/// inputs.
// The system-assembly and dot-product loops index `neighbours` alongside the
// packed matrix / rhs / solution by the same `i`, so an `enumerate` rewrite would
// not simplify them (mirrors the LU solver's identical allow).
#[allow(clippy::needless_range_loop)]
pub(crate) fn simple_kriging_with(
    neighbours: &[SkNeighbour],
    variogram: &Variogram,
    collocated: Option<(f64, f64)>,
    scratch: &mut SkScratch,
) -> (f64, f64) {
    let s = variogram.total_sill();
    // Correlogram from the variogram: ρ₁(h) = 1 − γ(h)/S ∈ [0, 1].
    let rho1 = |h: f64| -> f64 {
        if s <= 0.0 {
            0.0
        } else {
            1.0 - variogram.gamma(h) / s
        }
    };

    let n = neighbours.len();
    let has_sec = collocated.is_some();
    let rho = collocated.map(|(_, r)| r).unwrap_or(0.0);
    let sec = collocated.map(|(v, _)| v).unwrap_or(0.0);

    let dim = n + usize::from(has_sec);
    if dim == 0 {
        return (0.0, 1.0);
    }

    // Build the correlogram system  K λ = k  into the retained buffers. Every
    // entry of both is written below (the n×n primary block, the secondary
    // row/col and diagonal), so a clear+resize is a full re-initialisation.
    scratch.mat.clear();
    scratch.mat.resize(dim * dim, 0.0);
    scratch.rhs.clear();
    scratch.rhs.resize(dim, 0.0);
    for i in 0..n {
        for j in 0..n {
            scratch.mat[i * dim + j] = rho1(dist2d(neighbours[i].pos, neighbours[j].pos));
        }
        scratch.rhs[i] = rho1(neighbours[i].dist_to_target);
    }
    if has_sec {
        let s_idx = n; // secondary unknown is the last row/col
        for i in 0..n {
            // Markov-1 cross primary_i ↔ collocated secondary at x₀:
            // ρ₁₂(|xᵢ − x₀|) = ρ · ρ₁(|xᵢ − x₀|).
            let cross = rho * rho1(neighbours[i].dist_to_target);
            scratch.mat[i * dim + s_idx] = cross;
            scratch.mat[s_idx * dim + i] = cross;
        }
        scratch.mat[s_idx * dim + s_idx] = 1.0; // secondary–secondary at zero lag
        scratch.rhs[s_idx] = rho; // secondary(x₀) ↔ primary target: ρ · ρ₁(0) = ρ
    }

    if !lu_factor_in_place(&mut scratch.mat, dim, &mut scratch.perm) {
        // Degenerate (e.g. coincident neighbours slipped through): fall back to
        // the a-priori mean/variance rather than panic.
        return (0.0, 1.0);
    }
    lu_solve_into(
        &scratch.mat,
        &scratch.perm,
        dim,
        &scratch.rhs,
        &mut scratch.sol,
    );

    let mut mean = 0.0;
    let mut var = 1.0;
    for i in 0..n {
        mean += scratch.sol[i] * neighbours[i].value;
        var -= scratch.sol[i] * scratch.rhs[i];
    }
    if has_sec {
        mean += scratch.sol[n] * sec;
        var -= scratch.sol[n] * scratch.rhs[n];
    }
    (mean, var.max(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gridding::kriging::VariogramModel;
    use crate::OrdinaryKriging;
    use approx::assert_relative_eq;

    fn spherical(nugget: f64, sill: f64, range: f64) -> Variogram {
        Variogram::new(VariogramModel::Spherical, nugget, sill, range).unwrap()
    }

    #[test]
    fn new_validates() {
        assert!(LocalKriging::new(spherical(0.0, 1.0, 10.0), 0, 5.0).is_err());
        assert!(LocalKriging::new(spherical(0.0, 1.0, 10.0), 8, 0.0).is_err());
        assert!(LocalKriging::new(spherical(0.0, 1.0, 10.0), 8, 5.0).is_ok());
    }

    #[test]
    fn reproduces_global_ok_when_neighbourhood_covers_all_data() {
        // Large radius + max_neighbours >= n ⇒ every node sees all data ⇒ the
        // local OK estimate must match global OrdinaryKriging to tolerance.
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 8, 8);
        let coords = [
            [0.0, 0.0, 10.0],
            [7.0, 0.0, 22.0],
            [0.0, 7.0, 7.0],
            [7.0, 7.0, 40.0],
            [3.0, 4.0, 18.0],
        ];
        let vg = spherical(0.0, 1.0, 20.0);
        let global = OrdinaryKriging::new(vg).krige(&coords, &lattice).unwrap();
        let local = LocalKriging::new(vg, 10, 1000.0)
            .unwrap()
            .krige(&coords, &lattice)
            .unwrap();
        for ((ge, gv), (le, lv)) in global
            .0
            .iter()
            .zip(global.1.iter())
            .zip(local.0.iter().zip(local.1.iter()))
        {
            assert_relative_eq!(ge, le, epsilon = 1e-7);
            assert_relative_eq!(gv, lv, epsilon = 1e-7);
        }
    }

    #[test]
    fn exact_at_data_nodes() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 6, 6);
        let coords = [[0.0, 0.0, 10.0], [5.0, 5.0, 40.0], [2.0, 3.0, 18.0]];
        let lk = LocalKriging::new(spherical(0.0, 1.0, 10.0), 8, 100.0).unwrap();
        let (est, var) = lk.krige(&coords, &lattice).unwrap();
        for c in &coords {
            let (fi, fj) = lattice.xy_to_ij(c[0], c[1]).unwrap();
            let (i, j) = (fi.round() as usize, fj.round() as usize);
            assert_relative_eq!(est[[i, j]], c[2], epsilon = 1e-6);
            assert!(var[[i, j]].abs() < 1e-6);
        }
    }

    #[test]
    fn node_beyond_radius_is_nan() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 20, 20);
        let coords = [[0.0, 0.0, 5.0]];
        let lk = LocalKriging::new(spherical(0.0, 1.0, 3.0), 4, 2.0).unwrap();
        let (est, _) = lk.krige(&coords, &lattice).unwrap();
        assert!(est[[19, 19]].is_nan(), "far corner should be undefined");
        assert_relative_eq!(est[[0, 0]], 5.0, epsilon = 1e-9);
    }

    // ---- simple_kriging / collocated cokriging core ----

    fn neigh(pos: [f64; 2], value: f64, target: [f64; 2]) -> SkNeighbour {
        SkNeighbour {
            pos,
            value,
            dist_to_target: dist2d(pos, target),
        }
    }

    #[test]
    fn sk_no_neighbours_is_prior() {
        let (m, v) = simple_kriging(&[], &spherical(0.0, 1.0, 10.0), None);
        assert_eq!((m, v), (0.0, 1.0));
    }

    #[test]
    fn sk_exact_on_a_datum() {
        // A single neighbour coincident with the target ⇒ estimate = its value,
        // variance 0 (ρ₁(0) = 1).
        let vg = spherical(0.0, 1.0, 10.0);
        let ns = [neigh([0.0, 0.0], 2.5, [0.0, 0.0])];
        let (m, v) = simple_kriging(&ns, &vg, None);
        assert_relative_eq!(m, 2.5, epsilon = 1e-9);
        assert!(v.abs() < 1e-9);
    }

    #[test]
    fn collocated_rho_zero_bit_matches_plain_sk() {
        let vg = spherical(0.2, 1.0, 15.0);
        let target = [1.0, 1.0];
        let ns = [
            neigh([0.0, 0.0], 1.0, target),
            neigh([2.0, 0.0], -0.5, target),
            neigh([0.0, 2.0], 0.3, target),
        ];
        let plain = simple_kriging(&ns, &vg, None);
        let co_zero = simple_kriging(&ns, &vg, Some((99.0, 0.0))); // huge secondary, ρ=0
        assert_eq!(plain, co_zero, "ρ=0 must exactly reduce to plain SK");
    }

    #[test]
    fn collocated_high_rho_pulls_toward_secondary() {
        let vg = spherical(0.0, 1.0, 15.0);
        let target = [5.0, 5.0];
        // One primary neighbour some distance away carrying 0.0; a secondary of
        // +2.0 at the target. As ρ rises, the estimate should move toward +2.
        let ns = [neigh([0.0, 0.0], 0.0, target)];
        let low = simple_kriging(&ns, &vg, Some((2.0, 0.1))).0;
        let high = simple_kriging(&ns, &vg, Some((2.0, 0.95))).0;
        assert!(high > low, "higher ρ should pull toward the secondary");
        assert!(
            high > 1.0,
            "ρ→1 should pull most of the way to +2 (got {high})"
        );
    }

    /// Scale check the global solver cannot reach: ~40k conditioning points onto
    /// a 120×120 grid. Ignored by default (release-only, prints timing) — run with
    /// `cargo test --release -- --ignored --nocapture local_kriging_40k`.
    #[test]
    #[ignore]
    fn local_kriging_40k_scale() {
        use std::time::Instant;
        // 40 000 pseudo-random conditioning points over a 1200×1200 area.
        let mut coords = Vec::with_capacity(40_000);
        let mut s: u64 = 0x1234_5678;
        let mut next = || {
            // xorshift64 for a dependency-free reproducible spread.
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            (s >> 11) as f64 / (1u64 << 53) as f64
        };
        for _ in 0..40_000 {
            let x = next() * 1200.0;
            let y = next() * 1200.0;
            let z = next() * 100.0;
            coords.push([x, y, z]);
        }
        let lattice = Lattice::regular(0.0, 0.0, 10.0, 10.0, 120, 120);
        let lk = LocalKriging::new(spherical(0.1, 1.0, 150.0), 24, 200.0).unwrap();

        let t0 = Instant::now();
        let (est, _var) = lk.krige(&coords, &lattice).unwrap();
        let dt = t0.elapsed();
        let defined = est.iter().filter(|v| v.is_finite()).count();
        eprintln!(
            "local_kriging 40k pts -> 120x120 grid ({} nodes, {defined} defined): {:.3?}",
            120 * 120,
            dt
        );
        assert_eq!(est.dim(), (120, 120));
        // Enforce the scalability contract, don't just measure it: a generous 2 s
        // budget (≈5× headroom over the measured ~0.4 s release run). Only
        // meaningful in an optimized build — this test is meant to run under
        // `--release`; skip the assertion for a debug `--ignored` run.
        #[cfg(not(debug_assertions))]
        assert!(
            dt.as_secs_f64() < 2.0,
            "local kriging 40k scale budget exceeded: {dt:.3?} (> 2 s)"
        );
    }
}
