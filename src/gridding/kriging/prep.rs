//! Scattered-data prep shared by every kriging kernel: the areal distance
//! metric and coincident-point merging.
//!
//! Coincident `(x, y)` data make any kriging system singular (two rows of the
//! coefficient matrix are identical), so both the global [`OrdinaryKriging`]
//! solver and the moving-neighbourhood [`LocalKriging`] kernel merge coincident
//! samples — averaging their `z` — before building the system. Hoisted here so
//! there is **one** merge with one set of semantics, reachable by both
//! (`geostat::local_kriging` already depends on this module for the [`Variogram`]
//! and the LU solver).
//!
//! [`OrdinaryKriging`]: crate::OrdinaryKriging
//! [`LocalKriging`]: crate::geostat::LocalKriging
//! [`Variogram`]: crate::Variogram

use std::collections::HashMap;

/// Areal (x, y) Euclidean distance between two `[x, y]` points.
#[inline]
pub(crate) fn dist2d(a: [f64; 2], b: [f64; 2]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

/// Merge exactly-coincident `(x, y)` data, averaging their `z`. Distinct
/// locations pass through unchanged; the output is ordered by each location's
/// **first appearance**, carrying that first row's `(x, y)` with the averaged
/// `z` — identical semantics to a naïve pairwise `==` scan.
///
/// `O(n)` expected via a hash grid keyed on the coordinate bit patterns
/// (`local_kriging`'s charter is tens of thousands of conditioning points, where
/// the old `O(n²)` scan dominated). `-0.0` is canonicalised to `+0.0` so the two
/// zero encodings key together, matching float `==`. (A `NaN` coordinate — never
/// a valid location — would key by its bit pattern rather than compare unequal;
/// distinct `NaN`s are not expected in real conditioning data.)
pub(crate) fn dedup_coincident(coords: &[[f64; 3]]) -> Vec<[f64; 3]> {
    let mut index: HashMap<(u64, u64), usize> = HashMap::with_capacity(coords.len());
    let mut out: Vec<[f64; 3]> = Vec::with_capacity(coords.len());
    let mut counts: Vec<usize> = Vec::with_capacity(coords.len());
    for c in coords {
        // `+ 0.0` collapses -0.0 to +0.0 so both zero encodings share a key.
        let key = ((c[0] + 0.0).to_bits(), (c[1] + 0.0).to_bits());
        match index.get(&key) {
            Some(&k) => {
                out[k][2] += c[2];
                counts[k] += 1;
            }
            None => {
                index.insert(key, out.len());
                out.push(*c);
                counts.push(1);
            }
        }
    }
    for (o, n) in out.iter_mut().zip(counts) {
        o[2] /= n as f64;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reference `O(n²)` merge the shipped kernels used before T1 — the golden
    /// reference the fast path must reproduce byte-for-byte on realistic data.
    fn dedup_reference(coords: &[[f64; 3]]) -> Vec<[f64; 3]> {
        let mut out: Vec<[f64; 3]> = Vec::with_capacity(coords.len());
        let mut counts: Vec<usize> = Vec::with_capacity(coords.len());
        'next: for c in coords {
            for (k, o) in out.iter_mut().enumerate() {
                if o[0] == c[0] && o[1] == c[1] {
                    o[2] += c[2];
                    counts[k] += 1;
                    continue 'next;
                }
            }
            out.push(*c);
            counts.push(1);
        }
        for (o, n) in out.iter_mut().zip(counts) {
            o[2] /= n as f64;
        }
        out
    }

    #[test]
    fn dist2d_ignores_z_and_is_euclidean() {
        assert_eq!(dist2d([0.0, 0.0], [3.0, 4.0]), 5.0);
        assert_eq!(dist2d([1.0, 1.0], [1.0, 1.0]), 0.0);
    }

    #[test]
    fn merges_coincident_averaging_z_first_appearance_order() {
        // Two coincident at (1,1): 10 and 20 -> 15, held at first appearance.
        let coords = [
            [0.0, 0.0, 0.0],
            [1.0, 1.0, 10.0],
            [1.0, 1.0, 20.0],
            [3.0, 3.0, 30.0],
        ];
        let got = dedup_coincident(&coords);
        assert_eq!(
            got,
            vec![[0.0, 0.0, 0.0], [1.0, 1.0, 15.0], [3.0, 3.0, 30.0]]
        );
    }

    #[test]
    fn golden_matches_the_reference_on_a_fixture_with_duplicates() {
        // A pseudo-random fixture salted with heavy coincidence: the fast hash-grid
        // path must reproduce the old O(n²) scan's output exactly (same order,
        // same averaged z).
        let mut coords: Vec<[f64; 3]> = Vec::new();
        let mut s: u64 = 0xBADC_0FFE;
        let mut next = || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            (s >> 11) as f64 / (1u64 << 53) as f64
        };
        for _ in 0..2_000 {
            // Snap x,y onto a coarse 12x12 grid so coincidences are frequent.
            let x = (next() * 12.0).floor();
            let y = (next() * 12.0).floor();
            let z = next() * 100.0;
            coords.push([x, y, z]);
        }
        assert_eq!(dedup_coincident(&coords), dedup_reference(&coords));
    }

    #[test]
    fn plus_and_minus_zero_key_together() {
        // Float `==` treats -0.0 == +0.0, so the two must merge (not split).
        let coords = [[-0.0, 0.0, 4.0], [0.0, -0.0, 6.0]];
        let got = dedup_coincident(&coords);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0][2], 5.0);
    }
}
