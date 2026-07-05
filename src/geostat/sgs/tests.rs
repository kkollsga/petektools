use super::*;
use crate::gridding::kriging::VariogramModel;
use crate::stats::{mean, std_dev};

fn unit_spherical(range: f64) -> Variogram {
    // Sill 1 (normal-score space), no nugget.
    Variogram::new(VariogramModel::Spherical, 0.0, 1.0, range).unwrap()
}

fn sample_data() -> Vec<[f64; 3]> {
    let mut d = Vec::new();
    // A scattered set with a mild trend, values spread out.
    let pts = [
        (2.0, 2.0, 10.0),
        (18.0, 3.0, 25.0),
        (5.0, 17.0, 14.0),
        (16.0, 16.0, 33.0),
        (10.0, 10.0, 20.0),
        (8.0, 4.0, 12.0),
        (13.0, 8.0, 28.0),
        (3.0, 12.0, 11.0),
    ];
    for (x, y, z) in pts {
        d.push([x, y, z]);
    }
    d
}

#[test]
fn empty_and_bad_params_error() {
    let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 10, 10);
    let p = SgsParams::new(unit_spherical(10.0), 12, 15.0, 1).unwrap();
    assert!(matches!(
        sgs(&[], &lattice, &p),
        Err(AlgoError::EmptyInput(_))
    ));
    assert!(SgsParams::new(unit_spherical(10.0), 0, 15.0, 1).is_err());
}

#[test]
fn collocated_shape_mismatch_is_invalid_argument() {
    // A wrong-shaped secondary is a bad argument, not a degenerate geometry.
    let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 10, 10);
    let mut p = SgsParams::new(unit_spherical(8.0), 12, 15.0, 1).unwrap();
    p.collocated = Some((Array2::from_elem((4, 4), 0.0), 0.5));
    assert!(matches!(
        sgs(&sample_data(), &lattice, &p),
        Err(AlgoError::InvalidArgument(_))
    ));
}

#[test]
fn same_seed_is_bit_reproducible() {
    let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 20, 20);
    let data = sample_data();
    let p = SgsParams::new(unit_spherical(8.0), 16, 12.0, 42).unwrap();
    let a = sgs(&data, &lattice, &p).unwrap();
    let b = sgs(&data, &lattice, &p).unwrap();
    assert_eq!(a, b, "same seed must reproduce the field exactly");
}

#[test]
fn different_seed_differs() {
    let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 20, 20);
    let data = sample_data();
    let a = sgs(
        &data,
        &lattice,
        &SgsParams::new(unit_spherical(8.0), 16, 12.0, 1).unwrap(),
    )
    .unwrap();
    let b = sgs(
        &data,
        &lattice,
        &SgsParams::new(unit_spherical(8.0), 16, 12.0, 2).unwrap(),
    )
    .unwrap();
    assert_ne!(a, b);
}

#[test]
fn conditioning_is_honoured_at_data_nodes() {
    let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 20, 20);
    let data = sample_data();
    let p = SgsParams::new(unit_spherical(8.0), 16, 12.0, 7).unwrap();
    let field = sgs(&data, &lattice, &p).unwrap();
    for c in &data {
        let (fi, fj) = lattice.xy_to_ij(c[0], c[1]).unwrap();
        let (i, j) = (fi.round() as usize, fj.round() as usize);
        assert!(
            (field[[i, j]] - c[2]).abs() < 1e-6,
            "datum {:?} not honoured: node = {}",
            c,
            field[[i, j]]
        );
    }
}

#[test]
fn reproduces_data_statistics_loosely() {
    // On a reasonably sized grid the back-transformed field's mean and spread
    // should track the data's (loose statistical tolerances, seeded).
    let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 40, 40);
    let data = sample_data();
    let p = SgsParams::new(unit_spherical(10.0), 24, 18.0, 2024).unwrap();
    let field = sgs(&data, &lattice, &p).unwrap();
    let flat: Vec<f64> = field.iter().cloned().collect();

    let data_z: Vec<f64> = data.iter().map(|c| c[2]).collect();
    let dm = mean(&data_z).unwrap();
    let fm = mean(&flat).unwrap();
    // Field mean within a few data-units of the data mean.
    assert!((fm - dm).abs() < 6.0, "field mean {fm} vs data mean {dm}");
    // Field spread is a meaningful fraction of the data spread (not collapsed
    // to a constant, not wildly inflated).
    let ds = std_dev(&data_z).unwrap();
    let fs = std_dev(&flat).unwrap();
    assert!(fs > 0.3 * ds, "field too flat: {fs} vs {ds}");
    assert!(fs < 2.5 * ds, "field too wild: {fs} vs {ds}");
}

#[test]
fn collocated_rho_zero_matches_plain_sgs() {
    // ρ = 0 collocated cokriging must reduce to plain SGS bit-for-bit (the
    // secondary decouples in every node's system, and the RNG stream is the
    // same since the draw order is unchanged).
    let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 20, 20);
    let data = sample_data();
    let plain = sgs(
        &data,
        &lattice,
        &SgsParams::new(unit_spherical(8.0), 16, 12.0, 5).unwrap(),
    )
    .unwrap();

    let secondary = Array2::from_shape_fn((20, 20), |(i, j)| (i + j) as f64);
    let mut p = SgsParams::new(unit_spherical(8.0), 16, 12.0, 5).unwrap();
    p.collocated = Some((secondary, 0.0));
    let co = sgs(&data, &lattice, &p).unwrap();
    assert_eq!(plain, co, "ρ=0 collocated SGS must equal plain SGS");
}

#[test]
fn collocated_high_rho_tracks_the_secondary() {
    // A strong secondary trend (increasing with i) at high ρ should make the
    // field correlate positively with that trend.
    let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 30, 30);
    let data = sample_data();
    let secondary = Array2::from_shape_fn((30, 30), |(i, _j)| i as f64);
    let mut p = SgsParams::new(unit_spherical(10.0), 20, 15.0, 3).unwrap();
    p.collocated = Some((secondary.clone(), 0.9));
    let field = sgs(&data, &lattice, &p).unwrap();

    // Correlation between column index i and the field value should be > 0.
    let mut sx = 0.0;
    let mut sy = 0.0;
    let mut sxy = 0.0;
    let mut sxx = 0.0;
    let mut n = 0.0;
    for i in 0..30 {
        for j in 0..30 {
            let xi = i as f64;
            let yi = field[[i, j]];
            sx += xi;
            sy += yi;
            sxy += xi * yi;
            sxx += xi * xi;
            n += 1.0;
        }
    }
    let cov = sxy / n - (sx / n) * (sy / n);
    let varx = sxx / n - (sx / n).powi(2);
    let slope = cov / varx;
    assert!(
        slope > 0.0,
        "field should increase with the secondary (slope {slope})"
    );
}

// ---- reusable session: bit-for-bit parity with the one-shot path ----

/// Per-layer conditioning: a base scatter shifted in value and membership so
/// each layer fixes a *different* set of nodes with different scores — the
/// resimulate workload the session targets.
fn layer_data(k: usize) -> Vec<[f64; 3]> {
    let base = sample_data();
    base.into_iter()
        .enumerate()
        // Drop one (rotating) datum per layer so the fixed-node *membership*
        // differs, and shift the values so the normal-score transform differs.
        .filter(|(idx, _)| *idx != k % 8)
        .map(|(_, [x, y, z])| [x, y, z + k as f64 * 3.0])
        .collect()
}

#[test]
fn session_matches_oneshot_across_layers() {
    // The whole determinism contract: for several layers with differing
    // conditioning + seed, the session must reproduce the one-shot `sgs` field
    // BIT-FOR-BIT (petekStatic pins SGS reproducibility across the seam).
    let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 30, 30);
    let vg = unit_spherical(9.0);
    let mut session = SgsSession::new(lattice.clone(), vg, 20, 15.0).unwrap();

    for k in 0..6usize {
        let data = layer_data(k);
        let seed = 100 + k as u64;
        let p = SgsParams::new(vg, 20, 15.0, seed).unwrap();
        let one_shot = sgs(&data, &lattice, &p).unwrap();
        let via_session = session.simulate(&data, seed).unwrap();
        assert_eq!(
            one_shot, via_session,
            "layer {k}: session field must equal the one-shot sgs field exactly"
        );
    }
}

#[test]
fn session_reuse_does_not_leak_state() {
    // Reusing the scratch must not carry state between sweeps: layer A after a
    // different layer B must reproduce a fresh layer A exactly.
    let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 25, 25);
    let vg = unit_spherical(8.0);
    let mut session = SgsSession::new(lattice.clone(), vg, 16, 12.0).unwrap();

    let data_a = layer_data(0);
    let data_b = layer_data(3);
    let fresh_a = sgs(&data_a, &lattice, &SgsParams::new(vg, 16, 12.0, 7).unwrap()).unwrap();

    let _first = session.simulate(&data_a, 7).unwrap();
    let _other = session.simulate(&data_b, 9).unwrap();
    let a_again = session.simulate(&data_a, 7).unwrap();
    assert_eq!(
        fresh_a, a_again,
        "reused session leaked state across sweeps"
    );
}

#[test]
fn session_collocated_matches_oneshot_across_layers() {
    // The collocated-cokriging path shares the per-layer machinery, so it must
    // hold the same bit-for-bit parity — with a different secondary per layer.
    let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 28, 28);
    let vg = unit_spherical(10.0);
    let mut session = SgsSession::new(lattice.clone(), vg, 18, 14.0).unwrap();

    for k in 0..4usize {
        let data = layer_data(k);
        let seed = 2024 + k as u64;
        let rho = 0.3 + 0.15 * k as f64;
        let secondary =
            Array2::from_shape_fn((28, 28), |(i, j)| (i as f64) - 0.5 * (j as f64) + k as f64);

        let mut p = SgsParams::new(vg, 18, 14.0, seed).unwrap();
        p.collocated = Some((secondary.clone(), rho));
        let one_shot = sgs(&data, &lattice, &p).unwrap();

        let via_session = session
            .simulate_collocated(&data, seed, &secondary, rho)
            .unwrap();
        assert_eq!(
            one_shot, via_session,
            "collocated layer {k}: session field must equal the one-shot sgs field exactly"
        );
    }
}

#[test]
fn session_validates_and_errors() {
    let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 10, 10);
    let vg = unit_spherical(8.0);
    assert!(SgsSession::new(lattice.clone(), vg, 0, 5.0).is_err());
    assert!(SgsSession::new(lattice.clone(), vg, 8, 0.0).is_err());

    let mut session = SgsSession::new(lattice, vg, 8, 12.0).unwrap();
    assert!(matches!(
        session.simulate(&[], 1),
        Err(AlgoError::EmptyInput(_))
    ));
    let bad_sec = Array2::from_elem((3, 3), 0.0);
    assert!(matches!(
        session.simulate_collocated(&sample_data(), 1, &bad_sec, 0.5),
        Err(AlgoError::InvalidArgument(_))
    ));
}

// ---- unconditional simulation ----

/// Mean lag-1 autocorrelation of a field along the column (i) axis — a cheap
/// proxy for "is the variogram range visible in the field's continuity".
fn lag1_autocorr(field: &Array2<f64>) -> f64 {
    let flat: Vec<f64> = field.iter().cloned().collect();
    let m = mean(&flat).unwrap();
    let v = flat.iter().map(|x| (x - m).powi(2)).sum::<f64>() / flat.len() as f64;
    let (ncol, nrow) = field.dim();
    let mut cov = 0.0;
    let mut n = 0.0;
    for j in 0..nrow {
        for i in 0..ncol - 1 {
            cov += (field[[i, j]] - m) * (field[[i + 1, j]] - m);
            n += 1.0;
        }
    }
    (cov / n) / v
}

#[test]
fn unconditional_bad_params_error() {
    let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 10, 10);
    let vg = unit_spherical(5.0);
    assert!(sgs_unconditional(&lattice, 0.2, 0.01, &vg, 0, 5.0, 1).is_err());
    assert!(sgs_unconditional(&lattice, 0.2, 0.01, &vg, 8, -1.0, 1).is_err());
    assert!(sgs_unconditional(&lattice, 0.2, -0.5, &vg, 8, 5.0, 1).is_err());
    assert!(sgs_unconditional(&lattice, f64::NAN, 0.01, &vg, 8, 5.0, 1).is_err());
}

#[test]
fn unconditional_variance_zero_is_constant() {
    let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 8, 8);
    let f = sgs_unconditional(&lattice, 3.5, 0.0, &unit_spherical(5.0), 8, 5.0, 1).unwrap();
    assert!(f.iter().all(|&v| v == 3.5));
}

#[test]
fn unconditional_bit_reproducible() {
    let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 20, 20);
    let vg = unit_spherical(8.0);
    let a = sgs_unconditional(&lattice, 0.2, 0.04, &vg, 16, 12.0, 99).unwrap();
    let b = sgs_unconditional(&lattice, 0.2, 0.04, &vg, 16, 12.0, 99).unwrap();
    assert_eq!(a, b, "same seed must reproduce the field exactly");
}

#[test]
fn unconditional_reproduces_mean_and_variance() {
    // Over a decent grid and averaged across seeds, the field's mean/variance
    // track the requested parametric target (loose statistical tolerances).
    let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 50, 50);
    let vg = unit_spherical(10.0);
    let (target_mean, target_var) = (0.25, 0.04);
    let mut mbar = 0.0;
    let mut vbar = 0.0;
    let seeds = [1u64, 7, 42, 100, 2024];
    for &s in &seeds {
        let f = sgs_unconditional(&lattice, target_mean, target_var, &vg, 24, 18.0, s).unwrap();
        let flat: Vec<f64> = f.iter().cloned().collect();
        mbar += mean(&flat).unwrap();
        vbar += std_dev(&flat).unwrap().powi(2);
    }
    mbar /= seeds.len() as f64;
    vbar /= seeds.len() as f64;
    assert!(
        (mbar - target_mean).abs() < 0.03,
        "mean {mbar} vs {target_mean}"
    );
    assert!(
        (vbar - target_var).abs() < 0.02,
        "variance {vbar} vs {target_var}"
    );
}

#[test]
fn unconditional_range_visible_in_autocorrelation() {
    // A long-range variogram must leave a strongly autocorrelated field; a
    // pure nugget (rangeless) must leave a near-independent one.
    let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 40, 40);
    let long = sgs_unconditional(&lattice, 0.0, 1.0, &unit_spherical(25.0), 30, 40.0, 3).unwrap();
    let nugget = Variogram::new(VariogramModel::Nugget, 1.0, 0.0, 1.0).unwrap();
    let white = sgs_unconditional(&lattice, 0.0, 1.0, &nugget, 30, 40.0, 3).unwrap();
    let rc = lag1_autocorr(&long);
    let rw = lag1_autocorr(&white);
    assert!(
        rc > 0.6,
        "long-range field should be smooth: lag-1 corr {rc}"
    );
    assert!(
        rw.abs() < 0.2,
        "nugget field should be ~white: lag-1 corr {rw}"
    );
}
