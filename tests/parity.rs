//! Cross-language reproducibility parity vector.
//!
//! These golden values pin the exact draw stream of `seeded_rng(seed)` +
//! `Sampler` for a fixed seed/params. The **same** vectors are re-asserted from
//! Python in the wheel smoke test (`python/tests/test_petektools.py`), so a
//! drift on *either* side — a change to the RNG/variate path in Rust, or a
//! marshalling bug in the PyO3 bindings — fails a test rather than silently
//! diverging. Seed and params are shared between the two languages by copy;
//! keep them in lockstep if either is edited.
//!
//! Exact `f64` equality is intentional: reproducibility means bit-for-bit, and
//! the literals are Python's shortest round-tripping `repr`, which parses back
//! to the identical IEEE-754 double in Rust.

use petektools::sampling::{seeded_rng, Sampler};

const SEED: u64 = 20260703;

fn draw(sampler: Sampler, n: usize) -> Vec<f64> {
    sampler.sample_n(n, &mut seeded_rng(SEED))
}

#[test]
fn uniform_parity_vector() {
    let got = draw(Sampler::new_uniform(0.0, 1.0).unwrap(), 5);
    let want = [
        0.33443602974759323,
        0.009958944617155074,
        0.5658402900563928,
        0.4914127600800473,
        0.15156206470701195,
    ];
    assert_eq!(got, want);
}

#[test]
fn normal_parity_vector() {
    let got = draw(Sampler::new_normal(0.0, 1.0).unwrap(), 5);
    let want = [
        -0.2141390202029558,
        -0.8558773516768997,
        0.3154728438139085,
        -0.02578857523830222,
        -1.0136631546527357,
    ];
    assert_eq!(got, want);
}

#[test]
fn triangular_parity_vector() {
    let got = draw(Sampler::new_triangular(0.0, 1.0, 2.0).unwrap(), 3);
    let want = [0.8178459876377621, 0.14113075226296412, 1.0681634156746074];
    assert_eq!(got, want);
}

#[test]
fn lognormal_parity_vector() {
    let got = draw(Sampler::new_lognormal(0.0, 0.25).unwrap(), 3);
    let want = [0.9478729970572154, 0.8073731403836002, 1.0820617087922064];
    assert_eq!(got, want);
}

#[test]
fn truncated_normal_parity_vector() {
    let got = draw(
        Sampler::new_truncated_normal(0.0, 1.0, -1.0, 1.0).unwrap(),
        3,
    );
    let want = [
        -0.2872218793831341,
        -0.9722860907259094,
        0.11290855771814236,
    ];
    assert_eq!(got, want);
}
