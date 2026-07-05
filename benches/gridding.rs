//! Minimum-curvature gridding benches.
//!
//! - Cold vs warm-start on a small scatter (mirrors petekio's bench:
//!   64 scattered points → a 40×40 lattice). The warm path re-solves from the
//!   prior cold field, so it converges in far fewer SOR iterations.
//! - **Conditioning-path cost** (`task_petektools_scatter_conditioning`): the
//!   per-solve cost of the off-node `Bilinear` conditioning vs the historical
//!   `NearestNode` snap, at a realistic dense-scatter control count (~23 k
//!   off-node samples on a 100×100 lattice). The warm path is the per-realization
//!   cost petekStatic pays; it must not blow up when honouring off-node data.
//!
//! Run with `cargo bench`; record the min times to
//! `dev-docs/bench/results/results.csv`.

use criterion::{criterion_group, criterion_main, Criterion};
use petektools::{
    grid, grid_min_curvature_conditioned, grid_min_curvature_seeded, Conditioning, GridMethod,
    Lattice, MinCurvatureOperator,
};
use std::hint::black_box;

/// 8×8 = 64 scattered samples over [0, 40]², from a smooth analytic field
/// (matches petekio's bench surface).
fn scatter() -> Vec<[f64; 3]> {
    let mut pts = Vec::with_capacity(64);
    for j in 0..8 {
        for i in 0..8 {
            let x = i as f64 * 5.0 + 2.5;
            let y = j as f64 * 5.0 + 2.5;
            let z = 1000.0 + 0.5 * x + 0.3 * y + 5.0 * ((x * 0.2).sin() + (y * 0.2).cos());
            pts.push([x, y, z]);
        }
    }
    pts
}

fn lattice_40() -> Lattice {
    Lattice::regular(0.0, 0.0, 1.0, 1.0, 40, 40)
}

fn bench(c: &mut Criterion) {
    let pts = scatter();
    let g = lattice_40();
    let cold = grid(&pts, &g, GridMethod::MinimumCurvature).unwrap();

    c.bench_function("min_curvature_cold_40x40", |b| {
        b.iter(|| grid(black_box(&pts), black_box(&g), GridMethod::MinimumCurvature).unwrap())
    });
    c.bench_function("min_curvature_warm_40x40", |b| {
        b.iter(|| {
            grid_min_curvature_seeded(black_box(&pts), black_box(&g), Some(black_box(&cold)))
                .unwrap()
        })
    });
}

/// Dense off-node scatter (~0.65× node spacing) over the full lattice extent —
/// the realistic sub-node conditioning input at a tens-of-thousands control count.
fn dense_scatter(spacing: f64, extent: f64) -> Vec<[f64; 3]> {
    let step = 0.65 * spacing;
    let mut pts = Vec::new();
    let mut y = 0.5 * step;
    while y < extent {
        let mut x = 0.4 * step;
        while x < extent {
            // A smooth dipping-plane + dome truth (off-node by construction).
            let z = 2000.0 + 0.02 * x
                - 0.015 * y
                - 60.0
                    * (-(((x - 5000.0) / 1500.0).powi(2) + ((y - 4000.0) / 1500.0).powi(2))).exp();
            pts.push([x, y, z]);
            x += step;
        }
        y += step;
    }
    pts
}

fn conditioning_bench(c: &mut Criterion) {
    const SPACING: f64 = 100.0;
    const N: usize = 100; // 100×100 nodes
    let extent = (N - 1) as f64 * SPACING;
    let g = Lattice::regular(0.0, 0.0, SPACING, SPACING, N, N);
    let pts = dense_scatter(SPACING, extent);

    // Converged seeds for the warm (per-realization) path.
    let warm_near =
        grid_min_curvature_conditioned(&pts, &g, None, Conditioning::NearestNode).unwrap();
    let warm_bil = grid_min_curvature_conditioned(&pts, &g, None, Conditioning::Bilinear).unwrap();

    let mut grp = c.benchmark_group(format!("conditioning_{}pts_{N}x{N}", pts.len()));
    // Cold solves are ~O(MAX_ITERS): sample a handful, not the default 100.
    grp.sample_size(10);
    grp.bench_function("cold_nearest", |b| {
        b.iter(|| {
            grid_min_curvature_conditioned(black_box(&pts), &g, None, Conditioning::NearestNode)
                .unwrap()
        })
    });
    grp.bench_function("cold_bilinear", |b| {
        b.iter(|| {
            grid_min_curvature_conditioned(black_box(&pts), &g, None, Conditioning::Bilinear)
                .unwrap()
        })
    });
    // Warm solves stop in ~1 sweep — the realistic per-realization cost.
    grp.sample_size(30);
    grp.bench_function("warm_nearest", |b| {
        b.iter(|| {
            grid_min_curvature_conditioned(
                black_box(&pts),
                &g,
                Some(black_box(&warm_near)),
                Conditioning::NearestNode,
            )
            .unwrap()
        })
    });
    grp.bench_function("warm_bilinear", |b| {
        b.iter(|| {
            grid_min_curvature_conditioned(
                black_box(&pts),
                &g,
                Some(black_box(&warm_bil)),
                Conditioning::Bilinear,
            )
            .unwrap()
        })
    });
    grp.finish();
}

/// Factor-once / solve-many (`MinCurvatureOperator`): the petekStatic MC path,
/// where many horizons share one sample `(x, y)` footprint and only the depths
/// are redrawn. Assemble+factor is paid once; each realization is a cheap
/// back-substitution. Sized at the convicted hotspot (~120² lattice, tens of
/// thousands of off-node samples).
fn operator_reuse_bench(c: &mut Criterion) {
    const SPACING: f64 = 100.0;
    const N: usize = 120;
    let extent = (N - 1) as f64 * SPACING;
    let g = Lattice::regular(0.0, 0.0, SPACING, SPACING, N, N);
    let pts = dense_scatter(SPACING, extent);
    let sample_xy: Vec<[f64; 2]> = pts.iter().map(|p| [p[0], p[1]]).collect();
    let z: Vec<f64> = pts.iter().map(|p| p[2]).collect();

    let mut grp = c.benchmark_group(format!("operator_{}pts_{N}x{N}", pts.len()));
    grp.sample_size(10);
    // The one-time cost: assemble + band-LU factor.
    grp.bench_function("factor", |b| {
        b.iter(|| {
            MinCurvatureOperator::factor(
                black_box(&g),
                black_box(&sample_xy),
                Conditioning::Bilinear,
            )
            .unwrap()
        })
    });
    // The per-realization cost the MC loop actually pays after factoring once.
    let op = MinCurvatureOperator::factor(&g, &sample_xy, Conditioning::Bilinear).unwrap();
    grp.sample_size(50);
    grp.bench_function("solve_per_horizon", |b| {
        b.iter(|| op.solve(black_box(&z)).unwrap())
    });
    grp.finish();
}

criterion_group!(benches, bench, conditioning_bench, operator_reuse_bench);
criterion_main!(benches);
