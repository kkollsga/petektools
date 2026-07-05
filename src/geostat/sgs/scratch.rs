//! Reusable per-sweep scratch for the sequential-Gaussian sweep.

use crate::geostat::local_kriging::{SkNeighbour, SkScratch};
use crate::geostat::neighbourhood::Neighbourhood;

/// Reusable per-sweep scratch for [`simulate_scores`](super::sweep::simulate_scores).
/// Every buffer here is **layer-invariant in shape** (its size is fixed by the
/// lattice) but **layer-varying in content** — so an
/// [`SgsSession`](super::session::SgsSession) retains one set across all layers and
/// re-fills them each sweep, paying the (large) allocation once instead of per
/// layer.
///
/// What is retained and why:
/// - `inf_pos` / `inf_val` / `path` — the informed-node arrays and the visiting
///   path, each grown to `ncol · nrow`; cleared and re-pushed per sweep.
/// - `near` / `neighbours` — the per-node neighbour scratch (queried once per
///   node); cleared and re-filled per node.
/// - `sk` — the [`SkScratch`] kriging solver buffers (matrix/rhs/perm/solution),
///   reused across every node of every layer with **zero** per-node allocation.
/// - `nb` — the R*-tree search index. This one is **rebuilt** per sweep, not
///   reused: the tree grows in *visiting-path order* (each simulated node is
///   inserted as it is drawn) and the path differs per layer (conditioning
///   membership differs), so the tree's contents and insertion order genuinely
///   differ between layers. Bulk-reloading a retained frame would change the
///   nearest-neighbour tie-breaking at the `max_n` boundary and so break the
///   bit-for-bit determinism petekStatic pins. It is kept in the scratch only so
///   the `Neighbourhood` allocation is co-located; each sweep starts a fresh tree.
#[derive(Default)]
pub(super) struct SgsScratch {
    pub(super) inf_pos: Vec<[f64; 2]>,
    pub(super) inf_val: Vec<f64>,
    pub(super) path: Vec<(usize, usize)>,
    pub(super) near: Vec<(usize, f64)>,
    pub(super) neighbours: Vec<SkNeighbour>,
    pub(super) nb: Neighbourhood,
    pub(super) sk: SkScratch,
}
