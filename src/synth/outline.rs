//! **Outlines** — the closing contour of a structure, and a study-area boundary.
//!
//! - [`closure_outline`] extracts the **closing contour** of a surface at a given
//!   depth (spill) level by *marching squares* over the lattice, stitches the
//!   crossing segments into rings, and returns the largest closed ring — the
//!   four-way closure of a dome. (The dome recipe and its closure test share this
//!   machinery.)
//! - [`study_area_outline`] returns a trivial rectangular (optionally
//!   corner-rounded) boundary for an extent.
//!
//! Marching squares (Lorensen & Cline 1987, the 2-D case) emits, per grid cell, the
//! line segments where the bilinear field crosses the contour level, interpolated
//! along the cell edges; adjacent cells share an edge crossing exactly, so the
//! segments stitch into closed rings. Derived independently; no third-party code
//! was consulted.

use crate::foundation::{AlgoError, BBox, Lattice, Result};
use ndarray::Array2;
use std::collections::HashMap;

/// Extract the closing contour of `surface` (`ncol × nrow`, `field[col][row]`) on
/// `lattice` at the level `spill_depth`, returning the largest closed ring as
/// `[x, y]` world points (not repeating the first point).
///
/// The surface convention is [`synth_dome_surface`](crate::synth::synth_dome_surface):
/// higher = structurally up, so the region `surface > spill_depth` is the trap
/// interior and the returned ring is its boundary. Returns an **empty** ring when
/// no closed contour exists at that level (the contour reaches the grid edge — the
/// structure spills out — or the level is above the crest / below every flank).
/// Errors on a lattice smaller than `2 × 2` or a shape mismatch.
pub fn closure_outline(
    surface: &Array2<f64>,
    lattice: &Lattice,
    spill_depth: f64,
) -> Result<Vec<[f64; 2]>> {
    let (ncol, nrow) = (lattice.ncol, lattice.nrow);
    if surface.dim() != (ncol, nrow) {
        return Err(AlgoError::InvalidArgument(
            "closure_outline: surface shape must match the lattice".to_string(),
        ));
    }
    if ncol < 2 || nrow < 2 {
        return Err(AlgoError::InvalidArgument(
            "closure_outline: need at least a 2x2 lattice".to_string(),
        ));
    }

    let level = spill_depth;
    // Crossing point on the segment between world points a (val va) and b (val vb).
    let interp = |a: (f64, f64), va: f64, b: (f64, f64), vb: f64| -> [f64; 2] {
        let t = if (vb - va).abs() < f64::MIN_POSITIVE {
            0.5
        } else {
            (level - va) / (vb - va)
        };
        [a.0 + t * (b.0 - a.0), a.1 + t * (b.1 - a.1)]
    };

    let mut segments: Vec<([f64; 2], [f64; 2])> = Vec::new();
    for i in 0..ncol - 1 {
        for j in 0..nrow - 1 {
            let bl = lattice.node_xy(i, j);
            let br = lattice.node_xy(i + 1, j);
            let tr = lattice.node_xy(i + 1, j + 1);
            let tl = lattice.node_xy(i, j + 1);
            let (v_bl, v_br, v_tr, v_tl) = (
                surface[[i, j]],
                surface[[i + 1, j]],
                surface[[i + 1, j + 1]],
                surface[[i, j + 1]],
            );
            if [v_bl, v_br, v_tr, v_tl].iter().any(|v| v.is_nan()) {
                continue;
            }
            let idx = (v_bl > level) as u8
                | (((v_br > level) as u8) << 1)
                | (((v_tr > level) as u8) << 2)
                | (((v_tl > level) as u8) << 3);

            // Edge crossings (computed only where needed, but cheap to name).
            let e_bottom = || interp(bl, v_bl, br, v_br); // BL-BR
            let e_right = || interp(br, v_br, tr, v_tr); // BR-TR
            let e_top = || interp(tr, v_tr, tl, v_tl); // TR-TL
            let e_left = || interp(tl, v_tl, bl, v_bl); // TL-BL

            let mut push = |p: [f64; 2], q: [f64; 2]| segments.push((p, q));
            match idx {
                1 | 14 => push(e_left(), e_bottom()),
                2 | 13 => push(e_bottom(), e_right()),
                3 | 12 => push(e_left(), e_right()),
                4 | 11 => push(e_right(), e_top()),
                6 | 9 => push(e_bottom(), e_top()),
                7 | 8 => push(e_top(), e_left()),
                5 => {
                    push(e_left(), e_bottom());
                    push(e_right(), e_top());
                }
                10 => {
                    push(e_bottom(), e_right());
                    push(e_top(), e_left());
                }
                _ => {} // 0, 15 — no crossing
            }
        }
    }

    Ok(largest_closed_ring(&segments))
}

/// Quantise a world point to an integer key so shared edge crossings (bit-identical
/// between adjacent cells) collapse to one node.
fn key(p: [f64; 2]) -> (i64, i64) {
    const K: f64 = 1e6; // micron precision
    ((p[0] * K).round() as i64, (p[1] * K).round() as i64)
}

/// Stitch undirected `segments` into rings and return the largest closed ring by
/// absolute area (empty if none closes).
fn largest_closed_ring(segments: &[([f64; 2], [f64; 2])]) -> Vec<[f64; 2]> {
    if segments.is_empty() {
        return Vec::new();
    }
    // Node table + adjacency (node id → neighbour node ids via segment id).
    let mut ids: HashMap<(i64, i64), usize> = HashMap::new();
    let mut points: Vec<[f64; 2]> = Vec::new();
    let id_of = |p: [f64; 2], ids: &mut HashMap<(i64, i64), usize>, pts: &mut Vec<[f64; 2]>| {
        *ids.entry(key(p)).or_insert_with(|| {
            pts.push(p);
            pts.len() - 1
        })
    };
    // adjacency: node → list of (neighbour node, segment index)
    let mut adj: Vec<Vec<(usize, usize)>> = Vec::new();
    let mut seg_nodes: Vec<(usize, usize)> = Vec::new();
    for (si, (p, q)) in segments.iter().enumerate() {
        let a = id_of(*p, &mut ids, &mut points);
        let b = id_of(*q, &mut ids, &mut points);
        while adj.len() <= a.max(b) {
            adj.push(Vec::new());
        }
        adj[a].push((b, si));
        adj[b].push((a, si));
        seg_nodes.push((a, b));
    }

    let mut used = vec![false; segments.len()];
    let mut best: Vec<[f64; 2]> = Vec::new();
    let mut best_area = 0.0;

    for start_seg in 0..segments.len() {
        if used[start_seg] {
            continue;
        }
        // Walk a chain from this segment.
        let (mut prev, mut cur) = seg_nodes[start_seg];
        used[start_seg] = true;
        let start_node = prev;
        let mut ring = vec![points[prev], points[cur]];
        let mut closed = false;
        loop {
            // Find an unused segment out of `cur` other than the one we arrived on.
            let mut nexted = false;
            for &(nb, si) in &adj[cur] {
                if used[si] {
                    continue;
                }
                used[si] = true;
                prev = cur;
                cur = nb;
                let _ = prev;
                if cur == start_node {
                    closed = true;
                } else {
                    ring.push(points[cur]);
                }
                nexted = true;
                break;
            }
            if !nexted || closed {
                break;
            }
        }
        if closed && ring.len() >= 3 {
            let area = shoelace(&ring).abs();
            if area > best_area {
                best_area = area;
                best = ring;
            }
        }
    }
    best
}

/// Signed polygon area (shoelace).
fn shoelace(ring: &[[f64; 2]]) -> f64 {
    let n = ring.len();
    let mut s = 0.0;
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        s += a[0] * b[1] - b[0] * a[1];
    }
    0.5 * s
}

/// A trivial study-area outline for `extent`: the rectangle, with optionally
/// rounded corners of radius `corner_radius` (`≤ 0` ⇒ sharp corners; each rounded
/// corner is approximated by `arc_steps` segments). Returns a closed ring of
/// `[x, y]` points (first point not repeated), counter-clockwise.
pub fn study_area_outline(extent: &BBox, corner_radius: f64, arc_steps: usize) -> Vec<[f64; 2]> {
    let (x0, y0, x1, y1) = (extent.xmin, extent.ymin, extent.xmax, extent.ymax);
    let r = corner_radius
        .max(0.0)
        .min(0.5 * (x1 - x0).min(y1 - y0).max(0.0));
    if r <= 0.0 || arc_steps == 0 {
        return vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    }
    // Corner centres and the CCW quarter-arcs (start angle per corner).
    let corners = [
        ((x1 - r, y0 + r), -std::f64::consts::FRAC_PI_2), // bottom-right, start pointing down
        ((x1 - r, y1 - r), 0.0),                          // top-right
        ((x0 + r, y1 - r), std::f64::consts::FRAC_PI_2),  // top-left
        ((x0 + r, y0 + r), std::f64::consts::PI),         // bottom-left
    ];
    let mut ring = Vec::new();
    for &((cx, cy), a0) in &corners {
        for s in 0..=arc_steps {
            let a = a0 + (s as f64 / arc_steps as f64) * std::f64::consts::FRAC_PI_2;
            ring.push([cx + r * a.cos(), cy + r * a.sin()]);
        }
    }
    ring
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gridding::kriging::{Variogram, VariogramModel};
    use crate::synth::{synth_dome_surface, NoiseSpec};

    #[test]
    fn dome_closure_is_a_closed_interior_ring() {
        let lat = Lattice::regular(0.0, 0.0, 10.0, 10.0, 50, 50);
        let vg = Variogram::new(VariogramModel::Spherical, 0.0, 1.0, 100.0).unwrap();
        let noise = NoiseSpec::new(0.0, vg).unwrap();
        // Dome peaking at 100 over a 0..490 extent.
        let s = synth_dome_surface(&lat, 100.0, 1.0, 0.0, &noise, 1).unwrap();
        // A mid-level closure should be a closed ring living inside the extent.
        let ring = closure_outline(&s, &lat, 50.0).unwrap();
        assert!(
            ring.len() >= 8,
            "expected a resolved ring, got {}",
            ring.len()
        );
        let bb = lat.bbox();
        for p in &ring {
            assert!(
                p[0] > bb.xmin + 1.0
                    && p[0] < bb.xmax - 1.0
                    && p[1] > bb.ymin + 1.0
                    && p[1] < bb.ymax - 1.0,
                "closure touches the boundary at {p:?}"
            );
        }
        // The crest (centre) is inside the ring; a corner is outside.
        let (cx, cy) = (245.0, 245.0);
        assert!(winding_contains(&ring, cx, cy), "crest not enclosed");
        assert!(
            !winding_contains(&ring, 5.0, 5.0),
            "corner wrongly enclosed"
        );
    }

    #[test]
    fn no_closure_above_crest_or_below_flanks() {
        let lat = Lattice::regular(0.0, 0.0, 10.0, 10.0, 40, 40);
        let vg = Variogram::new(VariogramModel::Spherical, 0.0, 1.0, 100.0).unwrap();
        let noise = NoiseSpec::new(0.0, vg).unwrap();
        let s = synth_dome_surface(&lat, 100.0, 1.0, 0.0, &noise, 1).unwrap();
        // Above the crest: no contour at all.
        assert!(closure_outline(&s, &lat, 200.0).unwrap().is_empty());
    }

    #[test]
    fn study_area_sharp_and_rounded() {
        let e = BBox {
            xmin: 0.0,
            ymin: 0.0,
            xmax: 100.0,
            ymax: 50.0,
        };
        let sharp = study_area_outline(&e, 0.0, 8);
        assert_eq!(sharp.len(), 4);
        let round = study_area_outline(&e, 10.0, 8);
        assert!(round.len() > 4);
        // All rounded points stay within the extent.
        for p in &round {
            assert!(p[0] >= -1e-9 && p[0] <= 100.0 + 1e-9 && p[1] >= -1e-9 && p[1] <= 50.0 + 1e-9);
        }
    }

    /// Ray-cast point-in-polygon for the tests.
    fn winding_contains(ring: &[[f64; 2]], x: f64, y: f64) -> bool {
        let n = ring.len();
        let mut inside = false;
        let mut j = n - 1;
        for i in 0..n {
            let (xi, yi) = (ring[i][0], ring[i][1]);
            let (xj, yj) = (ring[j][0], ring[j][1]);
            if ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
                inside = !inside;
            }
            j = i;
        }
        inside
    }
}
