//! Briggs minimum-curvature gridding via biharmonic (∇⁴z = 0) relaxation.
//!
//! **The primary solver is now the direct band-LU factorization of this same
//! system** ([`super::mincurv_operator`]) — the SOR relaxation here is the
//! *fallback* (degenerate `<2×2` lattices, singular/under-constrained systems)
//! and the reference the direct path is validated against. Everything below
//! describes the operator both paths share.
//!
//! The stencil derives from petekio 0.2.0 `src/core/gridding.rs`
//! (`grid_min_curvature`, the author's own prior art), with the `GridGeometry`
//! parameter swapped 1:1 for [`Lattice`]. The **boundary treatment** and the
//! **tension blend** are since brought to parity with the family's own cold
//! solver (`petekStatic` `srs-gridder::solve_surface`) so the two kernels agree
//! node-for-node — see below. SOR defaults: ω = 1.5, absolute TOL = 1e-6,
//! MAX_ITERS = 20 000, tension T = 0.25.
//!
//! **Boundary treatment (natural dip).** The tensioned minimum-curvature stencil
//! is applied at every free node; stencil nodes that overrun the lattice are
//! synthesized by linear extrapolation (`z[t] = 2·z[t+1] − z[t+2]`), the natural
//! minimum-curvature boundary condition. A planar regional-dip field is then an
//! exact fixed point everywhere — the interior follows the dip out to the edge
//! instead of sagging toward a flat/free boundary (the old near-edge harmonic
//! fallback let it sag by ~12 ft on a 5-control dipping plane).
//!
//! The near-Neumann character of that boundary relaxes the smooth (near-linear)
//! modes slowly, so a **cold** solve needs many more sweeps to converge than the
//! old flat-boundary kernel — hence the larger `MAX_ITERS` and the tension term
//! (which folds in the faster-converging Laplacian). A **warm** re-solve from an
//! already-converged field still stops in ~1 sweep, so the warm-start path stays
//! cheap; that is the incremental path used by [`ConvergentGridder`].

use crate::foundation::Lattice;
use ndarray::Array2;

use super::idw::grid_idw;
use super::mincurv_operator::MinCurvatureOperator;
use super::Conditioning;

/// A sample within this fractional-node distance of a lattice node is treated as
/// **on-node** (a hard anchor) rather than an off-node bilinear constraint. Small
/// enough that genuine off-node scatter never trips it, large enough to absorb the
/// round-trip error of `node_xy → xy_to_ij` at world coordinates so exact node
/// controls stay bit-exact anchors under [`Conditioning::Bilinear`].
pub(super) const ON_NODE_EPS: f64 = 1e-9;

/// Weight of the off-node bilinear data-fit term relative to the biharmonic
/// smoothness term in the combined normal equations (`Conditioning::Bilinear`).
/// This is a **hard-honoring limit, not a tuning knob**: large enough that a node
/// carrying data is governed by the data (honoured to the least-misfit floor)
/// while smoothness governs only the data voids, and the result is *insensitive*
/// to the exact value above that data-domination threshold — the audit fixture
/// gives an identical on-data rms (to 3 sig figs) for anything from `1e3` to
/// `1e6`. Finite (not ∞) so a weakly-constrained node — one touched only by a
/// far-corner, tiny-weight sample — is still regularized by curvature rather than
/// forced through a single ill-conditioned constraint. `~6e3×` the biharmonic
/// diagonal (`denom ≈ 16`).
pub(super) const DATA_WEIGHT: f64 = 1.0e5;

/// Smith & Wessel (1990) tension in `[0, 1]`: 0 = pure biharmonic (∇⁴z = 0),
/// 1 = harmonic (∇²z = 0). A light tension blends the fast-converging Laplacian
/// into the stiff biharmonic operator so the smooth (near-linear) mode reaches
/// its fixed point in ~thousands rather than ~hundreds-of-thousands of SOR sweeps
/// — the enabler for the natural-dip plane to converge to near-zero drift within
/// the iteration budget. Matches the family's cold solver default
/// (`petekStatic` `srs-gridder::solve_surface`).
pub(super) const TENSION: f64 = 0.25;

/// Briggs minimum-curvature gridding via biharmonic (∇⁴z = 0) SOR relaxation,
/// anchored at the grid nodes nearest each data sample.
///
/// **Scope:** a straightforward, convergent implementation for small/moderate
/// grids — every free node uses the 13-point biharmonic stencil, with
/// out-of-lattice stencil nodes synthesized by linear extrapolation (the
/// natural-dip boundary condition; see the module docs). Data are honoured by
/// snapping each sample to its nearest node and holding those fixed. Linear
/// trends (the exact biharmonic solution) are reproduced to tolerance — over
/// the whole lattice, boundary included, so a dipping surface does not sag at
/// the edges.
///
/// When `seed` is `Some` and matches the lattice shape `(ncol, nrow)`, the SOR
/// relaxation starts from it (a **warm start**) instead of the cold IDW seed —
/// for an incremental re-grid this converges in far fewer iterations while
/// reaching the same field (warm == cold to tolerance). `None` or a wrong-shape
/// seed falls back to the cold IDW seed. The whole field is re-solved either
/// way; the seed only changes the starting point.
///
/// `conditioning` selects how samples are honoured:
/// - [`Conditioning::NearestNode`] — each sample snaps to its nearest node,
///   collisions average, that node is held fixed. Exact at data that sit on
///   nodes; off-node data carry a snap error up to the local gradient × the
///   node-offset. This is the historical behaviour (kept bit-for-bit).
/// - [`Conditioning::Bilinear`] — a sample that lands on a node is still a hard
///   anchor (bit-identical to `NearestNode`), but an **off-node** sample is
///   honoured through the bilinear interpolation of its four surrounding nodes
///   (`Σ wₖ·z(nodeₖ) = z_data`), enforced by a relaxed-Kaczmarz projection
///   interleaved with the biharmonic sweep. The *interpolated surface* passes
///   through the datum, eliminating the nearest-node snap error.
pub(crate) fn grid_min_curvature(
    coords: &[[f64; 3]],
    lattice: &Lattice,
    seed: Option<&Array2<f64>>,
    conditioning: Conditioning,
) -> Array2<f64> {
    // Primary path: assemble the fused biharmonic + data-fit system as a sparse
    // SPD matrix and solve it DIRECTLY (Cholesky) — the SOR is cap-bound on
    // conditioning-heavy problems (tens of thousands of off-node samples) and
    // never reaches tolerance. The direct solve reproduces the SOR *fixed point*
    // exactly (to rounding) but actually attains it, at a fraction of the cost.
    // The `seed` is irrelevant to the direct path (it computes THE solution, not
    // an iterate) — a converged warm==cold is trivially satisfied.
    //
    // Fall back to the iterative SOR when the direct system cannot be used: a
    // degenerate (<2×2) lattice, or an under-constrained system whose free
    // biharmonic is not positive-definite (too few / collinear anchors). The SOR
    // handles those the way it always did, honouring the `seed`.
    let sample_xy: Vec<[f64; 2]> = coords.iter().map(|c| [c[0], c[1]]).collect();
    if let Ok(op) = MinCurvatureOperator::factor(lattice, &sample_xy, conditioning) {
        let z: Vec<f64> = coords.iter().map(|c| c[2]).collect();
        if let Ok(field) = op.solve(&z) {
            return field;
        }
    }
    grid_min_curvature_sor(coords, lattice, seed, conditioning)
}

/// How a data sample is honoured against the lattice: a hard on-node anchor, an
/// off-node bilinear constraint, or skipped (off the lattice / degenerate). The
/// single classifier shared by the iterative SOR kernel and the direct
/// [`MinCurvatureOperator`] so both agree sample-for-sample.
pub(super) enum SampleKind {
    /// Snap to node `(i, j)` and hold it fixed (collisions average).
    OnNode(usize, usize),
    /// Honour off-node through the bilinear interpolation of the four surrounding
    /// nodes (`Σ wₖ·zₖ = z_data`).
    Off {
        nodes: [(usize, usize); 4],
        w: [f64; 4],
    },
    /// Off the lattice footprint (or a degenerate lattice) — dropped.
    Skip,
}

/// Classify a sample at world `(x, y)` under `conditioning`. Encodes the exact
/// on-node / off-node / drop predicates both solve paths must agree on (the
/// `ON_NODE_EPS` snap tolerance, the off-node footprint bounds, the far-neighbour
/// clamp).
pub(super) fn classify_sample(
    lattice: &Lattice,
    x: f64,
    y: f64,
    conditioning: Conditioning,
) -> SampleKind {
    let (nc, nr) = (lattice.ncol, lattice.nrow);
    let Some((fi, fj)) = lattice.xy_to_ij(x, y) else {
        return SampleKind::Skip;
    };
    let off_node = matches!(conditioning, Conditioning::Bilinear)
        && ((fi - fi.round()).abs() > ON_NODE_EPS || (fj - fj.round()).abs() > ON_NODE_EPS);
    if off_node {
        // Require the sample inside the node footprint so all 4 surrounding nodes
        // exist (a non-integer coord in (0, n-1) floors to [0, n-2]).
        if fi < 0.0 || fj < 0.0 || fi > (nc as f64 - 1.0) || fj > (nr as f64 - 1.0) {
            return SampleKind::Skip;
        }
        let (i0, j0) = (fi.floor() as usize, fj.floor() as usize);
        // Clamp the far neighbour: an integer coord on the last row/column would
        // overrun, but its bilinear weight there is 0, so folding it onto i0/j0 is
        // exact and keeps every node index in range.
        let (i1, j1) = ((i0 + 1).min(nc - 1), (j0 + 1).min(nr - 1));
        let (tx, ty) = (fi - i0 as f64, fj - j0 as f64);
        SampleKind::Off {
            nodes: [(i0, j0), (i1, j0), (i0, j1), (i1, j1)],
            w: [
                (1.0 - tx) * (1.0 - ty),
                tx * (1.0 - ty),
                (1.0 - tx) * ty,
                tx * ty,
            ],
        }
    } else {
        let i = fi.round();
        let j = fj.round();
        if i < 0.0 || j < 0.0 {
            return SampleKind::Skip;
        }
        let (i, j) = (i as usize, j as usize);
        if i < nc && j < nr {
            SampleKind::OnNode(i, j)
        } else {
            SampleKind::Skip
        }
    }
}

/// The iterative SOR minimum-curvature kernel — the original convergent
/// relaxation, now the **fallback** behind the direct [`MinCurvatureOperator`]
/// (used for degenerate lattices and under-constrained systems). Honours the
/// `seed` warm start. See the module docs for the boundary/tension treatment.
pub(super) fn grid_min_curvature_sor(
    coords: &[[f64; 3]],
    lattice: &Lattice,
    seed: Option<&Array2<f64>>,
    conditioning: Conditioning,
) -> Array2<f64> {
    let (nc, nr) = (lattice.ncol, lattice.nrow);
    // Warm-start from `seed` when shape-matched, else cold IDW seed (a smooth,
    // in-range field). Same seed contract as petekio's `grid_min_curvature`.
    let mut z = match seed {
        Some(s) if s.dim() == (nc, nr) => s.clone(),
        _ => grid_idw(coords, lattice),
    };

    // Classify samples. On-node samples (both modes) are hard anchors — snapped
    // to the node, collisions averaged. In `Bilinear` mode an off-node sample
    // becomes a bilinear least-squares constraint (`Σ wₖ·z(nodeₖ) = z_data`) on
    // its 4 surrounding nodes, folded into the free-node solve below.
    let mut fixed = Array2::from_elem((nc, nr), false);
    let mut acc: std::collections::HashMap<(usize, usize), (f64, usize)> =
        std::collections::HashMap::new();
    let mut off: Vec<OffSample> = Vec::new();
    for c in coords {
        match classify_sample(lattice, c[0], c[1], conditioning) {
            // Nearest-node anchor (the historical path; bit-exact on-node).
            SampleKind::OnNode(i, j) => {
                let e = acc.entry((i, j)).or_insert((0.0, 0));
                e.0 += c[2];
                e.1 += 1;
            }
            SampleKind::Off { nodes, w } => off.push(OffSample { nodes, w, d: c[2] }),
            SampleKind::Skip => {}
        }
    }
    for ((i, j), (sum, n)) in acc {
        z[[i, j]] = sum / n as f64;
        fixed[[i, j]] = true;
    }

    // Per-node incidence into `off` (sample index + which of its 4 weights this
    // node is) and the data-normal diagonal `Aₚ = Σ wₖ²`. Built only for free
    // nodes — a hard on-node anchor keeps its exact value and only contributes to
    // its neighbours' residuals, never moves. Fixed order (samples in input order)
    // → deterministic.
    let mut incidence: std::collections::HashMap<(usize, usize), Vec<(usize, u8)>> =
        std::collections::HashMap::new();
    let mut a_diag: std::collections::HashMap<(usize, usize), f64> =
        std::collections::HashMap::new();
    for (s_idx, s) in off.iter().enumerate() {
        for (k, &(i, j)) in s.nodes.iter().enumerate() {
            if s.w[k] == 0.0 || fixed[[i, j]] {
                continue;
            }
            incidence.entry((i, j)).or_default().push((s_idx, k as u8));
            *a_diag.entry((i, j)).or_insert(0.0) += s.w[k] * s.w[k];
        }
    }

    if nc < 2 || nr < 2 {
        return z;
    }

    // The natural-dip boundary is a near-Neumann condition: the smooth
    // (constant/linear) modes sit close to the SOR null space and relax slowly,
    // so a cold solve needs more sweeps to reach the fixed point than the old
    // flat-boundary kernel did. Match the family cold solver's cap
    // (`petekStatic` `srs-gridder::solve_surface`, 20 000) so cold actually
    // converges — a warm re-solve from a converged field then stops in ~1 sweep,
    // which is where the warm-start speed-up comes from.
    const MAX_ITERS: usize = 20_000;
    // Absolute per-sweep convergence tolerance (max nodal change), matching the
    // family cold solver. Absolute rather than scaled-by-data-range: the range
    // scaling left a slow SOR tail (residual ~ hundreds × the stop threshold)
    // that both sagged the plane reference and made warm/cold solves halt at
    // slightly different (non-converged) points.
    const TOL: f64 = 1e-6;
    const OMEGA: f64 = 1.5; // SOR over-relaxation

    // Tensioned min-curvature denominator (constant across the sweep).
    let denom = 20.0 * (1.0 - TENSION) + 4.0 * TENSION;
    for _ in 0..MAX_ITERS {
        let mut max_delta = 0.0_f64;
        for j in 0..nr {
            for i in 0..nc {
                if fixed[[i, j]] {
                    continue;
                }
                // Biharmonic Gauss-Seidel target: `zₚ = Sₚ / denom`.
                let target = relaxation_target(&z, nc, nr, i, j, denom);
                let new = match incidence.get(&(i, j)) {
                    // A node with off-node data solves the COMBINED normal
                    // equation of the biharmonic energy and the bilinear data fit
                    // (both SPD → the SOR sweep is convergent), so the interpolated
                    // surface passes through the data:
                    //   zₚ = (Sₚ + μ·Σ wₚ(dₛ − Rₚ)) / (denom + μ·Aₚ)
                    // where `Rₚ = Σ_{k≠p} wₖzₖ` is the bilinear estimate at the
                    // sample without p's own contribution.
                    Some(inc) => {
                        let s_p = denom * target;
                        let a_p = a_diag[&(i, j)];
                        let mut num_data = 0.0;
                        for &(s_idx, k) in inc {
                            let s = &off[s_idx];
                            let est: f64 = (0..4)
                                .map(|m| s.w[m] * z[[s.nodes[m].0, s.nodes[m].1]])
                                .sum();
                            let r_excl = est - s.w[k as usize] * z[[i, j]];
                            num_data += s.w[k as usize] * (s.d - r_excl);
                        }
                        (s_p + DATA_WEIGHT * num_data) / (denom + DATA_WEIGHT * a_p)
                    }
                    None => target,
                };
                let old = z[[i, j]];
                let updated = old + OMEGA * (new - old);
                z[[i, j]] = updated;
                max_delta = max_delta.max((updated - old).abs());
            }
        }
        if max_delta < TOL {
            break;
        }
    }
    z
}

/// An off-node sample honoured through the bilinear interpolation of its four
/// surrounding nodes (`Σ wₖ·z(nodeₖ) = z_data`) — the off-node analogue of a
/// hard-pinned anchor under [`Conditioning::Bilinear`].
struct OffSample {
    /// The four surrounding nodes: `(i0,j0), (i1,j0), (i0,j1), (i1,j1)`.
    nodes: [(usize, usize); 4],
    /// Bilinear weights aligned with `nodes` (sum to 1).
    w: [f64; 4],
    /// The datum the interpolated surface must reproduce at the sample.
    d: f64,
}

/// Tensioned minimum-curvature centre-node update, solving
/// `(1−T)∇⁴z − T∇²z = 0` (Briggs 1974 biharmonic blended toward Smith & Wessel
/// 1990 harmonic tension) for the free node:
/// `z = [ (1−T)(8·E1 − 2·D − W2) + T·E1 ] / [ 20(1−T) + 4T ]`,
/// where `E1` = the 4 orthogonal edge neighbours, `D` = the 4 diagonals, and
/// `W2` = the 4 two-away nodes.
///
/// Applied at **every** free node, including the boundary ring: stencil nodes
/// that overrun the lattice are synthesized by linear extrapolation ([`z_at`]) —
/// the **natural minimum-curvature ("natural-dip") boundary condition**. Because
/// a plane extends to itself under that extrapolation, a planar regional-dip
/// field is an exact fixed point of the update everywhere, so the gridder follows
/// the regional dip out to the edge instead of sagging toward a flat/free
/// boundary. (Structure ported from the family's own prior-art cold solver,
/// `petekStatic` `srs-gridder::solve_surface`.)
fn relaxation_target(z: &Array2<f64>, nc: usize, nr: usize, i: usize, j: usize, denom: f64) -> f64 {
    let (ii, jj) = (i as isize, j as isize);
    let at = |di: isize, dj: isize| z_at(z, nc, nr, ii + di, jj + dj);
    // E1 = 4 orthogonal edge neighbours, D = 4 diagonals, W2 = 4 two-away nodes.
    let e1 = at(0, 1) + at(0, -1) + at(1, 0) + at(-1, 0);
    let d = at(1, 1) + at(-1, 1) + at(1, -1) + at(-1, -1);
    let w2 = at(0, 2) + at(0, -2) + at(2, 0) + at(-2, 0);
    ((1.0 - TENSION) * (8.0 * e1 - 2.0 * d - w2) + TENSION * e1) / denom
}

/// Read `z` at a possibly out-of-lattice stencil node, extending the field
/// **linearly** one step beyond each edge (`z[t] = 2·z[t+1] − z[t+2]`) — the
/// natural-dip boundary condition that keeps a planar field an exact fixed
/// point. Bounded recursion: the biharmonic stencil reaches at most two nodes
/// past an edge, and each step moves the index strictly inward.
fn z_at(z: &Array2<f64>, nc: usize, nr: usize, i: isize, j: isize) -> f64 {
    let (nci, nri) = (nc as isize, nr as isize);
    if i < 0 {
        return 2.0 * z_at(z, nc, nr, i + 1, j) - z_at(z, nc, nr, i + 2, j);
    }
    if i >= nci {
        return 2.0 * z_at(z, nc, nr, i - 1, j) - z_at(z, nc, nr, i - 2, j);
    }
    if j < 0 {
        return 2.0 * z_at(z, nc, nr, i, j + 1) - z_at(z, nc, nr, i, j + 2);
    }
    if j >= nri {
        return 2.0 * z_at(z, nc, nr, i, j - 1) - z_at(z, nc, nr, i, j - 2);
    }
    z[[i as usize, j as usize]]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A single off-node sample under `Bilinear` conditioning: the *interpolated*
    /// surface passes through the datum (`Σ wₖ·zₖ = z_data`), whereas the
    /// `NearestNode` path snaps it to a node and misses. Read the solved field at
    /// the exact sample position with the same bilinear weights the kernel used.
    #[test]
    fn off_node_sample_is_honoured_bilinearly() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 9, 9);
        // Sample at (4.3, 5.7): off-node in both axes.
        let (sx, sy, sz) = (4.3, 5.7, 100.0);
        // Surround it with a few on-node controls so the field is well posed.
        let mut coords = vec![
            [0.0, 0.0, 10.0],
            [8.0, 0.0, 20.0],
            [0.0, 8.0, 15.0],
            [8.0, 8.0, 25.0],
            [sx, sy, sz],
        ];
        let bilinear_field = grid_min_curvature(&coords, &lattice, None, Conditioning::Bilinear);
        // Bilinear read at the exact sample location.
        let (i0, j0) = (4usize, 5usize);
        let (tx, ty) = (0.3, 0.7);
        let read = |f: &Array2<f64>| {
            f[[i0, j0]] * (1.0 - tx) * (1.0 - ty)
                + f[[i0 + 1, j0]] * tx * (1.0 - ty)
                + f[[i0, j0 + 1]] * (1.0 - tx) * ty
                + f[[i0 + 1, j0 + 1]] * tx * ty
        };
        let bilinear_read = read(&bilinear_field);
        assert!(
            (bilinear_read - sz).abs() < 0.05,
            "Bilinear: interpolated surface must pass through the off-node datum, got {bilinear_read}"
        );
        // The NearestNode path snaps (4.3, 5.7) → node (4, 6) and holds THAT node
        // at 100, so the interpolated value at the true sample is pulled away.
        coords.truncate(5);
        let nearest_field = grid_min_curvature(&coords, &lattice, None, Conditioning::NearestNode);
        let nearest_read = read(&nearest_field);
        assert!(
            (nearest_read - sz).abs() > (bilinear_read - sz).abs(),
            "NearestNode must miss the off-node datum by more than Bilinear: near {nearest_read} vs bil {bilinear_read}"
        );
    }

    /// A planar linear trend `z = a·x + b·y + c` is the exact biharmonic
    /// solution (∇⁴z = 0), so minimum curvature must reproduce it to tolerance
    /// when samples define the plane.
    #[test]
    fn linear_trend_reproduced_exactly() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 7, 7);
        let (a, b, c) = (2.0, -3.0, 5.0);

        // Sample every node so the plane is fully constrained; the relaxation
        // then has to hold the exact plane everywhere.
        let mut coords = Vec::new();
        for j in 0..7 {
            for i in 0..7 {
                let (x, y) = lattice.node_xy(i, j);
                coords.push([x, y, a * x + b * y + c]);
            }
        }

        let out = grid_min_curvature(&coords, &lattice, None, Conditioning::NearestNode);
        for j in 0..7 {
            for i in 0..7 {
                let (x, y) = lattice.node_xy(i, j);
                let expected = a * x + b * y + c;
                assert!(
                    (out[[i, j]] - expected).abs() < 1e-6,
                    "node ({i},{j}): got {}, want {expected}",
                    out[[i, j]]
                );
            }
        }
    }

    /// With only sparse corner+edge samples on a plane, the interior is *solved*
    /// (not sampled) — the biharmonic relaxation should still recover the plane
    /// to a looser tolerance, since a plane is the minimum-curvature surface.
    #[test]
    fn sparse_linear_samples_recover_plane() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 9, 9);
        let (a, b, c) = (1.0, 0.5, -2.0);
        // Sample only the boundary ring.
        let mut coords = Vec::new();
        for j in 0..9 {
            for i in 0..9 {
                if i == 0 || i == 8 || j == 0 || j == 8 {
                    let (x, y) = lattice.node_xy(i, j);
                    coords.push([x, y, a * x + b * y + c]);
                }
            }
        }
        let out = grid_min_curvature(&coords, &lattice, None, Conditioning::NearestNode);
        // Interior node, fully solved by relaxation.
        let (x, y) = lattice.node_xy(4, 4);
        let expected = a * x + b * y + c;
        assert!(
            (out[[4, 4]] - expected).abs() < 1e-3,
            "interior node: got {}, want {expected}",
            out[[4, 4]]
        );
    }

    /// **Natural-dip boundary reference.** A dipping plane `z = a + b·x + c·y`
    /// pinned at only 5 scattered controls, solved on a lattice whose footprint
    /// is much larger than the controls' — the interior and, critically, the
    /// boundary ring are *solved*, not sampled. A plane is the exact
    /// minimum-curvature surface, so with a natural-dip (linear-extrapolation)
    /// boundary condition every node must reproduce the plane to near machine
    /// precision. A flat/free (one-sided harmonic) boundary instead lets the
    /// interior sag toward the edges — this test pins per-node parity to catch
    /// that (the aggregate-blind ~12 ft interior sag).
    #[test]
    fn plane_reference_natural_dip_boundary() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 13, 13);
        let (a, b, c) = (5000.0, 2.0, 3.0);
        let plane = |x: f64, y: f64| a + b * x + c * y;
        // Five scattered controls: four corners + centre (enough to pin a plane).
        let mut coords = Vec::new();
        for &(i, j) in &[(0usize, 0usize), (12, 0), (0, 12), (12, 12), (6, 6)] {
            let (x, y) = lattice.node_xy(i, j);
            coords.push([x, y, plane(x, y)]);
        }
        let out = grid_min_curvature(&coords, &lattice, None, Conditioning::NearestNode);

        let mut max_drift = 0.0_f64;
        for j in 0..13 {
            for i in 0..13 {
                let (x, y) = lattice.node_xy(i, j);
                max_drift = max_drift.max((out[[i, j]] - plane(x, y)).abs());
            }
        }
        // Per-node parity: the reference solver holds 0.0 ft here; we require
        // near-zero drift (a small epsilon above the SOR tolerance), NOT an
        // aggregate stat.
        assert!(
            max_drift < 1e-3,
            "plane-reference max per-node drift {max_drift} ft (interior sag not eliminated)"
        );
    }

    /// Samples are honoured: a node snapped to a sample holds that sample's Z.
    #[test]
    fn anchors_are_honoured() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 5, 5);
        let coords = [[0.0, 0.0, 0.0], [4.0, 4.0, 100.0], [2.0, 2.0, 50.0]];
        let out = grid_min_curvature(&coords, &lattice, None, Conditioning::NearestNode);
        assert!((out[[0, 0]] - 0.0).abs() < 1e-9);
        assert!((out[[4, 4]] - 100.0).abs() < 1e-9);
        assert!((out[[2, 2]] - 50.0).abs() < 1e-9);
    }

    /// Degenerate 1-D lattices short-circuit before relaxation (the `nc < 2 ||
    /// nr < 2` guard) and just return the snapped/IDW seed without panicking.
    #[test]
    fn degenerate_single_row_does_not_panic() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 5, 1);
        let coords = [[0.0, 0.0, 10.0], [4.0, 0.0, 20.0]];
        let out = grid_min_curvature(&coords, &lattice, None, Conditioning::NearestNode);
        assert_eq!(out.dim(), (5, 1));
        assert!(out.iter().all(|v| v.is_finite()));
    }

    /// Warm == cold to tolerance: seeding the relaxation with the cold solution
    /// must reach the same field (the seed only changes the starting point, not
    /// the fixed point the SOR converges to).
    #[test]
    fn warm_start_matches_cold_to_tolerance() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 12, 10);
        let coords = [
            [1.0, 1.0, 10.0],
            [9.0, 2.0, 25.0],
            [3.0, 8.0, 5.0],
            [10.0, 8.0, 40.0],
            [5.0, 5.0, 18.0],
        ];
        let cold = grid_min_curvature(&coords, &lattice, None, Conditioning::NearestNode);
        let warm = grid_min_curvature(&coords, &lattice, Some(&cold), Conditioning::NearestNode);
        // The cold solve converges to `max_delta < TOL` (absolute, 1e-6); the
        // warm solve then re-relaxes from that converged field and stops in ~1
        // sweep, so warm and cold agree to the solver tolerance. 1e-3 is
        // comfortably above TOL yet ~four orders below the field magnitude: a
        // real continuity guarantee.
        for (w, c) in warm.iter().zip(cold.iter()) {
            assert!((w - c).abs() < 1e-3, "warm {w} vs cold {c}");
        }
    }

    /// A wrong-shape seed is ignored — falls back to the cold IDW seed, so the
    /// result is identical to a `None` (cold) solve.
    #[test]
    fn wrong_shape_seed_falls_back_to_cold() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 6, 6);
        let coords = [[0.0, 0.0, 0.0], [5.0, 5.0, 50.0], [2.0, 3.0, 20.0]];
        let cold = grid_min_curvature(&coords, &lattice, None, Conditioning::NearestNode);
        let bogus = Array2::from_elem((3, 3), 999.0); // wrong shape
        let out = grid_min_curvature(&coords, &lattice, Some(&bogus), Conditioning::NearestNode);
        for (o, c) in out.iter().zip(cold.iter()) {
            assert_eq!(o, c);
        }
    }
}
