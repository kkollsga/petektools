//! The shared sequential-Gaussian sweep in normal-score space, plus the
//! conditioning-data snap — the mechanics common to every SGS entry point.

use super::scratch::SgsScratch;
use crate::foundation::Lattice;
use crate::geostat::local_kriging::{simple_kriging_with, SkNeighbour};
use crate::geostat::neighbourhood::Neighbourhood;
use crate::geostat::nscore::NormalScore;
use crate::gridding::kriging::SpatialVariogram;
use crate::sampling::seeded_rng;
use ndarray::Array2;
use rand::RngExt;
use rand_distr::{Distribution, Normal};

/// The shared **sequential Gaussian sweep** in normal-score (unit-variance,
/// zero-mean) space, common to conditional [`sgs`](super::sgs) and unconditional
/// [`sgs_unconditional`](super::sgs_unconditional), and to the reusing
/// [`SgsSession`](super::session::SgsSession).
///
/// `fixed` are nodes whose score is pre-set (hard conditioning data snapped to
/// their nodes — empty for an unconditional run). Every remaining node is visited
/// once in a seeded random path and drawn from its simple-kriging conditional
/// given all earlier-informed nodes; the draw immediately becomes conditioning
/// data for later nodes. `secondary` is the already-standardised collocated field
/// and its `ρ` (Markov-1), or `None`.
///
/// All working buffers live in `scratch`, so a one-shot caller passes a fresh
/// [`SgsScratch::default`](SgsScratch) and a session passes its retained one — **the
/// arithmetic and the RNG/visitation stream are identical either way**, so the
/// field is bit-for-bit the same. Returns the `(ncol × nrow)` field of simulated
/// normal-score values; the caller maps scores back to data space.
// One private sweep helper carrying the full geometry + params + scratch; a
// bundling struct would only re-group these same fields with no clarity gain.
#[allow(clippy::too_many_arguments)]
pub(super) fn simulate_scores(
    lattice: &Lattice,
    variogram: &SpatialVariogram,
    max_neighbours: usize,
    radius: f64,
    secondary: Option<&(Array2<f64>, f64)>,
    seed: u64,
    fixed: &[(usize, usize, f64)],
    scratch: &mut SgsScratch,
) -> Array2<f64> {
    let (ncol, nrow) = (lattice.ncol, lattice.nrow);

    // Simulated scores; NaN = not yet drawn. Row-major over (ncol, nrow).
    let mut sim = Array2::from_elem((ncol, nrow), f64::NAN);

    // Reset the retained scratch for this sweep (capacity kept). The search index
    // is rebuilt fresh — its contents/insertion order are layer-specific (see
    // [`SgsScratch`]).
    scratch.inf_pos.clear();
    scratch.inf_val.clear();
    scratch.path.clear();
    scratch.nb = Neighbourhood::new();

    for &(i, j, score) in fixed {
        if sim[[i, j]].is_nan() {
            let (x, y) = lattice.node_xy(i, j);
            scratch.inf_pos.push([x, y]);
            scratch.inf_val.push(score);
            scratch.nb.insert([x, y], scratch.inf_pos.len() - 1);
        }
        // On a node collision keep the first datum's informed entry; the node's
        // value takes the latest (coincident data snap to one node).
        sim[[i, j]] = score;
    }

    // Random visiting path over the un-fixed nodes (seeded Fisher–Yates).
    for j in 0..nrow {
        for i in 0..ncol {
            if sim[[i, j]].is_nan() {
                scratch.path.push((i, j));
            }
        }
    }
    let mut rng = seeded_rng(seed);
    for k in (1..scratch.path.len()).rev() {
        let swap = rng.random_range(0..=k);
        scratch.path.swap(k, swap);
    }
    let standard_normal = Normal::new(0.0, 1.0).expect("standard normal");

    // Sequential sweep. Index the retained `path` (it is not mutated here) so the
    // per-node neighbour/solver scratch can be borrowed disjointly.
    for idx in 0..scratch.path.len() {
        let (i, j) = scratch.path[idx];
        let (x, y) = lattice.node_xy(i, j);
        scratch
            .nb
            .nearest_into([x, y], max_neighbours, radius, &mut scratch.near);
        scratch.neighbours.clear();
        for &(pidx, _) in &scratch.near {
            let pos = scratch.inf_pos[pidx];
            scratch.neighbours.push(SkNeighbour {
                pos,
                value: scratch.inf_val[pidx],
                offset_to_target: [pos[0] - x, pos[1] - y],
            });
        }

        let collocated = secondary.and_then(|(sec, rho)| {
            let s = sec[[i, j]];
            if s.is_finite() {
                Some((s, *rho))
            } else {
                None
            }
        });

        let (mean, var) =
            simple_kriging_with(&scratch.neighbours, variogram, collocated, &mut scratch.sk);
        let score = mean + var.sqrt() * standard_normal.sample(&mut rng);

        sim[[i, j]] = score;
        scratch.inf_pos.push([x, y]);
        scratch.inf_val.push(score);
        scratch.nb.insert([x, y], scratch.inf_pos.len() - 1);
    }

    sim
}

/// Snap each `[x, y, z]` datum to its nearest lattice node and record it as hard
/// conditioning data `(i, j, normal-score(z))`, in input order (out-of-lattice
/// data are dropped). Shared by the one-shot [`sgs`](super::sgs) and the reusing
/// [`SgsSession`](super::session::SgsSession) so both fix data identically.
pub(super) fn snap_fixed(
    coords: &[[f64; 3]],
    lattice: &Lattice,
    ns: &NormalScore,
) -> Vec<(usize, usize, f64)> {
    let (ncol, nrow) = (lattice.ncol, lattice.nrow);
    let mut fixed: Vec<(usize, usize, f64)> = Vec::new();
    for c in coords {
        if let Some((fi, fj)) = lattice.xy_to_ij(c[0], c[1]) {
            let (i, j) = (fi.round(), fj.round());
            if i < 0.0 || j < 0.0 {
                continue;
            }
            let (i, j) = (i as usize, j as usize);
            if i >= ncol || j >= nrow {
                continue;
            }
            fixed.push((i, j, ns.forward(c[2])));
        }
    }
    fixed
}
