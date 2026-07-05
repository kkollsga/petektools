//! `MinCurvatureOperator` — the minimum-curvature conditioning system assembled
//! as a sparse banded matrix and **factored once**, so many horizons that share the
//! same sample `(x, y)` geometry each solve by a cheap back-substitution.
//!
//! The iterative kernel ([`super::min_curvature`]) relaxes the fused system
//! `(tensioned biharmonic) z = 0` + `(bilinear data-fit normal equations)` by
//! SOR. On a conditioning-bound problem (tens of thousands of off-node samples on
//! a ~120² lattice) that SOR is **cap-bound** — it exhausts its sweep budget
//! without reaching tolerance. This module solves the **same linear system**
//! directly instead: assemble it as a sparse, banded matrix and factor it with an
//! in-crate band LU ([`super::band_lu`]).
//!
//! ## Why the assembled matrix is banded (and near-, not exactly, symmetric)
//!
//! Each free node's SOR update is the Gauss–Seidel step for one row of a linear
//! system `M z = b`; the SOR fixed point *is* the solution of `M z = b`. `M` is:
//!
//! - the **tensioned 13-point biharmonic** stencil (Briggs 1974; Smith & Wessel
//!   1990) — symmetric in the interior, plus
//! - the **bilinear data-fit normal equations** `DATA_WEIGHT · Σ_s wₖ wₘ` — a sum
//!   of rank-1 outer products, symmetric positive-semidefinite.
//!
//! The **natural-dip boundary** (the linear extrapolation `z[t] = 2 z[t+1] −
//! z[t+2]` of [`super::min_curvature`]'s `z_at`, resolved *i-before-j*) folds each
//! out-of-lattice stencil node back onto in-range nodes. Along a single edge this
//! fold stays symmetric, but at the **corners** the i-then-j resolution order
//! makes the boundary rows slightly **non-symmetric** — so to reproduce the SOR
//! fixed point *exactly* the direct solver is a band **LU** (not a Cholesky).
//! `M`'s symmetric part is still positive-definite (the biharmonic energy Hessian
//! together with the PSD data block), so unpivoted band LU is stable; a
//! collapsing pivot (an under-constrained surface whose plane null space is not
//! pinned) is reported so the caller falls back to the iterative kernel.
//!
//! Under a lattice-lexicographic node ordering along the **shorter** axis the
//! stencil couples only nodes within `±2` per axis, so `M` is **banded** with
//! half-bandwidth `≈ 2·min(ncol, nrow)`, and unpivoted LU preserves that band
//! with no fill.
//!
//! ## Factor once, solve many
//!
//! The matrix `M` depends only on `(lattice, sample (x,y) geometry,
//! conditioning)` — **not** on the z-values. Only the right-hand side `b` depends
//! on z. So a caller gridding many horizons over one fixed sample footprint (the
//! Monte-Carlo regeneration of one surface, where only the depths are redrawn)
//! [`factor`](MinCurvatureOperator::factor)s once and
//! [`solve`](MinCurvatureOperator::solve)s per horizon. A per-horizon geometry
//! (distinct surfaces) just factors per call — sub-second at ~14k nodes.
//!
//! References (independent derivation; standard academic attribution): Briggs
//! (1974) *Machine contouring using minimum curvature*, Geophysics 39(1); Smith &
//! Wessel (1990) *Gridding with continuous curvature splines in tension*,
//! Geophysics 55(3). The direct-factorization machinery is cited on
//! [`super::band_lu`].

use crate::foundation::{AlgoError, Lattice, Result};
use ndarray::Array2;
use std::collections::HashMap;

use super::band_lu::BandLu;
use super::min_curvature::{classify_sample, SampleKind, DATA_WEIGHT, TENSION};
use super::Conditioning;

/// The tensioned 13-point biharmonic stencil as `(di, dj, coefficient)` rows of
/// the operator matrix `M` (i.e. the negated SOR relaxation weights; the centre
/// carries the diagonal `denom`). Solving `(1−T)∇⁴z − T∇²z = 0`:
/// centre `20(1−T)+4T`, orthogonal `−(8(1−T)+T)`, diagonal `+2(1−T)`, two-away
/// `+(1−T)` — row-sum zero, so a plane is an exact null vector.
fn stencil() -> [(isize, isize, f64); 13] {
    let t = TENSION;
    let denom = 20.0 * (1.0 - t) + 4.0 * t;
    let orth = -(8.0 * (1.0 - t) + t);
    let diag = 2.0 * (1.0 - t);
    let two = 1.0 - t;
    [
        (0, 0, denom),
        (0, 1, orth),
        (0, -1, orth),
        (1, 0, orth),
        (-1, 0, orth),
        (1, 1, diag),
        (-1, 1, diag),
        (1, -1, diag),
        (-1, -1, diag),
        (0, 2, two),
        (0, -2, two),
        (2, 0, two),
        (-2, 0, two),
    ]
}

/// Distribute `coeff` applied to the (possibly out-of-lattice) stencil node
/// `(i, j)` onto in-range nodes, mirroring the linear boundary extrapolation of
/// [`super::min_curvature`]'s `z_at` **branch-for-branch** (i&lt;0, then i≥nc,
/// then j&lt;0, then j≥nr) so the assembled operator reproduces the SOR fixed
/// point coefficient-for-coefficient. Bounded recursion: each step moves the
/// index strictly inward.
fn accumulate<F: FnMut(usize, usize, f64)>(
    nc: isize,
    nr: isize,
    i: isize,
    j: isize,
    coeff: f64,
    out: &mut F,
) {
    if i < 0 {
        accumulate(nc, nr, i + 1, j, 2.0 * coeff, out);
        accumulate(nc, nr, i + 2, j, -coeff, out);
    } else if i >= nc {
        accumulate(nc, nr, i - 1, j, 2.0 * coeff, out);
        accumulate(nc, nr, i - 2, j, -coeff, out);
    } else if j < 0 {
        accumulate(nc, nr, i, j + 1, 2.0 * coeff, out);
        accumulate(nc, nr, i, j + 2, -coeff, out);
    } else if j >= nr {
        accumulate(nc, nr, i, j - 1, 2.0 * coeff, out);
        accumulate(nc, nr, i, j - 2, -coeff, out);
    } else {
        out(i as usize, j as usize, coeff);
    }
}

/// An off-node bilinear data constraint, retained by geometry (its four
/// surrounding nodes + weights) and pointing at its z-datum by `sample` index.
struct OffSample {
    sample: u32,
    nodes: [(usize, usize); 4],
    w: [f64; 4],
}

/// The z-independent geometric structure of the conditioning problem: which nodes
/// are hard anchors, which are free unknowns (and their band-minimizing ordering),
/// and the off-node bilinear constraints. Everything the matrix `M` is built from.
struct Geometry {
    nc: usize,
    /// `anchor_of[i + j*nc]` = anchor id for node `(i, j)`, else `-1`.
    anchor_of: Vec<i32>,
    anchor_node: Vec<(usize, usize)>,
    /// Anchor id → the sample indices snapped there (their z's average).
    anchor_samples: Vec<Vec<u32>>,
    off: Vec<OffSample>,
    /// `free_of[i + j*nc]` = free-system row for node `(i, j)`, else `-1`.
    free_of: Vec<i32>,
    free_node: Vec<(usize, usize)>,
}

/// Classify the samples (shared predicates with the SOR kernel) into anchors +
/// off-node constraints, then order the free nodes with the fast index along the
/// **shorter** axis so the biharmonic band is minimal (`2·min(nc,nr)+2`).
fn classify_geometry(
    lattice: &Lattice,
    sample_xy: &[[f64; 2]],
    conditioning: Conditioning,
) -> Geometry {
    let (nc, nr) = (lattice.ncol, lattice.nrow);
    let n_nodes = nc * nr;

    let mut anchor_of = vec![-1i32; n_nodes];
    let mut anchor_node: Vec<(usize, usize)> = Vec::new();
    let mut anchor_samples: Vec<Vec<u32>> = Vec::new();
    let mut off: Vec<OffSample> = Vec::new();
    for (s, xy) in sample_xy.iter().enumerate() {
        match classify_sample(lattice, xy[0], xy[1], conditioning) {
            SampleKind::OnNode(i, j) => {
                let f = i + j * nc;
                let a = if anchor_of[f] < 0 {
                    anchor_of[f] = anchor_node.len() as i32;
                    anchor_node.push((i, j));
                    anchor_samples.push(Vec::new());
                    anchor_node.len() - 1
                } else {
                    anchor_of[f] as usize
                };
                anchor_samples[a].push(s as u32);
            }
            SampleKind::Off { nodes, w } => off.push(OffSample {
                sample: s as u32,
                nodes,
                w,
            }),
            SampleKind::Skip => {}
        }
    }

    let mut free_of = vec![-1i32; n_nodes];
    let mut free_node: Vec<(usize, usize)> = Vec::new();
    let push = |i: usize, j: usize, free_of: &mut [i32], fnv: &mut Vec<(usize, usize)>| {
        let f = i + j * nc;
        if anchor_of[f] < 0 {
            free_of[f] = fnv.len() as i32;
            fnv.push((i, j));
        }
    };
    if nc <= nr {
        for j in 0..nr {
            for i in 0..nc {
                push(i, j, &mut free_of, &mut free_node);
            }
        }
    } else {
        for i in 0..nc {
            for j in 0..nr {
                push(i, j, &mut free_of, &mut free_node);
            }
        }
    }

    Geometry {
        nc,
        anchor_of,
        anchor_node,
        anchor_samples,
        off,
        free_of,
        free_node,
    }
}

/// Assemble the full free×free operator (keyed by `(row, col)`, both triangles)
/// and the per-free-row RHS-term lists, from a [`Geometry`]. Each free row is one
/// equation of `M z = b`.
#[allow(clippy::type_complexity)]
fn assemble(
    geom: &Geometry,
    nc: isize,
    nr: isize,
) -> (
    HashMap<(u32, u32), f64>,
    Vec<Vec<(u32, f64)>>,
    Vec<Vec<(u32, f64)>>,
) {
    let n_free = geom.free_node.len();
    let mut full: HashMap<(u32, u32), f64> = HashMap::new();
    let mut rhs_anchor: Vec<Vec<(u32, f64)>> = vec![Vec::new(); n_free];
    let mut rhs_data: Vec<Vec<(u32, f64)>> = vec![Vec::new(); n_free];
    let ncu = geom.nc;
    let stencil = stencil();

    // Biharmonic rows.
    for (r, &(i, j)) in geom.free_node.iter().enumerate() {
        let r = r as u32;
        for &(di, dj, coeff) in &stencil {
            accumulate(
                nc,
                nr,
                i as isize + di,
                j as isize + dj,
                coeff,
                &mut |ni, nj, c| {
                    let f = ni + nj * ncu;
                    let a = geom.anchor_of[f];
                    if a >= 0 {
                        rhs_anchor[r as usize].push((a as u32, c));
                    } else {
                        let q = geom.free_of[f] as u32;
                        *full.entry((r, q)).or_insert(0.0) += c;
                    }
                },
            );
        }
    }
    // Data-fit normal equations: for each off-sample, each free node k gets the
    // row contributions DW·wₖ·wₘ (m over all four nodes) and the RHS term DW·wₖ·d.
    for s in &geom.off {
        for k in 0..4 {
            if s.w[k] == 0.0 {
                continue;
            }
            let (ik, jk) = s.nodes[k];
            let fk = ik + jk * ncu;
            if geom.anchor_of[fk] >= 0 {
                continue; // node k is a hard anchor — not a free equation
            }
            let rk = geom.free_of[fk] as usize;
            rhs_data[rk].push((s.sample, DATA_WEIGHT * s.w[k]));
            for m in 0..4 {
                if s.w[m] == 0.0 {
                    continue;
                }
                let (im, jm) = s.nodes[m];
                let fm = im + jm * ncu;
                let coeff = DATA_WEIGHT * s.w[k] * s.w[m];
                if geom.anchor_of[fm] >= 0 {
                    rhs_anchor[rk].push((geom.anchor_of[fm] as u32, coeff));
                } else {
                    let rm = geom.free_of[fm] as u32;
                    *full.entry((rk as u32, rm)).or_insert(0.0) += coeff;
                }
            }
        }
    }
    (full, rhs_anchor, rhs_data)
}

/// Minimum count of independent controls (hard anchors + off-node bilinear
/// constraints) for the Tikhonov-stabilized retry to engage. The natural-dip
/// biharmonic's null family {1, x, y, xy} has dimension 4, so fewer controls
/// genuinely cannot define a surface — that stays a reported singularity so the
/// caller falls back to the iterative kernel.
const MIN_CONTROLS: usize = 4;

/// Tikhonov ridge, as a fraction of the largest assembled diagonal, added **only**
/// on the stabilized retry for an anchorless boundary-null system. Chosen far above
/// the residual near-null pivot (~1e-12 relative) so the band LU is well-conditioned,
/// and far below every data-reached node's stiffness so the honoured interior is
/// unperturbed (~1e-8 relative).
const RIDGE_REL: f64 = 1.0e-8;

/// Assemble the banded operator from the `(row, col) → value` map and factor it,
/// optionally adding a uniform Tikhonov `ridge` to the diagonal first. Returns the
/// factorization, or `None` if a pivot collapses (the system is singular at this
/// ridge level). `ridge == 0.0` reproduces the exact (historical) system.
fn build_and_factor(
    full: &HashMap<(u32, u32), f64>,
    n_free: usize,
    bw: usize,
    ridge: f64,
) -> Option<BandLu> {
    let mut lu = BandLu::zeros(n_free, bw);
    for (&(r, c), &v) in full {
        lu.add(r as usize, c as usize, v);
    }
    if ridge != 0.0 {
        for d in 0..n_free {
            lu.add(d, d, ridge);
        }
    }
    lu.factor().then_some(lu)
}

/// A factored minimum-curvature conditioning operator: the sparse banded system
/// (tensioned biharmonic + bilinear data-fit normal equations) for a fixed
/// `(lattice, sample (x,y) geometry, conditioning)`, band-LU-factored once.
///
/// [`solve`](Self::solve) it for each horizon's z-values (its RHS) by
/// back-substitution — `O(n · bandwidth)`, far below the assemble-and-factor
/// cost. Callers gridding many horizons that share one sample footprint reuse a
/// single factorization.
pub struct MinCurvatureOperator {
    lattice: Lattice,
    nc: usize,
    nr: usize,
    n_samples: usize,
    /// The factored free-node system, or `None` when every node is a hard anchor.
    lu: Option<BandLu>,
    n_free: usize,
    /// Free-system row → node `(i, j)`.
    free_node: Vec<(usize, usize)>,
    /// Anchor id → node `(i, j)`.
    anchor_node: Vec<(usize, usize)>,
    /// Anchor id → the sample indices snapped there (their z's average).
    anchor_samples: Vec<Vec<u32>>,
    /// Per free row: `(anchor id, coeff)` — `b[r] -= coeff · anchorval`.
    rhs_anchor: Vec<Vec<(u32, f64)>>,
    /// Per free row: `(sample id, coeff)` — `b[r] += coeff · z[sample]`.
    rhs_data: Vec<Vec<(u32, f64)>>,
    /// Reused solution buffer for the back-substitution.
    solve_scratch: std::cell::RefCell<Vec<f64>>,
}

impl MinCurvatureOperator {
    /// Assemble and factor the conditioning operator for `lattice` and the areal
    /// sample positions `sample_xy` (each `[x, y]`, in the order z-values will be
    /// supplied to [`solve`](Self::solve)). `conditioning` selects on-node snap vs
    /// off-node bilinear honouring, exactly as
    /// [`grid_min_curvature_conditioned`](super::grid_min_curvature_conditioned).
    ///
    /// The exact system is factored first; when it is singular from an
    /// **anchorless** cloud whose bilinear data-fit leaves a residual
    /// boundary-supported null mode (real seismic — no on-node sample; see the
    /// `RIDGE_REL` note), a minimal Tikhonov ridge pins that mode and the factor
    /// retries. A caller therefore no longer needs a fallback for the anchorless
    /// case — only for the genuinely under-constrained one.
    ///
    /// Errors with [`AlgoError::InvalidGeometry`] on a degenerate lattice
    /// (`ncol < 2 || nrow < 2`), and [`AlgoError::InvalidArgument`] when the
    /// assembled system is **genuinely under-constrained** — fewer than the
    /// biharmonic null-family dimension of independent controls (e.g. a lone
    /// anchor), too few to define a surface even with the ridge. A caller can then
    /// fall back to the iterative kernel (which the one-shot entries do
    /// automatically).
    pub fn factor(
        lattice: &Lattice,
        sample_xy: &[[f64; 2]],
        conditioning: Conditioning,
    ) -> Result<Self> {
        let (nc, nr) = (lattice.ncol, lattice.nrow);
        if nc < 2 || nr < 2 {
            return Err(AlgoError::InvalidGeometry(
                "MinCurvatureOperator::factor: lattice must be at least 2x2",
            ));
        }
        let geom = classify_geometry(lattice, sample_xy, conditioning);
        let n_free = geom.free_node.len();

        // If every node is anchored there is nothing to solve; the field is the
        // anchor values (e.g. a control on every node).
        if n_free == 0 {
            return Ok(MinCurvatureOperator {
                lattice: lattice.clone(),
                nc,
                nr,
                n_samples: sample_xy.len(),
                lu: None,
                n_free: 0,
                free_node: geom.free_node,
                anchor_node: geom.anchor_node,
                anchor_samples: geom.anchor_samples,
                rhs_anchor: Vec::new(),
                rhs_data: Vec::new(),
                solve_scratch: std::cell::RefCell::new(Vec::new()),
            });
        }

        let (full, rhs_anchor, rhs_data) = assemble(&geom, nc as isize, nr as isize);

        // Half-bandwidth from the assembled sparsity, then band LU (the operator
        // is near-symmetric but not exactly so at the boundary folds).
        let mut bw = 0usize;
        for &(r, c) in full.keys() {
            bw = bw.max((r as isize - c as isize).unsigned_abs());
        }

        // Attempt the EXACT system first (no ridge) — bit-identical to the
        // historical path for every well-posed (anchored / data-rich) case.
        let lu = build_and_factor(&full, n_free, bw, 0.0).or_else(|| {
            // The **anchorless boundary-null** case (real seismic clouds: tens of
            // thousands of samples, none on a node). The tensioned natural-dip
            // biharmonic annihilates the low-order family {1, x, y, xy}; the
            // bilinear data-fit pins those modes only where samples reach, so a
            // cloud that clears the frame margin leaves a single boundary-supported
            // mode essentially unpinned and the exact operator is near-singular
            // (one ~1e-12-relative, sign-indefinite pivot; NOT unpivoted-growth —
            // full partial pivoting sees the same tiny pivot). The system is still
            // well-posed to solve (the iterative kernel converges to it); the direct
            // factorization just needs that residual null mode pinned.
            //
            // Pin it with a MINIMAL Tikhonov ridge (`RIDGE_REL` of the largest
            // assembled diagonal): far above the near-null pivot so the band LU is
            // well-conditioned, yet negligible (~1e-8 relative) on every
            // data-reached node, so the honoured interior — where the volumes live —
            // is unchanged. The ridge biases only the otherwise-unconstrained mode
            // toward its minimum-norm (smoothest) extension in the data-void margin.
            //
            // Guard: require at least the biharmonic null-family dimension of
            // independent controls (anchors + off-node constraints). Fewer is
            // GENUINELY under-constrained (a lone anchor cannot define a surface) —
            // report singular so the caller keeps the documented iterative fallback.
            let n_controls = geom.anchor_node.len() + geom.off.len();
            if n_controls < MIN_CONTROLS {
                return None;
            }
            let scale = full
                .iter()
                .filter(|(&(r, c), _)| r == c)
                .map(|(_, &v)| v.abs())
                .fold(0.0_f64, f64::max);
            build_and_factor(&full, n_free, bw, RIDGE_REL * scale)
        });
        let Some(lu) = lu else {
            return Err(AlgoError::InvalidArgument(
                "MinCurvatureOperator: conditioning system is singular \
                 (too few / collinear hard anchors to pin the surface)"
                    .to_string(),
            ));
        };

        Ok(MinCurvatureOperator {
            lattice: lattice.clone(),
            nc,
            nr,
            n_samples: sample_xy.len(),
            lu: Some(lu),
            n_free,
            free_node: geom.free_node,
            anchor_node: geom.anchor_node,
            anchor_samples: geom.anchor_samples,
            rhs_anchor,
            rhs_data,
            solve_scratch: std::cell::RefCell::new(Vec::new()),
        })
    }

    /// The lattice this operator grids onto.
    pub fn lattice(&self) -> &Lattice {
        &self.lattice
    }

    /// The number of samples the operator was factored with — the required length
    /// of the `z` slice passed to [`solve`](Self::solve).
    pub fn sample_count(&self) -> usize {
        self.n_samples
    }

    /// Solve for one horizon: `z[k]` is the datum at the sample given at
    /// `sample_xy[k]` to [`factor`](Self::factor). Returns the `(ncol × nrow)`
    /// node field. `O(n · bandwidth)` back-substitution — the per-horizon cost.
    ///
    /// Errors with [`AlgoError::InvalidArgument`] if `z.len()` differs from
    /// [`sample_count`](Self::sample_count).
    pub fn solve(&self, z: &[f64]) -> Result<Array2<f64>> {
        if z.len() != self.n_samples {
            return Err(AlgoError::InvalidArgument(format!(
                "MinCurvatureOperator::solve: expected {} z-values, got {}",
                self.n_samples,
                z.len()
            )));
        }
        // Hard-anchor values: the mean of the z's snapped to each anchor node.
        let anchorval: Vec<f64> = self
            .anchor_samples
            .iter()
            .map(|ss| ss.iter().map(|&s| z[s as usize]).sum::<f64>() / ss.len() as f64)
            .collect();

        let mut field = Array2::from_elem((self.nc, self.nr), f64::NAN);
        for (a, &(i, j)) in self.anchor_node.iter().enumerate() {
            field[[i, j]] = anchorval[a];
        }

        if let Some(lu) = &self.lu {
            let mut b = vec![0.0f64; self.n_free];
            for (r, slot) in b.iter_mut().enumerate() {
                let mut acc = 0.0;
                for &(sid, coeff) in &self.rhs_data[r] {
                    acc += coeff * z[sid as usize];
                }
                for &(aid, coeff) in &self.rhs_anchor[r] {
                    acc -= coeff * anchorval[aid as usize];
                }
                *slot = acc;
            }
            let mut out = self.solve_scratch.borrow_mut();
            lu.solve_into(&b, &mut out);
            for (r, &(i, j)) in self.free_node.iter().enumerate() {
                field[[i, j]] = out[r];
            }
        }
        Ok(field)
    }

    /// Number of hard-anchor nodes. Test-only introspection.
    #[cfg(test)]
    pub(crate) fn anchor_count(&self) -> usize {
        self.anchor_node.len()
    }

    /// The free-node count (the direct system dimension). Test-only introspection.
    #[cfg(test)]
    pub(crate) fn free_count(&self) -> usize {
        self.n_free
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The direct solve reproduces the converged iterative (SOR) field to the
    /// solver tolerance on a genuinely **non-planar** scatter (curvature exercises
    /// the full biharmonic operator, boundary folds included) — the accuracy
    /// contract: same system, actually attained. Small enough that the SOR fully
    /// converges within its cap.
    #[test]
    fn direct_matches_converged_sor_nonplanar() {
        use super::super::min_curvature::grid_min_curvature_sor;
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 11, 9);
        // A curved analytic surface sampled on-node at scattered nodes.
        let mut coords = Vec::new();
        for &(i, j) in &[
            (0usize, 0usize),
            (10, 0),
            (0, 8),
            (10, 8),
            (5, 4),
            (2, 6),
            (8, 2),
            (3, 3),
            (7, 6),
        ] {
            let (x, y) = (i as f64, j as f64);
            let z = 100.0 + 3.0 * (x * 0.4).sin() - 2.0 * (y * 0.3).cos() + 0.05 * x * y;
            coords.push([x, y, z]);
        }
        let sor = grid_min_curvature_sor(&coords, &lattice, None, Conditioning::NearestNode);
        let sample_xy: Vec<[f64; 2]> = coords.iter().map(|c| [c[0], c[1]]).collect();
        let z: Vec<f64> = coords.iter().map(|c| c[2]).collect();
        let op =
            MinCurvatureOperator::factor(&lattice, &sample_xy, Conditioning::NearestNode).unwrap();
        let direct = op.solve(&z).unwrap();
        let mut maxd = 0.0f64;
        for (a, b) in direct.iter().zip(sor.iter()) {
            maxd = maxd.max((a - b).abs());
        }
        // The SOR only stops at max *per-sweep* nodal change < 1e-6, so its field
        // still trails the true fixed point by a slow-mode tail (~1e-4 here); the
        // direct solve lands ON that fixed point. Agreement to ~1e-4 on a ~100-ft
        // field (6 orders down) is the accuracy contract — the direct path is the
        // more accurate of the two.
        assert!(maxd < 1e-3, "direct vs converged SOR max diff = {maxd}");
    }

    /// **Anchorless bilinear regression** (`task_suite_scatter_perf`). An
    /// irregular world-georef cloud where NO sample lands on a frame node — the
    /// real-seismic shape (doctrine R1, fictional-UTM origin, offset extent) that
    /// used to send `factor(.., Bilinear)` singular (all-NaN field, the stack build
    /// read as "nothing landed"). With the residual boundary-null mode pinned, the
    /// direct operator must now factor, produce an all-finite field, and honour the
    /// off-node data (the interpolated surface passes through each datum to the
    /// least-squares floor).
    #[test]
    fn anchorless_bilinear_cloud_factors_and_solves() {
        // Fictional ED50/UTM31N-magnitude origin, non-round offset extent.
        let (xori, yori, cell, nc, nr) = (431_000.0, 6_521_000.0, 100.0, 41usize, 37usize);
        let lattice = Lattice::regular(xori, yori, cell, cell, nc, nr);
        let span_x = cell * (nc - 1) as f64;
        let span_y = cell * (nr - 1) as f64;
        // Deterministic LCG jitter — every sample strictly between nodes, and the
        // cloud clears the frame margin (data in the central ~60%), so there is no
        // on-node anchor and the natural-dip boundary modes are data-void.
        let mut s: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = || {
            s = s
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((s >> 33) as f64) / (u32::MAX as f64)
        };
        let mut sample_xy: Vec<[f64; 2]> = Vec::new();
        let mut z: Vec<f64> = Vec::new();
        for _ in 0..1500 {
            let fx = next();
            let fy = next();
            let x = xori + (0.2 + 0.6 * fx) * span_x + 0.37;
            let y = yori + (0.2 + 0.6 * fy) * span_y + 0.29;
            sample_xy.push([x, y]);
            z.push(2000.0 + 30.0 * fx + 20.0 * fy); // gentle dip
        }
        // Every sample is off-node (no anchors) — the regression precondition.
        assert_eq!(
            sample_xy
                .iter()
                .filter(|xy| matches!(
                    classify_sample(&lattice, xy[0], xy[1], Conditioning::Bilinear),
                    SampleKind::OnNode(..)
                ))
                .count(),
            0,
            "fixture must be anchorless"
        );

        let op = MinCurvatureOperator::factor(&lattice, &sample_xy, Conditioning::Bilinear)
            .expect("anchorless bilinear system must factor (residual null mode pinned)");
        assert_eq!(op.anchor_count(), 0);
        let field = op.solve(&z).unwrap();
        assert!(
            field.iter().all(|v| v.is_finite()),
            "solved field must be all-finite (not the old all-NaN singular result)"
        );

        // The interpolated surface passes through each off-node datum: read the
        // field back at every sample with the same bilinear weights the kernel used
        // and compare to the datum. Honoured to the DATA_WEIGHT least-squares floor.
        let mut max_misfit = 0.0_f64;
        let mut sse = 0.0_f64;
        for (xy, &d) in sample_xy.iter().zip(z.iter()) {
            if let SampleKind::Off { nodes, w } =
                classify_sample(&lattice, xy[0], xy[1], Conditioning::Bilinear)
            {
                let interp: f64 = (0..4).map(|k| w[k] * field[[nodes[k].0, nodes[k].1]]).sum();
                let e = (interp - d).abs();
                max_misfit = max_misfit.max(e);
                sse += e * e;
            }
        }
        let rms = (sse / sample_xy.len() as f64).sqrt();
        // A smooth dip over a dense cloud fits to well under a decimetre; the bound
        // is a real honouring guarantee (~4 orders below the 2000 m field), not a
        // loose sanity check.
        assert!(
            max_misfit < 0.5 && rms < 0.1,
            "off-node data not honoured: max {max_misfit} m, rms {rms} m"
        );
    }

    /// Too few anchors (a single one) leaves the plane null space unpinned → the
    /// system is singular → a clean error (the caller falls back). Fewer than the
    /// biharmonic null-family dimension of controls is GENUINELY under-constrained,
    /// so the Tikhonov retry must NOT rescue it.
    #[test]
    fn under_constrained_is_not_pd() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 6, 6);
        let sample_xy = [[2.0, 3.0]];
        let r = MinCurvatureOperator::factor(&lattice, &sample_xy, Conditioning::NearestNode);
        assert!(
            matches!(r, Err(AlgoError::InvalidArgument(_))),
            "single anchor must be non-PD"
        );
    }

    /// Length mismatch on solve is a typed error, not a panic.
    #[test]
    fn solve_length_mismatch_errors() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 5, 5);
        let sample_xy = [[0.0, 0.0], [4.0, 0.0], [0.0, 4.0], [4.0, 4.0]];
        let op =
            MinCurvatureOperator::factor(&lattice, &sample_xy, Conditioning::NearestNode).unwrap();
        assert!(matches!(
            op.solve(&[1.0, 2.0]),
            Err(AlgoError::InvalidArgument(_))
        ));
    }

    /// A degenerate (<2×2) lattice errors so the caller falls back to the SOR.
    #[test]
    fn degenerate_lattice_errors() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 5, 1);
        let sample_xy = [[0.0, 0.0], [4.0, 0.0]];
        assert!(matches!(
            MinCurvatureOperator::factor(&lattice, &sample_xy, Conditioning::NearestNode),
            Err(AlgoError::InvalidGeometry(_))
        ));
    }

    /// All-anchored lattice: no free unknowns, the field is exactly the anchors.
    #[test]
    fn all_anchored_returns_anchor_values() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 3, 3);
        let mut sample_xy = Vec::new();
        let mut z = Vec::new();
        for j in 0..3 {
            for i in 0..3 {
                sample_xy.push([i as f64, j as f64]);
                z.push((i + 10 * j) as f64);
            }
        }
        let op =
            MinCurvatureOperator::factor(&lattice, &sample_xy, Conditioning::NearestNode).unwrap();
        assert_eq!(op.free_count(), 0);
        assert_eq!(op.anchor_count(), 9);
        let field = op.solve(&z).unwrap();
        for j in 0..3 {
            for i in 0..3 {
                assert_eq!(field[[i, j]], (i + 10 * j) as f64);
            }
        }
    }

    /// Timing harness for the convicted hotspot (~122×116 lattice, ~39k off-node
    /// samples). `cargo test --release -- --ignored --nocapture mincurv_operator::tests::hotspot`.
    /// Reports the old SOR wall time, the direct one-shot (factor+solve), and the
    /// per-horizon reuse cost (factor once, solve many).
    #[test]
    #[ignore]
    fn hotspot_timing() {
        use super::super::min_curvature::grid_min_curvature_sor;
        use std::time::Instant;
        let (nc, nr) = (122usize, 116usize);
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, nc, nr);
        // ~39k off-node samples on the unit lattice (petekStatic's [fi,fj] space).
        let step = 0.6f64;
        let mut coords: Vec<[f64; 3]> = Vec::new();
        let mut y = 0.3;
        while y < (nr - 1) as f64 {
            let mut x = 0.2;
            while x < (nc - 1) as f64 {
                let z = 2000.0 + 0.02 * x - 0.015 * y + 6.0 * ((x * 0.11).sin() + (y * 0.09).cos());
                coords.push([x, y, z]);
                x += step;
            }
            y += step;
        }
        let sample_xy: Vec<[f64; 2]> = coords.iter().map(|c| [c[0], c[1]]).collect();
        let z: Vec<f64> = coords.iter().map(|c| c[2]).collect();
        println!(
            "\nhotspot: {}x{} lattice ({} nodes), {} off-node samples",
            nc,
            nr,
            nc * nr,
            coords.len()
        );

        // Direct one-shot: factor + solve.
        let t = Instant::now();
        let op =
            MinCurvatureOperator::factor(&lattice, &sample_xy, Conditioning::Bilinear).unwrap();
        let t_factor = t.elapsed();
        let t = Instant::now();
        let _field = op.solve(&z).unwrap();
        let t_solve = t.elapsed();
        println!(
            "  DIRECT factor = {:?}, solve = {:?}, one-shot total = {:?}",
            t_factor,
            t_solve,
            t_factor + t_solve
        );

        // Reuse: 20 horizons over the same geometry (redrawn depths).
        let n_horizons = 20;
        let t = Instant::now();
        for h in 0..n_horizons {
            let zz: Vec<f64> = z.iter().map(|v| v + h as f64).collect();
            let _ = op.solve(&zz).unwrap();
        }
        let per = t.elapsed() / n_horizons;
        println!("  REUSE per-horizon solve (x{n_horizons}) = {per:?}");

        // Old SOR one-shot (the "before"). Capped at MAX_ITERS internally.
        let t = Instant::now();
        let _ = grid_min_curvature_sor(&coords, &lattice, None, Conditioning::Bilinear);
        println!("  SOR (old cold one-shot) = {:?}\n", t.elapsed());
    }

    /// Micro-bench for the **anchorless** (Tikhonov-stabilized) bilinear path — the
    /// real-seismic shape (no on-node sample). Reports the stabilized factor + solve
    /// wall and the data-honouring misfit.
    /// `cargo test --release -- --ignored --nocapture mincurv_operator::tests::anchorless_bench`.
    #[test]
    #[ignore]
    fn anchorless_bench() {
        use std::time::Instant;
        let (xori, yori, cell, nc, nr) = (431_000.0, 6_521_000.0, 100.0, 41usize, 37usize);
        let lattice = Lattice::regular(xori, yori, cell, cell, nc, nr);
        let span_x = cell * (nc - 1) as f64;
        let span_y = cell * (nr - 1) as f64;
        let mut s: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = || {
            s = s
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((s >> 33) as f64) / (u32::MAX as f64)
        };
        let mut sample_xy: Vec<[f64; 2]> = Vec::new();
        let mut z: Vec<f64> = Vec::new();
        for _ in 0..1500 {
            let fx = next();
            let fy = next();
            sample_xy.push([
                xori + (0.2 + 0.6 * fx) * span_x + 0.37,
                yori + (0.2 + 0.6 * fy) * span_y + 0.29,
            ]);
            z.push(2000.0 + 30.0 * fx + 20.0 * fy);
        }
        let t = Instant::now();
        let op =
            MinCurvatureOperator::factor(&lattice, &sample_xy, Conditioning::Bilinear).unwrap();
        let t_factor = t.elapsed();
        let t = Instant::now();
        let field = op.solve(&z).unwrap();
        let t_solve = t.elapsed();
        let (mut mx, mut sse) = (0.0f64, 0.0f64);
        for (xy, &d) in sample_xy.iter().zip(z.iter()) {
            if let SampleKind::Off { nodes, w } =
                classify_sample(&lattice, xy[0], xy[1], Conditioning::Bilinear)
            {
                let v: f64 = (0..4).map(|k| w[k] * field[[nodes[k].0, nodes[k].1]]).sum();
                mx = mx.max((v - d).abs());
                sse += (v - d) * (v - d);
            }
        }
        println!(
            "\nanchorless {nc}x{nr} ({} nodes), {} off-node samples, 0 anchors\n  \
             stabilized factor = {t_factor:?}, solve = {t_solve:?}, one-shot = {:?}\n  \
             data misfit: max = {mx:e} m, rms = {:e} m\n",
            nc * nr,
            sample_xy.len(),
            t_factor + t_solve,
            (sse / sample_xy.len() as f64).sqrt()
        );
    }

    /// Factor once, solve two different horizons (RHS) over the SAME geometry —
    /// each is the independent direct solution (reuse path for petekStatic's MC).
    #[test]
    fn factor_once_solve_many_horizons() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 7, 7);
        let sample_xy = [[0.0, 0.0], [6.0, 0.0], [0.0, 6.0], [6.0, 6.0], [3.0, 3.0]];
        let op =
            MinCurvatureOperator::factor(&lattice, &sample_xy, Conditioning::NearestNode).unwrap();
        // Two planes: z1 = 2x - 3y + 5, z2 = -x + 4y + 1. Both are exact
        // minimum-curvature solutions, so each solve must reproduce its plane.
        let plane = |a: f64, b: f64, c: f64| {
            sample_xy
                .iter()
                .map(|p| a * p[0] + b * p[1] + c)
                .collect::<Vec<_>>()
        };
        for (a, b, c) in [(2.0, -3.0, 5.0), (-1.0, 4.0, 1.0)] {
            let field = op.solve(&plane(a, b, c)).unwrap();
            for j in 0..7 {
                for i in 0..7 {
                    let want = a * i as f64 + b * j as f64 + c;
                    assert!(
                        (field[[i, j]] - want).abs() < 1e-6,
                        "({i},{j}): {} vs {want}",
                        field[[i, j]]
                    );
                }
            }
        }
    }
}
