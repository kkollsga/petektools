//! Integration tests for the `store` unit: round-trip bit-exactness per dtype,
//! deterministic layout, loud header/version failures, partial-write detection,
//! windowed reads, ndarray-view cross-checks, and typed error paths.

use petektools::foundation::AlgoError;
use petektools::store::{Dtype, LaneSpec, Store, StoreSchema, StoreWriter};
use std::path::PathBuf;

fn tmp(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "pt_store_test_{tag}_{}_{:p}.pts",
        std::process::id(),
        &tag as *const _
    ))
}

/// Round-trip a store with every dtype (slab + flat) and assert bit-exactness.
#[test]
fn round_trips_every_dtype_bit_exact() {
    let p = tmp("dtypes");
    let (nslabs, eps) = (4u64, 6u64);
    let schema = StoreSchema::new(
        nslabs,
        vec![
            LaneSpec::slab("f32lane", Dtype::F32, eps),
            LaneSpec::slab("f64lane", Dtype::F64, eps),
            LaneSpec::slab("u32lane", Dtype::U32, eps),
            LaneSpec::slab("u16lane", Dtype::U16, eps),
            LaneSpec::flat("f32flat", Dtype::F32, 5),
        ],
    );
    let mut w = StoreWriter::create(&p, schema).unwrap();
    // Include NaN / infinities to prove opaque bit preservation.
    for k in 0..nslabs {
        let base = (k * eps) as f32;
        let f32s: Vec<f32> = (0..eps)
            .map(|i| if i == 0 { f32::NAN } else { base + i as f32 })
            .collect();
        let f64s: Vec<f64> = (0..eps)
            .map(|i| {
                if i == 1 {
                    f64::NEG_INFINITY
                } else {
                    (base as f64) + i as f64
                }
            })
            .collect();
        let u32s: Vec<u32> = (0..eps).map(|i| (k * eps + i) as u32 * 7).collect();
        let u16s: Vec<u16> = (0..eps).map(|i| (k * eps + i) as u16).collect();
        w.write_slab_f32("f32lane", k, &f32s).unwrap();
        w.write_slab_f64("f64lane", k, &f64s).unwrap();
        w.write_slab_u32("u32lane", k, &u32s).unwrap();
        w.write_slab_u16("u16lane", k, &u16s).unwrap();
    }
    w.write_flat_f32("f32flat", &[1.0, 2.0, 3.0, 4.0, 5.0])
        .unwrap();
    w.finalize().unwrap();

    let s = Store::open(&p).unwrap();
    assert_eq!(s.nslabs(), nslabs);
    assert_eq!(s.lanes().len(), 5);
    for k in 0..nslabs {
        let base = (k * eps) as f32;
        let f32s = s.slab_f32("f32lane", k).unwrap();
        assert!(f32s[0].is_nan()); // NaN bit preserved
        assert_eq!(f32s[1], base + 1.0);
        let f64s = s.slab_f64("f64lane", k).unwrap();
        assert_eq!(f64s[1], f64::NEG_INFINITY);
        let u32s = s.slab_u32("u32lane", k).unwrap();
        assert_eq!(u32s[2], (k * eps + 2) as u32 * 7);
        let u16s = s.slab_u16("u16lane", k).unwrap();
        assert_eq!(u16s[3], (k * eps + 3) as u16);
    }
    assert_eq!(s.flat_f32("f32flat").unwrap(), &[1.0, 2.0, 3.0, 4.0, 5.0]);
    std::fs::remove_file(&p).ok();
}

/// Two identical writes must produce byte-identical files (deterministic layout).
#[test]
fn deterministic_layout_identical_bytes() {
    let (a, b) = (tmp("det_a"), tmp("det_b"));
    let build = |path: &PathBuf| {
        let schema = StoreSchema::new(
            3,
            vec![
                LaneSpec::slab("ZCORN", Dtype::F32, 8),
                LaneSpec::slab("PORO", Dtype::F32, 2),
                LaneSpec::flat("COORD", Dtype::F32, 4),
            ],
        )
        .with_app(serde_json::json!({"ni": 1, "nj": 1, "nk": 3}));
        let mut w = StoreWriter::create(path, schema).unwrap();
        for k in 0..3 {
            w.write_slab_f32("ZCORN", k, &[k as f32; 8]).unwrap();
            w.write_slab_f32("PORO", k, &[0.1, 0.2]).unwrap();
        }
        w.write_flat_f32("COORD", &[9.0, 8.0, 7.0, 6.0]).unwrap();
        w.finalize().unwrap();
    };
    build(&a);
    build(&b);
    let ba = std::fs::read(&a).unwrap();
    let bb = std::fs::read(&b).unwrap();
    assert_eq!(ba, bb, "identical schema + data must yield identical bytes");
    std::fs::remove_file(&a).ok();
    std::fs::remove_file(&b).ok();
}

/// A window `[start, end)` equals the concatenation of its slabs, and the
/// ndarray views agree with the direct slice reads.
#[test]
fn windows_and_ndarray_views_match_direct_reads() {
    let p = tmp("win");
    let (nslabs, eps) = (10u64, 4u64);
    let schema = StoreSchema::new(nslabs, vec![LaneSpec::slab("PORO", Dtype::F32, eps)]);
    let mut w = StoreWriter::create(&p, schema).unwrap();
    for k in 0..nslabs {
        let slab: Vec<f32> = (0..eps).map(|i| (k * eps + i) as f32).collect();
        w.write_slab_f32("PORO", k, &slab).unwrap();
    }
    w.finalize().unwrap();

    let s = Store::open(&p).unwrap();
    // window == concat of slabs
    let win = s.window_f32("PORO", 3, 7).unwrap();
    let mut concat = Vec::new();
    for k in 3..7 {
        concat.extend_from_slice(s.slab_f32("PORO", k).unwrap());
    }
    assert_eq!(win, concat.as_slice());
    // whole lane
    assert_eq!(s.lane_f32("PORO").unwrap().len(), (nslabs * eps) as usize);
    // ndarray views
    let v1 = s.slab_view_f32("PORO", 5).unwrap();
    assert_eq!(v1.as_slice().unwrap(), s.slab_f32("PORO", 5).unwrap());
    let v2 = s.window_view_f32("PORO", 3, 7).unwrap();
    assert_eq!(v2.shape(), &[4, eps as usize]);
    assert_eq!(
        v2.row(0).as_slice().unwrap(),
        s.slab_f32("PORO", 3).unwrap()
    );
    std::fs::remove_file(&p).ok();
}

/// A store that was never finalized reads back as a loud typed error.
#[test]
fn partial_write_is_detected() {
    let p = tmp("partial");
    let schema = StoreSchema::new(4, vec![LaneSpec::slab("PORO", Dtype::F32, 3)]);
    let mut w = StoreWriter::create(&p, schema).unwrap();
    w.write_slab_f32("PORO", 0, &[1.0, 2.0, 3.0]).unwrap();
    w.flush().unwrap();
    drop(w); // NO finalize → no seal
    match Store::open(&p) {
        Err(AlgoError::Parse(msg)) => assert!(msg.contains("not finalized"), "got: {msg}"),
        other => panic!("expected a not-finalized Parse error, got {other:?}"),
    }
    std::fs::remove_file(&p).ok();
}

/// Bad magic and a newer format version are refused loudly.
#[test]
fn rejects_bad_magic_and_newer_version() {
    let p = tmp("magic");
    std::fs::write(&p, b"XXXX....some bytes....").unwrap();
    assert!(matches!(Store::open(&p), Err(AlgoError::Parse(_))));
    // valid magic family but a newer hard version byte (0xFE > 0x01)
    std::fs::write(&p, b"PTS\xfe....some bytes....").unwrap();
    match Store::open(&p) {
        Err(AlgoError::Parse(msg)) => assert!(msg.contains("unsupported store format version")),
        other => panic!("expected unsupported-version Parse, got {other:?}"),
    }
    std::fs::remove_file(&p).ok();
}

/// A truncated (torn) file after finalize is detected as corrupt/truncated.
#[test]
fn truncated_file_is_detected() {
    let p = tmp("trunc");
    let schema = StoreSchema::new(4, vec![LaneSpec::slab("PORO", Dtype::F32, 100)]);
    let mut w = StoreWriter::create(&p, schema).unwrap();
    for k in 0..4 {
        w.write_slab_f32("PORO", k, &vec![1.0f32; 100]).unwrap();
    }
    w.finalize().unwrap();
    // Chop the file in half — the seal (at the end) is now gone.
    let bytes = std::fs::read(&p).unwrap();
    std::fs::write(&p, &bytes[..bytes.len() / 2]).unwrap();
    assert!(matches!(Store::open(&p), Err(AlgoError::Parse(_))));
    std::fs::remove_file(&p).ok();
}

/// The typed error paths: dtype mismatch, slab out of range, wrong length, wrong
/// lane kind, and an unknown lane.
#[test]
fn typed_error_paths_are_loud() {
    let p = tmp("errs");
    let schema = StoreSchema::new(
        3,
        vec![
            LaneSpec::slab("PORO", Dtype::F32, 4),
            LaneSpec::flat("COORD", Dtype::F32, 6),
        ],
    );
    let mut w = StoreWriter::create(&p, schema).unwrap();

    // wrong dtype accessor
    assert!(matches!(
        w.write_slab_f64("PORO", 0, &[0.0; 4]),
        Err(AlgoError::InvalidArgument(_))
    ));
    // wrong length
    assert!(matches!(
        w.write_slab_f32("PORO", 0, &[0.0; 3]),
        Err(AlgoError::InvalidArgument(_))
    ));
    // slab out of range
    assert!(matches!(
        w.write_slab_f32("PORO", 99, &[0.0; 4]),
        Err(AlgoError::InvalidArgument(_))
    ));
    // slab op on a flat lane
    assert!(matches!(
        w.write_slab_f32("COORD", 0, &[0.0; 4]),
        Err(AlgoError::InvalidArgument(_))
    ));
    // flat op on a slab lane
    assert!(matches!(
        w.write_flat_f32("PORO", &[0.0; 12]),
        Err(AlgoError::InvalidArgument(_))
    ));
    // unknown lane
    assert!(matches!(
        w.write_slab_f32("NOPE", 0, &[0.0; 4]),
        Err(AlgoError::NotFound(_))
    ));

    // fill validly and finalize so the reader-side checks can run too
    for k in 0..3 {
        w.write_slab_f32("PORO", k, &[0.0; 4]).unwrap();
    }
    w.write_flat_f32("COORD", &[0.0; 6]).unwrap();
    w.finalize().unwrap();

    let s = Store::open(&p).unwrap();
    assert!(matches!(
        s.slab_f64("PORO", 0),
        Err(AlgoError::InvalidArgument(_))
    ));
    assert!(matches!(
        s.window_f32("PORO", 2, 99),
        Err(AlgoError::InvalidArgument(_))
    ));
    assert!(matches!(
        s.flat_f32("PORO"),
        Err(AlgoError::InvalidArgument(_))
    ));
    assert!(matches!(s.slab_f32("NOPE", 0), Err(AlgoError::NotFound(_))));
    std::fs::remove_file(&p).ok();
}

/// The in-place mutable slab view is an alternative fill path (streaming).
#[test]
fn slab_mut_in_place_fill() {
    let p = tmp("inplace");
    let schema = StoreSchema::new(2, vec![LaneSpec::slab("PORO", Dtype::F32, 3)]);
    let mut w = StoreWriter::create(&p, schema).unwrap();
    for k in 0..2 {
        let slab = w.slab_mut_f32("PORO", k).unwrap();
        for (i, v) in slab.iter_mut().enumerate() {
            *v = (k as f32) * 10.0 + i as f32;
        }
    }
    w.finalize().unwrap();
    let s = Store::open(&p).unwrap();
    assert_eq!(s.slab_f32("PORO", 1).unwrap(), &[10.0, 11.0, 12.0]);
    std::fs::remove_file(&p).ok();
}

/// Flush-behind must not change a single output byte (the store stays
/// byte-deterministic) and the store still reads back bit-exact.
#[test]
fn flush_behind_is_byte_identical_and_reads_back() {
    let (a, b) = (tmp("fb_off"), tmp("fb_on"));
    let (nslabs, eps) = (8u64, 1024u64);
    let build = |path: &PathBuf, flush_behind: bool| {
        let schema = StoreSchema::new(
            nslabs,
            vec![
                LaneSpec::slab("PORO", Dtype::F32, eps),
                LaneSpec::slab("ZONE", Dtype::U16, eps),
                LaneSpec::flat("COORD", Dtype::F32, 16),
            ],
        )
        .with_app(serde_json::json!({"ni": 32, "nj": 32, "nk": nslabs}));
        let mut w = StoreWriter::create(path, schema)
            .unwrap()
            .with_flush_behind(flush_behind);
        assert_eq!(w.flush_behind_enabled(), flush_behind);
        for k in 0..nslabs {
            let poro: Vec<f32> = (0..eps).map(|i| (k * eps + i) as f32 * 0.5).collect();
            let zone: Vec<u16> = (0..eps).map(|i| ((k * eps + i) % 7) as u16).collect();
            w.write_slab_f32("PORO", k, &poro).unwrap();
            w.write_slab_u16("ZONE", k, &zone).unwrap();
        }
        w.write_flat_f32("COORD", &[1.5f32; 16]).unwrap();
        w.finalize().unwrap();
    };
    build(&a, false);
    build(&b, true);
    assert_eq!(
        std::fs::read(&a).unwrap(),
        std::fs::read(&b).unwrap(),
        "flush-behind must not change a single byte (byte-determinism)"
    );
    // The flush-behind store reads back bit-exact (evicted pages re-fault the
    // identical on-disk bytes).
    let s = Store::open(&b).unwrap();
    for k in 0..nslabs {
        assert_eq!(
            s.slab_f32("PORO", k).unwrap()[3],
            (k * eps + 3) as f32 * 0.5
        );
        assert_eq!(
            s.slab_u16("ZONE", k).unwrap()[5],
            ((k * eps + 5) % 7) as u16
        );
    }
    assert_eq!(s.flat_f32("COORD").unwrap(), &[1.5f32; 16]);
    std::fs::remove_file(&a).ok();
    std::fs::remove_file(&b).ok();
}

/// The in-place `slab_mut_*` streaming fill + the explicit `flush_behind_slab`
/// hook (the eviction path for callers that fill views rather than pass slices).
#[test]
fn flush_behind_slab_explicit_in_place_path() {
    let p = tmp("fb_inplace");
    let schema = StoreSchema::new(4, vec![LaneSpec::slab("PORO", Dtype::F32, 256)]);
    let mut w = StoreWriter::create(&p, schema)
        .unwrap()
        .with_flush_behind(true);
    for k in 0..4 {
        {
            let slab = w.slab_mut_f32("PORO", k).unwrap();
            for (i, v) in slab.iter_mut().enumerate() {
                *v = k as f32 + i as f32 * 0.01;
            }
        }
        // View dropped → persist + page-evict this slab.
        w.flush_behind_slab("PORO", k).unwrap();
    }
    w.finalize().unwrap();
    let s = Store::open(&p).unwrap();
    let expect = 2.0f32 + 10.0f32 * 0.01f32;
    assert_eq!(s.slab_f32("PORO", 2).unwrap()[10], expect);
    // flush_behind_slab is loud on a flat lane / out-of-range slab.
    let pf = tmp("fb_flat");
    let schema2 = StoreSchema::new(2, vec![LaneSpec::flat("COORD", Dtype::F32, 4)]);
    let mut w2 = StoreWriter::create(&pf, schema2)
        .unwrap()
        .with_flush_behind(true);
    assert!(matches!(
        w2.flush_behind_slab("COORD", 0),
        Err(AlgoError::InvalidArgument(_))
    ));
    std::fs::remove_file(&p).ok();
    std::fs::remove_file(&pf).ok();
}

/// RSS probe (opt-in): at the ~50M-elem (200 MB) scale, streaming writes with
/// flush-behind must not accumulate resident pages the way plain writes do.
/// Ignored by default (RSS is noisy + platform-dependent); run explicitly:
/// `cargo test --test store_roundtrip -- --ignored --nocapture flush_behind_rss`.
#[test]
#[ignore = "RSS probe: run with --ignored --nocapture to measure resident-page growth"]
fn flush_behind_rss_probe() {
    let (nslabs, eps) = (500u64, 100_000u64); // 50M f32 ≈ 200 MB
    let slab: Vec<f32> = (0..eps).map(|i| i as f32).collect();
    let run = |flush_behind: bool| -> u64 {
        let p = tmp(if flush_behind { "rss_on" } else { "rss_off" });
        let schema = StoreSchema::new(nslabs, vec![LaneSpec::slab("PORO", Dtype::F32, eps)]);
        let mut w = StoreWriter::create(&p, schema)
            .unwrap()
            .with_flush_behind(flush_behind);
        let base = rss_bytes();
        for k in 0..nslabs {
            w.write_slab_f32("PORO", k, &slab).unwrap();
        }
        let peak = rss_bytes();
        w.finalize().unwrap();
        std::fs::remove_file(&p).ok();
        peak.saturating_sub(base)
    };
    let grow_off = run(false);
    let grow_on = run(true);
    let store_mb = (nslabs * eps * 4) / 1_048_576;
    eprintln!(
        "[rss] store={store_mb} MB | plain writes grew RSS {} MB | flush-behind grew RSS {} MB",
        grow_off / 1_048_576,
        grow_on / 1_048_576
    );
    // Robust bound: flush-behind must never be materially worse than plain
    // writes. (The win's magnitude is platform-dependent — see the printed
    // numbers; Linux drops pages synchronously, macOS treats DONTNEED softer.)
    assert!(
        grow_on <= grow_off + 16 * 1_048_576,
        "flush-behind grew resident set MORE than plain writes: on={grow_on} off={grow_off}"
    );
}

/// Process resident-set size in bytes (best-effort, for the RSS probe).
#[cfg(test)]
fn rss_bytes() -> u64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(s) = std::fs::read_to_string("/proc/self/statm") {
            if let Some(pages) = s
                .split_whitespace()
                .nth(1)
                .and_then(|x| x.parse::<u64>().ok())
            {
                return pages * 4096;
            }
        }
    }
    // macOS / other unix: `ps -o rss= -p <pid>` reports resident KiB.
    let out = std::process::Command::new("ps")
        .arg("-o")
        .arg("rss=")
        .arg("-p")
        .arg(std::process::id().to_string())
        .output();
    if let Ok(o) = out {
        if let Ok(txt) = String::from_utf8(o.stdout) {
            if let Ok(kib) = txt.trim().parse::<u64>() {
                return kib * 1024;
            }
        }
    }
    0
}

/// A bad schema is rejected at create time with a typed error.
#[test]
fn rejects_bad_schema() {
    let p = tmp("badschema");
    // duplicate lane name
    let dup = StoreSchema::new(
        2,
        vec![
            LaneSpec::slab("PORO", Dtype::F32, 3),
            LaneSpec::slab("PORO", Dtype::F64, 3),
        ],
    );
    assert!(matches!(
        StoreWriter::create(&p, dup),
        Err(AlgoError::InvalidArgument(_))
    ));
    // zero slabs
    let zero = StoreSchema::new(0, vec![LaneSpec::slab("PORO", Dtype::F32, 3)]);
    assert!(matches!(
        StoreWriter::create(&p, zero),
        Err(AlgoError::InvalidArgument(_))
    ));
    std::fs::remove_file(&p).ok();
}
