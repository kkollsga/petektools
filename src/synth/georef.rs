//! `Georef` — the fictional **world-frame** posture for a synthetic asset.
//!
//! Real subsurface data lives in a projected world frame (UTM-style eastings and
//! northings in the hundred-thousands), never at a tidy local origin. A synthetic
//! asset that is to exercise real *frame* behaviour must carry that posture — the
//! frame escapes this module feeds (suite testing doctrine, R1) all trace back to
//! fixtures built in ONE tidy local frame, so a world/local confusion had nowhere
//! to show.
//!
//! In petekTools the georeference **is** the [`Lattice`]: house style keeps no
//! separate georef vocabulary — a lattice's `xori` / `yori` / `rotation_deg`
//! already place its nodes in the world, and every 2-D generator
//! ([`synth_dome_surface`](crate::synth::synth_dome_surface),
//! [`synth_isochore`](crate::synth::synth_isochore),
//! [`synth_trend_map`](crate::synth::synth_trend_map),
//! [`tops_from_surface`](crate::synth::tops_from_surface),
//! [`closure_outline`](crate::synth::closure_outline)) already honours it by
//! working through `node_xy` / `xy_to_ij`. **World frame is therefore the default
//! posture** — hand any generator a world-placed lattice / extent / wellhead and it
//! stays in the world.
//!
//! `Georef` adds no new coordinate model. It is a thin *synthesis convenience* over
//! that default: a fictional world origin that (a) builds a world-placed
//! [`Lattice`] for a chosen grid shape, and (b) translates a locally-built point /
//! extent into the same world frame — the `build-local → place-in-world` idiom an
//! R1 fixture uses to prove a producer→consumer seam is frame-honest. A
//! `Georef`-built lattice is an ordinary [`Lattice`]; nothing downstream can tell
//! it apart from one written `Lattice::regular(431_000.0, …)` by hand.
//!
//! Derived independently; no third-party code was consulted.

use crate::foundation::{AlgoError, BBox, Lattice, Result};

/// A documented **fictional** world origin (a plausible North Sea-style easting /
/// northing) for demos and frame tests. Nothing real — a synthetic posture.
pub const FICTIONAL_ORIGIN: [f64; 2] = [431_000.0, 6_521_000.0];

/// A fictional world-frame origin: the `(east, north)` a locally-built synthetic
/// structure is placed at. Convenience only — see the module docs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Georef {
    /// World easting of the local origin (`x`).
    pub east0: f64,
    /// World northing of the local origin (`y`).
    pub north0: f64,
}

impl Georef {
    /// A world-frame origin at `(east0, north0)`. Errors unless both are finite.
    pub fn new(east0: f64, north0: f64) -> Result<Georef> {
        if !(east0.is_finite() && north0.is_finite()) {
            return Err(AlgoError::InvalidArgument(
                "Georef: east0 and north0 must be finite".to_string(),
            ));
        }
        Ok(Georef { east0, north0 })
    }

    /// The documented [`FICTIONAL_ORIGIN`] — the default world posture for demos
    /// and frame tests.
    pub fn fictional() -> Georef {
        Georef {
            east0: FICTIONAL_ORIGIN[0],
            north0: FICTIONAL_ORIGIN[1],
        }
    }

    /// The origin as an `[east, north]` world point.
    pub fn origin(&self) -> [f64; 2] {
        [self.east0, self.north0]
    }

    /// A non-rotated, non-flipped [`Lattice`] of `ncol × nrow` nodes at spacing
    /// `(xinc, yinc)`, its node `(0, 0)` pinned to this world origin — the direct
    /// way to build a surface generator's grid already in the world frame.
    pub fn lattice(&self, xinc: f64, yinc: f64, ncol: usize, nrow: usize) -> Lattice {
        Lattice::regular(self.east0, self.north0, xinc, yinc, ncol, nrow)
    }

    /// Build a lattice with an intrinsic rotation/flipped J axis at this world
    /// origin. Rotation is normalized by [`Lattice::oriented`].
    pub fn oriented_lattice(
        &self,
        xinc: f64,
        yinc: f64,
        ncol: usize,
        nrow: usize,
        rotation_deg: f64,
        yflip: bool,
    ) -> Result<Lattice> {
        Lattice::oriented(
            self.east0,
            self.north0,
            xinc,
            yinc,
            ncol,
            nrow,
            rotation_deg,
            yflip,
        )
    }

    /// Place an intrinsic/local distance vector through the same rotated/flipped
    /// orientation used by [`oriented_lattice`](Self::oriented_lattice), then
    /// translate it to this world origin. Callers convert fractional indices to
    /// distances first (`[fi * xinc, fj * yinc]`).
    pub fn place_intrinsic(
        &self,
        intrinsic: [f64; 2],
        rotation_deg: f64,
        yflip: bool,
    ) -> Result<[f64; 2]> {
        let frame = self.oriented_lattice(1.0, 1.0, 1, 1, rotation_deg, yflip)?;
        let (x, y) = frame.intrinsic_to_world(intrinsic[0], intrinsic[1]);
        Ok([x, y])
    }

    /// Translate a **local** `[x, y]` (measured from `(0, 0)`) into this world
    /// frame: `[east0 + x, north0 + y]`.
    pub fn place_point(&self, local: [f64; 2]) -> [f64; 2] {
        [self.east0 + local[0], self.north0 + local[1]]
    }

    /// Translate a list of local `[x, y]` points into this world frame (order
    /// preserved).
    pub fn place_points(&self, locals: &[[f64; 2]]) -> Vec<[f64; 2]> {
        locals.iter().map(|&p| self.place_point(p)).collect()
    }

    /// Translate a **local** extent into this world frame (shifted by the origin;
    /// the extent's shape is unchanged).
    pub fn place_extent(&self, local: &BBox) -> BBox {
        BBox {
            xmin: self.east0 + local.xmin,
            ymin: self.north0 + local.ymin,
            xmax: self.east0 + local.xmax,
            ymax: self.north0 + local.ymax,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn fictional_origin_places_lattice_in_world() {
        let g = Georef::fictional();
        assert_eq!(g.origin(), FICTIONAL_ORIGIN);
        let lat = g.lattice(100.0, 100.0, 5, 7);
        assert_eq!(lat.node_xy(0, 0), (431_000.0, 6_521_000.0));
        assert_eq!(lat.ncol, 5);
        assert_eq!(lat.nrow, 7);
        // node (2,3) is the local offset added to the world origin.
        let (x, y) = lat.node_xy(2, 3);
        assert_eq!((x, y), (431_000.0 + 200.0, 6_521_000.0 + 300.0));
    }

    #[test]
    fn point_and_extent_translate_by_origin() {
        let g = Georef::new(431_000.0, 6_521_000.0).unwrap();
        assert_eq!(g.place_point([12.0, 34.0]), [431_012.0, 6_521_034.0]);
        let pts = g.place_points(&[[0.0, 0.0], [10.0, 20.0]]);
        assert_eq!(
            pts,
            vec![[431_000.0, 6_521_000.0], [431_010.0, 6_521_020.0]]
        );
        let e = g.place_extent(&BBox {
            xmin: 0.0,
            ymin: 0.0,
            xmax: 400.0,
            ymax: 600.0,
        });
        assert_eq!(
            e,
            BBox {
                xmin: 431_000.0,
                ymin: 6_521_000.0,
                xmax: 431_400.0,
                ymax: 6_521_600.0,
            }
        );
    }

    #[test]
    fn oriented_lattice_and_intrinsic_point_share_one_frame() {
        let g = Georef::new(431_000.0, 6_521_000.0).unwrap();
        let lattice = g.oriented_lattice(25.0, 40.0, 4, 3, 30.0, true).unwrap();
        let expected = lattice.intrinsic_to_world(2.0, 1.0);
        let placed = g.place_intrinsic([50.0, 40.0], 30.0, true).unwrap();
        assert_relative_eq!(placed[0], expected.0, epsilon = 1e-10);
        assert_relative_eq!(placed[1], expected.1, epsilon = 1e-10);
    }

    #[test]
    fn non_finite_origin_errors() {
        assert!(Georef::new(f64::NAN, 0.0).is_err());
        assert!(Georef::new(0.0, f64::INFINITY).is_err());
    }
}
