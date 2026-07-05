//! **Resimulate** at scale: a multi-layer sequential-Gaussian sweep, one-shot
//! path vs. the reusing [`SgsSession`].
//!
//! The workload mirrors interactive resimulate — rebuilding a property model
//! layer by layer. The lattice geometry, variogram, and search neighbourhood are
//! identical across layers; only the conditioning point values/membership differ.
//! We sweep `LAYERS` layers of a `SIDE × SIDE` lattice (~1M cells total) with a
//! few hundred conditioning points each, comparing:
//!
//! - **old** — a fresh [`sgs`] call per layer (re-allocates the informed-node
//!   arrays, the visiting path, and every per-node kriging solver matrix), and
//! - **session** — one [`SgsSession`] whose retained scratch is threaded through
//!   every layer (no per-layer / per-node solver allocation).
//!
//! Both produce bit-for-bit identical fields (asserted in the unit tests); this
//! measures only the allocation-restructure delta. Run with `cargo bench --bench
//! geostat`; record the min times to `dev-docs/bench/results/results.csv`.

use criterion::{criterion_group, criterion_main, Criterion};
use petektools::geostat::{sgs, SgsParams, SgsSession};
use petektools::{Lattice, Variogram, VariogramModel};
use std::hint::black_box;

/// Lattice side (nodes). `SIDE² · LAYERS` ≈ the total cell budget.
const SIDE: usize = 200;
/// Layers in the sweep. 200×200×25 = 1_000_000 cells.
const LAYERS: usize = 25;
/// Conditioning points per layer.
const PTS_PER_LAYER: usize = 300;

fn lattice() -> Lattice {
    Lattice::regular(0.0, 0.0, 1.0, 1.0, SIDE, SIDE)
}

fn variogram() -> Variogram {
    // Unit sill (normal-score space), no nugget, range ~1/5 of the field.
    Variogram::new(VariogramModel::Spherical, 0.0, 1.0, SIDE as f64 / 5.0).unwrap()
}

/// Deterministic per-layer conditioning: `PTS_PER_LAYER` pseudo-random points
/// spread over the field, whose positions AND values shift with the layer index
/// (so both the fixed-node membership and the normal-score transform differ per
/// layer — the resimulate reality).
fn layer_data(k: usize) -> Vec<[f64; 3]> {
    let mut s: u64 = 0x9E37_79B9_7F4A_7C15 ^ ((k as u64).wrapping_mul(0x1234_5678_9ABC_DEF1));
    let mut next = || {
        // xorshift64* for a dependency-free reproducible spread in [0, 1).
        s ^= s >> 12;
        s ^= s << 25;
        s ^= s >> 27;
        ((s.wrapping_mul(0x2545_F491_4F6C_DD1D)) >> 11) as f64 / (1u64 << 53) as f64
    };
    let extent = (SIDE - 1) as f64;
    (0..PTS_PER_LAYER)
        .map(|_| {
            let x = next() * extent;
            let y = next() * extent;
            let z = 10.0 + 40.0 * next() + k as f64 * 2.0;
            [x, y, z]
        })
        .collect()
}

fn bench(c: &mut Criterion) {
    let lat = lattice();
    let vg = variogram();
    let layers: Vec<Vec<[f64; 3]>> = (0..LAYERS).map(layer_data).collect();

    // Two neighbourhood regimes: a *light* search (small max_n / tight radius —
    // the interactive-resim regime, where the fixed per-node allocation the
    // session eliminates is a meaningful share of the cheap per-node solve) and a
    // *heavy* search (where the O(n²–n³) matrix assembly + LU dominates and the
    // eliminated allocation falls into the noise). Honest headline: the session's
    // win shrinks as the neighbourhood grows.
    let configs: [(&str, usize, f64); 2] = [
        ("max_n8_r12", 8, SIDE as f64 / 16.0),
        ("max_n24_r50", 24, SIDE as f64 / 4.0),
    ];

    let mut group = c.benchmark_group("resimulate_sweep_200x200_25layers");
    // A full sweep is heavy; keep the sample count modest.
    group.sample_size(10);

    for (tag, max_n, radius) in configs {
        // Old path: a fresh `sgs` call (fresh scratch) per layer.
        group.bench_function(format!("old_per_layer/{tag}"), |b| {
            b.iter(|| {
                let mut acc = 0.0;
                for (k, data) in layers.iter().enumerate() {
                    let params = SgsParams::new(vg, max_n, radius, 100 + k as u64).unwrap();
                    let field = sgs(black_box(data), black_box(&lat), black_box(&params)).unwrap();
                    acc += field[[0, 0]];
                }
                black_box(acc)
            })
        });

        // Session path: one session, retained scratch across all layers.
        group.bench_function(format!("session/{tag}"), |b| {
            b.iter(|| {
                let mut session = SgsSession::new(lat.clone(), vg, max_n, radius).unwrap();
                let mut acc = 0.0;
                for (k, data) in layers.iter().enumerate() {
                    let field = session.simulate(black_box(data), 100 + k as u64).unwrap();
                    acc += field[[0, 0]];
                }
                black_box(acc)
            })
        });
    }

    group.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
