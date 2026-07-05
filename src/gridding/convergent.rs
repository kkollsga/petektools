//! `ConvergentGridder` — a stateful minimum-curvature gridder for interactive /
//! iterative re-gridding (petekSim's refinement loop).
//!
//! Holds the [`Lattice`], the current solved field, and the accumulated control
//! set. Each `add_control` / `add_controls` warm-starts the SOR from the held
//! field (via the L1 seeded kernel) instead of re-solving cold — far fewer
//! iterations for an incremental update, while converging to the same field a
//! cold solve would (`warm == cold` to the solver tolerance) and deterministic.
//!
//! **Note (parity / design):** this re-solves the **whole field** warm, not a
//! region-restricted solve — that is what preserves the `warm == cold`
//! continuity guarantee. See `dev-docs/designs/warm-start-gridding.md`.

use crate::foundation::{AlgoError, Lattice, Result};
use ndarray::Array2;
use std::collections::HashMap;

use super::min_curvature::grid_min_curvature;
use super::Conditioning;

/// Stateful minimum-curvature gridder. Built from a cold solve of an initial
/// scattered set; control points are then added incrementally and honoured as
/// hard constraints, each triggering a warm re-solve.
pub struct ConvergentGridder {
    lattice: Lattice,
    /// The original scatter plus every added control, each as a world-`[x, y, z]`
    /// row (a control at node `(ip, jp)` is stored at `node_xy(ip, jp)` so the
    /// kernel snaps it back to exactly that node and holds it fixed).
    coords: Vec<[f64; 3]>,
    /// Index into `coords` of the control held at each node `(ip, jp)`. Re-adding
    /// a control at a node already held rewrites its `coords` row in place, so the
    /// node honours the **latest** value as a hard constraint (rather than
    /// appending a second coincident sample the kernel would average in) and
    /// `coords` cannot grow without bound across a long interactive session.
    control_idx: HashMap<(usize, usize), usize>,
    /// The current solved field, `(ncol × nrow)`.
    field: Array2<f64>,
}

impl ConvergentGridder {
    /// Cold-solve `coords` onto `lattice` and seed the gridder with the result.
    /// Errors only on empty input (matching [`grid`](super::grid)).
    pub fn new(coords: &[[f64; 3]], lattice: &Lattice) -> Result<ConvergentGridder> {
        if coords.is_empty() {
            return Err(AlgoError::EmptyInput(
                "ConvergentGridder::new: no points to grid",
            ));
        }
        let field = grid_min_curvature(coords, lattice, None, Conditioning::NearestNode);
        Ok(ConvergentGridder {
            lattice: lattice.clone(),
            coords: coords.to_vec(),
            control_idx: HashMap::new(),
            field,
        })
    }

    /// Add one control: node `(ip, jp)` is held to `z` as a hard constraint, then
    /// the field is warm re-solved from its current state. Returns the updated
    /// field. A control whose `(ip, jp)` is off-lattice is dropped (the kernel
    /// ignores off-lattice samples), so the field is unchanged but for the solve.
    ///
    /// Re-controlling a node **replaces** its held value (the latest `z` wins);
    /// it does not average with the previous one.
    pub fn add_control(&mut self, ip: usize, jp: usize, z: f64) -> &Array2<f64> {
        self.add_controls(&[(ip, jp, z)])
    }

    /// Add several controls at once, then warm re-solve once. Equivalent (to the
    /// solver tolerance) to adding them one at a time, but cheaper (a single
    /// relaxation). Returns the updated field.
    ///
    /// In debug builds, an off-lattice `(ip, jp)` trips a `debug_assert!` to
    /// catch a caller bug early; in release it is silently dropped by the kernel.
    pub fn add_controls(&mut self, controls: &[(usize, usize, f64)]) -> &Array2<f64> {
        for &(ip, jp, z) in controls {
            debug_assert!(
                ip < self.lattice.ncol && jp < self.lattice.nrow,
                "ConvergentGridder control ({ip}, {jp}) is off-lattice ({}x{})",
                self.lattice.ncol,
                self.lattice.nrow
            );
            let (x, y) = self.lattice.node_xy(ip, jp);
            // Replace-by-node: rewrite the held row if this node is already a
            // control, else append and remember its slot. Keeps the latest value
            // as a hard constraint and bounds `coords` by the distinct control set.
            match self.control_idx.get(&(ip, jp)) {
                Some(&idx) => self.coords[idx] = [x, y, z],
                None => {
                    self.control_idx.insert((ip, jp), self.coords.len());
                    self.coords.push([x, y, z]);
                }
            }
        }
        self.field = grid_min_curvature(
            &self.coords,
            &self.lattice,
            Some(&self.field),
            Conditioning::NearestNode,
        );
        &self.field
    }

    /// The current solved field, `(ncol × nrow)`.
    pub fn field(&self) -> &Array2<f64> {
        &self.field
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_coords() -> [[f64; 3]; 5] {
        [
            [1.0, 1.0, 10.0],
            [9.0, 2.0, 25.0],
            [3.0, 8.0, 5.0],
            [10.0, 8.0, 40.0],
            [5.0, 5.0, 18.0],
        ]
    }

    #[test]
    fn new_empty_errors() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 5, 5);
        assert!(matches!(
            ConvergentGridder::new(&[], &lattice),
            Err(AlgoError::EmptyInput(_))
        ));
    }

    #[test]
    fn new_matches_cold_grid() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 12, 10);
        let coords = sample_coords();
        let g = ConvergentGridder::new(&coords, &lattice).unwrap();
        let cold = grid_min_curvature(&coords, &lattice, None, Conditioning::NearestNode);
        assert_eq!(g.field(), &cold);
    }

    #[test]
    fn added_control_is_honoured_as_hard_constraint() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 12, 10);
        let mut g = ConvergentGridder::new(&sample_coords(), &lattice).unwrap();
        let field = g.add_control(6, 7, 99.0);
        // The control node holds its value exactly (snapped + fixed).
        assert!((field[[6, 7]] - 99.0).abs() < 1e-9, "got {}", field[[6, 7]]);
    }

    #[test]
    fn incremental_matches_from_scratch_to_tolerance() {
        // Warm incremental add == a cold solve of (scatter + that control).
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 12, 10);
        let coords = sample_coords();
        let mut g = ConvergentGridder::new(&coords, &lattice).unwrap();
        let warm = g.add_control(6, 7, 99.0).clone();

        let (x, y) = lattice.node_xy(6, 7);
        let mut from_scratch: Vec<[f64; 3]> = coords.to_vec();
        from_scratch.push([x, y, 99.0]);
        let cold = grid_min_curvature(&from_scratch, &lattice, None, Conditioning::NearestNode);

        for (w, c) in warm.iter().zip(cold.iter()) {
            assert!((w - c).abs() < 1e-3, "warm {w} vs cold {c}");
        }
    }

    #[test]
    fn re_controlling_a_node_replaces_not_averages() {
        // The doc promises a control is honoured as a hard constraint. Re-controlling
        // the same node must therefore leave it at the NEW value, not average the
        // two: the old push-append behaviour appended a second coincident sample
        // that `grid_min_curvature` merged, snapping (6,7) to (99+50)/2 = 74.5.
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 12, 10);
        let mut g = ConvergentGridder::new(&sample_coords(), &lattice).unwrap();
        g.add_control(6, 7, 99.0);
        let field = g.add_control(6, 7, 50.0);
        assert!(
            (field[[6, 7]] - 50.0).abs() < 1e-9,
            "re-control must replace (hard constraint), got {}",
            field[[6, 7]]
        );
    }

    #[test]
    fn re_controlling_a_node_reuses_the_slot() {
        // Re-controlling one node must not grow `coords` unboundedly across a long
        // interactive session — the control replaces in place.
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 12, 10);
        let mut g = ConvergentGridder::new(&sample_coords(), &lattice).unwrap();
        let base = g.coords.len();
        for z in 0..50 {
            g.add_control(6, 7, z as f64);
        }
        assert_eq!(
            g.coords.len(),
            base + 1,
            "re-controlling one node must reuse its slot, not append"
        );
    }

    #[test]
    fn deterministic() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 12, 10);
        let mut a = ConvergentGridder::new(&sample_coords(), &lattice).unwrap();
        let mut b = ConvergentGridder::new(&sample_coords(), &lattice).unwrap();
        let fa = a.add_control(4, 4, 50.0).clone();
        let fb = b.add_control(4, 4, 50.0).clone();
        assert_eq!(fa, fb); // bit-identical: no RNG, fixed iteration order
    }

    #[test]
    fn batch_matches_sequential_to_tolerance() {
        let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 12, 10);
        let controls = [(6, 7, 99.0), (2, 2, -10.0), (9, 6, 33.0)];

        let mut batch = ConvergentGridder::new(&sample_coords(), &lattice).unwrap();
        let fb = batch.add_controls(&controls).clone();

        let mut seq = ConvergentGridder::new(&sample_coords(), &lattice).unwrap();
        for &(ip, jp, z) in &controls {
            seq.add_control(ip, jp, z);
        }
        let fs = seq.field();

        for (b, s) in fb.iter().zip(fs.iter()) {
            assert!((b - s).abs() < 1e-3, "batch {b} vs seq {s}");
        }
    }
}
