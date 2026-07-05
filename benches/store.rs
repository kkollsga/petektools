//! Criterion benches for the `store` unit at a realistic (~50M-cell) scale.
//!
//! Three access patterns the out-of-core pipeline stresses (ruling R1):
//!   - **slab-sequential write** — the streaming build path (append k-slabs);
//!   - **slab-sequential read** — a full k-slab pipeline pass over the store;
//!   - **random-window read** — the viewer / consumer windowed random access.
//!
//! Scale: one `f32` lane of `nslabs · elems_per_slab ≈ 50M` elements (~200 MB),
//! matching a 50M-cell property cube. Big benches use a small sample size — the
//! signal is throughput per iteration, not micro-timing.

use criterion::{criterion_group, criterion_main, BatchSize, Criterion, Throughput};
use petektools::store::{Dtype, LaneSpec, Store, StoreSchema, StoreWriter};
use std::hint::black_box;
use std::path::PathBuf;

// 500 slabs × 100_000 elems = 50_000_000 f32 (~200 MB) — a 50M-cell lane.
const NSLABS: u64 = 500;
const ELEMS_PER_SLAB: u64 = 100_000;
const LANE: &str = "PORO";

fn tmp_path(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("pt_store_bench_{tag}_{}.pts", std::process::id()))
}

fn schema() -> StoreSchema {
    StoreSchema::new(
        NSLABS,
        vec![LaneSpec::slab(LANE, Dtype::F32, ELEMS_PER_SLAB)],
    )
}

/// Build a finalized store on disk (fixture for the read benches).
fn build_fixture(path: &std::path::Path) {
    let mut w = StoreWriter::create(path, schema()).unwrap();
    let slab: Vec<f32> = (0..ELEMS_PER_SLAB).map(|i| i as f32).collect();
    for k in 0..NSLABS {
        w.write_slab_f32(LANE, k, &slab).unwrap();
    }
    w.finalize().unwrap();
}

fn bench_write(c: &mut Criterion) {
    let total = NSLABS * ELEMS_PER_SLAB;
    let slab: Vec<f32> = (0..ELEMS_PER_SLAB).map(|i| i as f32).collect();
    let mut g = c.benchmark_group("store_write");
    g.throughput(Throughput::Bytes(total * 4));
    g.sample_size(10);
    g.bench_function("slab_sequential", |b| {
        b.iter_batched(
            || tmp_path("w"),
            |path| {
                let mut w = StoreWriter::create(&path, schema()).unwrap();
                for k in 0..NSLABS {
                    w.write_slab_f32(LANE, k, black_box(&slab)).unwrap();
                }
                w.finalize().unwrap();
                std::fs::remove_file(&path).ok();
            },
            BatchSize::PerIteration,
        )
    });
    g.finish();
}

/// The same streaming write, but with **flush-behind** on (msync + page-evict
/// each completed slab). Measures the write-throughput cost of bounding the
/// resident set — compare against `store_write/slab_sequential` above.
fn bench_write_flush_behind(c: &mut Criterion) {
    let total = NSLABS * ELEMS_PER_SLAB;
    let slab: Vec<f32> = (0..ELEMS_PER_SLAB).map(|i| i as f32).collect();
    let mut g = c.benchmark_group("store_write");
    g.throughput(Throughput::Bytes(total * 4));
    g.sample_size(10);
    g.bench_function("slab_sequential_flush_behind", |b| {
        b.iter_batched(
            || tmp_path("wfb"),
            |path| {
                let mut w = StoreWriter::create(&path, schema())
                    .unwrap()
                    .with_flush_behind(true);
                for k in 0..NSLABS {
                    w.write_slab_f32(LANE, k, black_box(&slab)).unwrap();
                }
                w.finalize().unwrap();
                std::fs::remove_file(&path).ok();
            },
            BatchSize::PerIteration,
        )
    });
    g.finish();
}

fn bench_read_sequential(c: &mut Criterion) {
    let path = tmp_path("rseq");
    build_fixture(&path);
    let store = Store::open(&path).unwrap();
    let total = NSLABS * ELEMS_PER_SLAB;
    let mut g = c.benchmark_group("store_read");
    g.throughput(Throughput::Bytes(total * 4));
    g.sample_size(20);
    g.bench_function("slab_sequential", |b| {
        b.iter(|| {
            // Sum every element so the whole lane is actually streamed off disk
            // (a bare first/last touch would only fault two pages per slab).
            let mut acc = 0.0f32;
            for k in 0..NSLABS {
                let s = store.slab_f32(LANE, k).unwrap();
                acc += s.iter().copied().sum::<f32>();
            }
            black_box(acc)
        })
    });
    g.finish();
    drop(store);
    std::fs::remove_file(&path).ok();
}

fn bench_read_random_window(c: &mut Criterion) {
    let path = tmp_path("rwin");
    build_fixture(&path);
    let store = Store::open(&path).unwrap();
    // 256 pseudo-random 8-slab windows (an LCG — no rng dep needed here).
    let win = 8u64;
    let mut state = 0x2545_F491_4F6C_DD1Du64;
    let windows: Vec<u64> = (0..256)
        .map(|_| {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 33) % (NSLABS - win)
        })
        .collect();
    let mut g = c.benchmark_group("store_read");
    g.throughput(Throughput::Bytes(
        windows.len() as u64 * win * ELEMS_PER_SLAB * 4,
    ));
    g.sample_size(20);
    g.bench_function("random_window", |b| {
        b.iter(|| {
            // Sum every element of each window (real windowed streaming reads).
            let mut acc = 0.0f32;
            for &start in &windows {
                let w = store.window_f32(LANE, start, start + win).unwrap();
                acc += w.iter().copied().sum::<f32>();
            }
            black_box(acc)
        })
    });
    g.finish();
    drop(store);
    std::fs::remove_file(&path).ok();
}

criterion_group!(
    benches,
    bench_write,
    bench_write_flush_behind,
    bench_read_sequential,
    bench_read_random_window
);
criterion_main!(benches);
