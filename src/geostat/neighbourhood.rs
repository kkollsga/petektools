//! A moving-neighbourhood search window over scattered points, backed by an
//! `rstar` R*-tree.
//!
//! Local kriging and sequential simulation estimate each target from only the
//! *nearby* data, not the whole set — the far data are screened by the near ones
//! and add cost without accuracy (Deutsch & Journel 1998, *GSLIB* §II.4;
//! Goovaerts 1997, §5.4). This type answers the shared query: the up-to-`max_n`
//! closest points within a `radius`, returned nearest-first with their squared
//! distances.
//!
//! Points are inserted dynamically (`insert`) so the same structure serves both a
//! static conditioning set (local kriging) and a set that grows as simulation
//! visits nodes (SGS re-uses each simulated value as future conditioning data).

use rstar::primitives::GeomWithData;
use rstar::RTree;

/// One tree entry: an `[x, y]` position payloaded with a caller index (into the
/// caller's value/coordinate arrays).
type Entry = GeomWithData<[f64; 2], usize>;

/// A growable areal search index answering "the `max_n` nearest points within
/// `radius`" queries. See the [module docs](self).
#[derive(Default)]
pub struct Neighbourhood {
    tree: RTree<Entry>,
}

impl Neighbourhood {
    /// An empty search index.
    pub fn new() -> Neighbourhood {
        Neighbourhood { tree: RTree::new() }
    }

    /// Bulk-build from `points` (`[x, y]`), each payloaded with its slice index.
    pub fn from_points(points: &[[f64; 2]]) -> Neighbourhood {
        let entries: Vec<Entry> = points
            .iter()
            .enumerate()
            .map(|(i, p)| GeomWithData::new(*p, i))
            .collect();
        Neighbourhood {
            tree: RTree::bulk_load(entries),
        }
    }

    /// Insert one point at `xy` carrying `index`.
    pub fn insert(&mut self, xy: [f64; 2], index: usize) {
        self.tree.insert(GeomWithData::new(xy, index));
    }

    /// The up-to-`max_n` closest points to `target` within `radius`, as
    /// `(index, distance)` pairs, **nearest first**.
    ///
    /// Walks the tree's nearest-neighbour iterator (ascending squared distance)
    /// and stops as soon as it has `max_n` hits or steps outside `radius` — so a
    /// tight neighbourhood costs `O(max_n · log N)`, not `O(N)`.
    pub fn nearest(&self, target: [f64; 2], max_n: usize, radius: f64) -> Vec<(usize, f64)> {
        let mut out = Vec::with_capacity(max_n);
        self.nearest_into(target, max_n, radius, &mut out);
        out
    }

    /// Like [`nearest`](Self::nearest), but writes the `(index, distance)` hits
    /// into `out` (cleared first, capacity retained) instead of allocating a fresh
    /// `Vec`. The scratch-reusing form for the per-node hot loops (sequential
    /// simulation queries this once per lattice node) — identical results, no
    /// per-query allocation.
    pub fn nearest_into(
        &self,
        target: [f64; 2],
        max_n: usize,
        radius: f64,
        out: &mut Vec<(usize, f64)>,
    ) {
        out.clear();
        if max_n == 0 {
            return;
        }
        let r2 = radius * radius;
        for (entry, d2) in self.tree.nearest_neighbor_iter_with_distance_2(target) {
            if d2 > r2 {
                break;
            }
            out.push((entry.data, d2.sqrt()));
            if out.len() >= max_n {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_up_to_max_n_nearest_first() {
        let pts = [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0]];
        let nb = Neighbourhood::from_points(&pts);
        let got = nb.nearest([0.0, 0.0], 2, 100.0);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].0, 0); // itself, distance 0
        assert_eq!(got[1].0, 1); // next closest
        assert!(got[0].1 <= got[1].1);
    }

    #[test]
    fn radius_excludes_far_points() {
        let pts = [[0.0, 0.0], [1.0, 0.0], [10.0, 0.0]];
        let nb = Neighbourhood::from_points(&pts);
        let got = nb.nearest([0.0, 0.0], 10, 2.0);
        assert_eq!(got.len(), 2); // the point at x=10 is beyond radius 2
    }

    #[test]
    fn insert_grows_the_index() {
        let mut nb = Neighbourhood::new();
        assert!(nb.nearest([0.0, 0.0], 5, 100.0).is_empty());
        nb.insert([0.0, 0.0], 7);
        nb.insert([1.0, 1.0], 9);
        let got = nb.nearest([0.0, 0.0], 5, 100.0);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].0, 7);
    }

    #[test]
    fn zero_max_n_is_empty() {
        let nb = Neighbourhood::from_points(&[[0.0, 0.0]]);
        assert!(nb.nearest([0.0, 0.0], 0, 100.0).is_empty());
    }
}
