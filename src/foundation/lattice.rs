//! `Lattice` — a regular, rotatable areal lattice (the IRAP/RMS model) and its
//! forward/inverse coordinate maps.
//!
//! This is petekTools' own geometry vocabulary, kept **field-for-field
//! identical** to petekio's `foundation::GridGeometry` (and its `node_xy` /
//! `xy_to_ij` / `bbox` semantics) so that, if petekio later delegates its
//! gridding here, the boundary is a trivial 1:1 map rather than a reconciliation.
//! Parity is pinned by the golden test in `tests/lattice_parity.rs`, which
//! checks `node_xy` / `xy_to_ij` against petekio 0.2.0's `GridGeometry` formula.

use super::{AlgoError, Result};

/// An axis-aligned 2-D bounding box.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BBox {
    pub xmin: f64,
    pub ymin: f64,
    pub xmax: f64,
    pub ymax: f64,
}

/// A regular, rotatable areal lattice. Node `(i, j)` runs `i` along the
/// column/x axis (`ncol` nodes) and `j` along the row/y axis (`nrow` nodes).
#[derive(Debug, Clone, PartialEq)]
pub struct Lattice {
    /// Origin x (node 0,0).
    pub xori: f64,
    /// Origin y (node 0,0).
    pub yori: f64,
    /// Node spacing along the column/x axis.
    pub xinc: f64,
    /// Node spacing along the row/y axis.
    pub yinc: f64,
    /// Node count along x.
    pub ncol: usize,
    /// Node count along y.
    pub nrow: usize,
    /// Rotation in degrees, counter-clockwise of the I-axis from East.
    pub rotation_deg: f64,
    /// If true, the row/y axis is flipped (origin becomes the upper-left
    /// corner; y decreases along the row axis).
    pub yflip: bool,
}

impl Lattice {
    /// A non-rotated, non-flipped lattice from origin, spacing and node counts.
    pub fn regular(xori: f64, yori: f64, xinc: f64, yinc: f64, ncol: usize, nrow: usize) -> Self {
        Self {
            xori,
            yori,
            xinc,
            yinc,
            ncol,
            nrow,
            rotation_deg: 0.0,
            yflip: false,
        }
    }

    /// Build an intrinsically rotated/flipped lattice. Rotation is normalized
    /// into `[0, 360)` and must be finite. Existing [`regular`](Self::regular)
    /// construction remains the exact zero-rotation compatibility path.
    #[allow(clippy::too_many_arguments)]
    pub fn oriented(
        xori: f64,
        yori: f64,
        xinc: f64,
        yinc: f64,
        ncol: usize,
        nrow: usize,
        rotation_deg: f64,
        yflip: bool,
    ) -> Result<Self> {
        if !rotation_deg.is_finite() {
            return Err(AlgoError::InvalidArgument(
                "Lattice: rotation_deg must be finite".to_string(),
            ));
        }
        Ok(Self {
            xori,
            yori,
            xinc,
            yinc,
            ncol,
            nrow,
            rotation_deg: rotation_deg.rem_euclid(360.0),
            yflip,
        })
    }

    /// `+1.0` normally, `-1.0` when `yflip` is set.
    pub fn yflip_factor(&self) -> f64 {
        if self.yflip {
            -1.0
        } else {
            1.0
        }
    }

    /// World-coordinate step vectors for one positive intrinsic I and J node.
    pub fn step_vectors(&self) -> ([f64; 2], [f64; 2]) {
        let (s, c) = self.rotation_deg.to_radians().sin_cos();
        (
            [self.xinc * c, self.xinc * s],
            [
                -self.yinc * self.yflip_factor() * s,
                self.yinc * self.yflip_factor() * c,
            ],
        )
    }

    /// Exact affine transform from fractional intrinsic lattice coordinates
    /// `(fi, fj)` to world `(x, y)`.
    pub fn intrinsic_to_world(&self, fi: f64, fj: f64) -> (f64, f64) {
        let (step_i, step_j) = self.step_vectors();
        (
            self.xori + fi * step_i[0] + fj * step_j[0],
            self.yori + fi * step_i[1] + fj * step_j[1],
        )
    }

    /// World `(x, y)` of node `(i, j)`. `node_xy(0, 0) == (xori, yori)`.
    pub fn node_xy(&self, i: usize, j: usize) -> (f64, f64) {
        self.intrinsic_to_world(i as f64, j as f64)
    }

    /// Exact inverse affine transform from world `(x, y)` to fractional
    /// intrinsic lattice coordinates `(fi, fj)`. The result is not clipped to
    /// the node extent. `None` means the step-vector matrix is singular.
    pub fn world_to_intrinsic(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        let (step_i, step_j) = self.step_vectors();
        let det = step_i[0] * step_j[1] - step_i[1] * step_j[0];
        if !det.is_finite() || det.abs() < f64::EPSILON {
            return None;
        }
        let dx = x - self.xori;
        let dy = y - self.yori;
        Some((
            (dx * step_j[1] - dy * step_j[0]) / det,
            (step_i[0] * dy - step_i[1] * dx) / det,
        ))
    }

    /// Fractional node coordinates `(fi, fj)` for world `(x, y)` — the inverse
    /// of [`node_xy`](Self::node_xy). `None` for a degenerate (zero-spacing)
    /// geometry. The result may lie outside `[0, ncol-1] × [0, nrow-1]`.
    pub fn xy_to_ij(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        self.world_to_intrinsic(x, y)
    }

    /// Axis-aligned bounding box of all nodes.
    pub fn bbox(&self) -> BBox {
        let ni = self.ncol.saturating_sub(1);
        let nj = self.nrow.saturating_sub(1);
        let corners = [
            self.node_xy(0, 0),
            self.node_xy(ni, 0),
            self.node_xy(0, nj),
            self.node_xy(ni, nj),
        ];
        let xmin = corners.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
        let xmax = corners
            .iter()
            .map(|p| p.0)
            .fold(f64::NEG_INFINITY, f64::max);
        let ymin = corners.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
        let ymax = corners
            .iter()
            .map(|p| p.1)
            .fold(f64::NEG_INFINITY, f64::max);
        BBox {
            xmin,
            ymin,
            xmax,
            ymax,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn origin_and_roundtrip() {
        let g = Lattice::regular(1000.0, 2000.0, 25.0, 50.0, 10, 8);
        assert_eq!(g.node_xy(0, 0), (1000.0, 2000.0));
        let (x, y) = g.node_xy(3, 4);
        let (fi, fj) = g.xy_to_ij(x, y).unwrap();
        assert_relative_eq!(fi, 3.0, epsilon = 1e-9);
        assert_relative_eq!(fj, 4.0, epsilon = 1e-9);
    }

    #[test]
    fn rotation_roundtrips() {
        let mut g = Lattice::regular(0.0, 0.0, 10.0, 10.0, 5, 5);
        g.rotation_deg = 30.0;
        let (x, y) = g.node_xy(2, 1);
        let (fi, fj) = g.xy_to_ij(x, y).unwrap();
        assert_relative_eq!(fi, 2.0, epsilon = 1e-9);
        assert_relative_eq!(fj, 1.0, epsilon = 1e-9);
    }

    #[test]
    fn oriented_normalizes_and_fractional_transform_is_exact() {
        let g = Lattice::oriented(431_000.0, 6_521_000.0, 25.0, 40.0, 5, 4, 390.0, true).unwrap();
        assert_eq!(g.rotation_deg, 30.0);
        assert!(g.yflip);
        let (x, y) = g.intrinsic_to_world(1.25, 2.5);
        let (fi, fj) = g.world_to_intrinsic(x, y).unwrap();
        assert_relative_eq!(fi, 1.25, epsilon = 1e-10);
        assert_relative_eq!(fj, 2.5, epsilon = 1e-10);
        assert_eq!(g.node_xy(2, 1), g.intrinsic_to_world(2.0, 1.0));
        assert!(Lattice::oriented(0.0, 0.0, 1.0, 1.0, 2, 2, f64::NAN, false).is_err());
    }

    #[test]
    fn degenerate_geometry_has_no_inverse() {
        let g = Lattice::regular(0.0, 0.0, 0.0, 10.0, 5, 5);
        assert!(g.xy_to_ij(1.0, 1.0).is_none());
    }
}
