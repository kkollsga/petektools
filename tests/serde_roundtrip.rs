//! serde round-trip coverage for the public value types that carry
//! `#[derive(Serialize, Deserialize)]` (task_petektools_serde). Each type is
//! serialised to JSON and back; the round-trip must equal the original value
//! (the types all derive `PartialEq`). Additive, no behaviour change — this
//! guards the config-layer scenario round-trip in downstream consumers
//! (petekStatic `McInputs` wraps `Sampler`/`Clamped`).

use petektools::sampling::{Clamped, Sampler};
use petektools::synth::wells::{BuildHold, BuildHoldDrop, WellProfile};
use petektools::{Variogram, VariogramModel};

/// serialise → deserialise; assert the value survives the trip unchanged.
fn round_trip<T>(value: &T)
where
    T: serde::Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let json = serde_json::to_string(value).expect("serialize");
    let back: T = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(*value, back, "round-trip must equal the original value");
}

#[test]
fn sampler_round_trips_every_variant() {
    round_trip(&Sampler::new_uniform(0.0, 1.0).unwrap());
    round_trip(&Sampler::new_normal(10.0, 2.5).unwrap());
    round_trip(&Sampler::new_lognormal(0.0, 0.5).unwrap());
    round_trip(&Sampler::new_triangular(0.0, 1.0, 3.0).unwrap());
    round_trip(&Sampler::new_truncated_normal(0.0, 1.0, -2.0, 2.0).unwrap());
}

#[test]
fn clamped_round_trips() {
    let inner = Sampler::new_normal(5.0, 1.0).unwrap();
    round_trip(&Clamped::new(inner, 3.0, 7.0).unwrap());
}

#[test]
fn variogram_round_trips_every_model() {
    for model in [
        VariogramModel::Nugget,
        VariogramModel::Spherical,
        VariogramModel::Exponential,
        VariogramModel::Gaussian,
    ] {
        round_trip(&model);
        round_trip(&Variogram::new(model, 0.1, 0.9, 500.0).unwrap());
    }
}

#[test]
fn well_profile_round_trips_every_variant() {
    round_trip(&WellProfile::Vertical);

    let bh = BuildHold::new(500.0, 3.0, 45.0, 120.0).unwrap();
    round_trip(&bh);
    round_trip(&WellProfile::BuildHold(bh));

    let bhd = BuildHoldDrop::new(bh, 1200.0, 2.0, 10.0).unwrap();
    round_trip(&bhd);
    round_trip(&WellProfile::BuildHoldDrop(bhd));
}
