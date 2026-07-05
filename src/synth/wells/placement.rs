//! Well placement — seeded uniform-random heads in a rectangular extent or an
//! arbitrary polygon (rejection sampling).

use crate::foundation::{AlgoError, BBox, Result};
use crate::sampling::seeded_rng;
use rand::RngExt;

/// Place `n` seeded uniform-random well heads inside a rectangular `extent`.
/// Returns `[x, y]` rows. Errors on a degenerate extent (`xmin ≥ xmax` or
/// `ymin ≥ ymax`, or non-finite). Bit-reproducible per `seed`.
pub fn place_wells(extent: &BBox, n: usize, seed: u64) -> Result<Vec<[f64; 2]>> {
    if !(extent.xmin.is_finite()
        && extent.xmax.is_finite()
        && extent.ymin.is_finite()
        && extent.ymax.is_finite())
        || extent.xmin >= extent.xmax
        || extent.ymin >= extent.ymax
    {
        return Err(AlgoError::InvalidArgument(
            "place_wells: need a non-degenerate finite extent".to_string(),
        ));
    }
    let mut rng = seeded_rng(seed);
    Ok((0..n)
        .map(|_| {
            [
                rng.random_range(extent.xmin..extent.xmax),
                rng.random_range(extent.ymin..extent.ymax),
            ]
        })
        .collect())
}

/// `true` if `[x, y]` lies inside the closed `polygon` (ray-casting; vertices in
/// order, the ring is implicitly closed).
pub(super) fn point_in_polygon(x: f64, y: f64, polygon: &[[f64; 2]]) -> bool {
    let n = polygon.len();
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (polygon[i][0], polygon[i][1]);
        let (xj, yj) = (polygon[j][0], polygon[j][1]);
        if ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Place `n` seeded uniform-random well heads inside an arbitrary `polygon`
/// (rejection sampling within its bounding box). Returns `[x, y]` rows. Errors on
/// a polygon with < 3 vertices, a degenerate bounding box, or if `n` points cannot
/// be placed within a generous attempt budget (a near-zero-area polygon).
/// Bit-reproducible per `seed`.
pub fn place_wells_in_polygon(polygon: &[[f64; 2]], n: usize, seed: u64) -> Result<Vec<[f64; 2]>> {
    if polygon.len() < 3 {
        return Err(AlgoError::InvalidArgument(
            "place_wells_in_polygon: polygon needs >= 3 vertices".to_string(),
        ));
    }
    let xmin = polygon.iter().map(|p| p[0]).fold(f64::INFINITY, f64::min);
    let xmax = polygon
        .iter()
        .map(|p| p[0])
        .fold(f64::NEG_INFINITY, f64::max);
    let ymin = polygon.iter().map(|p| p[1]).fold(f64::INFINITY, f64::min);
    let ymax = polygon
        .iter()
        .map(|p| p[1])
        .fold(f64::NEG_INFINITY, f64::max);
    if !(xmin.is_finite() && xmax.is_finite() && ymin.is_finite() && ymax.is_finite())
        || xmin >= xmax
        || ymin >= ymax
    {
        return Err(AlgoError::InvalidArgument(
            "place_wells_in_polygon: polygon bounding box is degenerate".to_string(),
        ));
    }
    let mut rng = seeded_rng(seed);
    let mut out = Vec::with_capacity(n);
    let budget = n.saturating_mul(10_000).max(10_000);
    let mut attempts = 0;
    while out.len() < n {
        if attempts >= budget {
            return Err(AlgoError::InvalidArgument(
                "place_wells_in_polygon: could not place all wells (polygon area too small?)"
                    .to_string(),
            ));
        }
        attempts += 1;
        let x = rng.random_range(xmin..xmax);
        let y = rng.random_range(ymin..ymax);
        if point_in_polygon(x, y, polygon) {
            out.push([x, y]);
        }
    }
    Ok(out)
}
