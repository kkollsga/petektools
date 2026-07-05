//! Nearest-neighbour gridding: each node takes its areally-closest sample's Z.
//!
//! Ported from petekio 0.2.0 `src/core/gridding.rs` (`grid_nearest` /
//! `build_rtree`, the author's own prior art) with the `GridGeometry` parameter
//! swapped 1:1 for [`Lattice`]. An `rstar` R*-tree over the sample XY answers one
//! nearest-neighbour query per node.

use crate::foundation::Lattice;
use ndarray::Array2;
use rstar::primitives::GeomWithData;
use rstar::RTree;

/// An areal R*-tree entry: a sample's `[x, y]` payloaded with its index into
/// `coords` (so the nearest query can recover the sample's Z).
type AerialEntry = GeomWithData<[f64; 2], usize>;

/// Build an areal R*-tree over `coords`' XY, payloaded with the point index.
fn build_rtree(coords: &[[f64; 3]]) -> RTree<AerialEntry> {
    let entries: Vec<AerialEntry> = coords
        .iter()
        .enumerate()
        .map(|(i, c)| GeomWithData::new([c[0], c[1]], i))
        .collect();
    RTree::bulk_load(entries)
}

/// `(ncol × nrow)` node values, each the Z of the nearest sample.
pub(crate) fn grid_nearest(coords: &[[f64; 3]], lattice: &Lattice) -> Array2<f64> {
    let tree = build_rtree(coords);
    let mut out = Array2::from_elem((lattice.ncol, lattice.nrow), f64::NAN);
    for j in 0..lattice.nrow {
        for i in 0..lattice.ncol {
            let (x, y) = lattice.node_xy(i, j);
            if let Some(e) = tree.nearest_neighbor([x, y]) {
                out[[i, j]] = coords[e.data][2];
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_node_takes_closest_sample_z() {
        // Two samples placed near opposite corners of a 3×3 unit lattice.
        // Nodes split along the diagonal: the (0,0)-side takes 10, the
        // (2,2)-side takes 20.
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 3, 3);
        let coords = [[0.0, 0.0, 10.0], [2.0, 2.0, 20.0]];
        let out = grid_nearest(&coords, &lattice);

        assert_eq!(out.dim(), (3, 3));
        // Corner node coincident with a sample → that sample's Z exactly.
        assert_eq!(out[[0, 0]], 10.0);
        assert_eq!(out[[2, 2]], 20.0);
        // A node nearer the first sample.
        assert_eq!(out[[0, 1]], 10.0);
        // A node nearer the second sample.
        assert_eq!(out[[2, 1]], 20.0);
        // Every node is one of the two sample Z's (blocky, exact at data).
        for &v in out.iter() {
            assert!(v == 10.0 || v == 20.0);
        }
    }

    #[test]
    fn single_sample_fills_every_node() {
        let lattice = Lattice::regular(-5.0, -5.0, 2.5, 2.5, 4, 4);
        let coords = [[100.0, 100.0, 42.0]];
        let out = grid_nearest(&coords, &lattice);
        for &v in out.iter() {
            assert_eq!(v, 42.0);
        }
    }
}
