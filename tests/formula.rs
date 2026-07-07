use std::collections::HashMap;

use petektools::{
    formula::{evaluate_formulas, FormulaBlock},
    AlgoError,
};

fn props(values: &[(&str, Vec<f64>)]) -> HashMap<String, Vec<f64>> {
    values
        .iter()
        .map(|(name, values)| ((*name).to_string(), values.clone()))
        .collect()
}

fn params(values: &[(&str, f64)]) -> HashMap<String, f64> {
    values
        .iter()
        .map(|(name, value)| ((*name).to_string(), *value))
        .collect()
}

#[test]
fn parses_params_properties_and_assignment_dependencies() {
    let block = FormulaBlock::parse(&[
        "RQI = $lambda * sqrt(PermXY_BC / PorE_BC)",
        "Swirr = $SHF_c * pow(RQI, $SHF_d)",
    ])
    .unwrap();

    assert_eq!(block.outputs(), vec!["RQI", "Swirr"]);
    assert_eq!(block.evaluation_order(), vec!["RQI", "Swirr"]);
    assert_eq!(
        block.params().into_iter().collect::<Vec<_>>(),
        vec!["SHF_c", "SHF_d", "lambda"]
    );
    assert_eq!(
        block
            .property_dependencies()
            .into_iter()
            .collect::<Vec<_>>(),
        vec!["PermXY_BC", "PorE_BC"]
    );
}

#[test]
fn evaluates_vectorized_block_with_dependencies() {
    let out = evaluate_formulas(
        &[
            "RQI = $lambda * sqrt(PermXY_BC / PorE_BC)",
            "Swirr = $SHF_c * pow(RQI, $SHF_d)",
        ],
        &props(&[
            ("PermXY_BC", vec![100.0, 400.0, 900.0]),
            ("PorE_BC", vec![0.25, 0.25, 0.25]),
        ]),
        &params(&[("lambda", 0.0314), ("SHF_c", 0.2), ("SHF_d", -0.3)]),
    )
    .unwrap();

    let rqi = &out["RQI"];
    assert!((rqi[0] - 0.628).abs() < 1e-12);
    assert!((rqi[1] - 1.256).abs() < 1e-12);
    assert!((rqi[2] - 1.884).abs() < 1e-12);
    assert_eq!(out["Swirr"].len(), 3);
}

#[test]
fn supports_comparisons_clip_min_max_abs_exp_log_and_if() {
    let out = evaluate_formulas(
        &[
            "Base = if(A <= 0, abs(A), log10(pow(A, 2)))",
            "Bounded = clip(min(max(Base, 0.2), exp(1)), 0.25, 2.0)",
        ],
        &props(&[("A", vec![-2.0, 0.1, 10.0])]),
        &HashMap::new(),
    )
    .unwrap();

    assert_eq!(out["Base"], vec![2.0, -2.0, 2.0]);
    assert_eq!(out["Bounded"], vec![2.0, 0.25, 2.0]);
}

#[test]
fn supports_out_of_order_assignments_and_scalar_broadcast() {
    let out = evaluate_formulas(
        &["B = A + X", "A = $p * 2"],
        &props(&[("X", vec![1.0, 2.0, 3.0])]),
        &params(&[("p", 5.0)]),
    )
    .unwrap();

    assert_eq!(out["A"], vec![10.0, 10.0, 10.0]);
    assert_eq!(out["B"], vec![11.0, 12.0, 13.0]);
}

#[test]
fn propagates_nan_from_selected_if_branch() {
    let out = evaluate_formulas(
        &["Y = if(Flag == 1, X, 0)"],
        &props(&[("Flag", vec![1.0, 0.0]), ("X", vec![f64::NAN, 2.0])]),
        &HashMap::new(),
    )
    .unwrap();

    assert!(out["Y"][0].is_nan());
    assert_eq!(out["Y"][1], 0.0);
}

#[test]
fn errors_loudly_for_invalid_lhs_parse_missing_names_cycles_and_shapes() {
    assert!(matches!(
        FormulaBlock::parse(&["$bad = X"]),
        Err(AlgoError::Parse(_))
    ));
    assert!(matches!(
        FormulaBlock::parse(&["A = "]),
        Err(AlgoError::Parse(_))
    ));

    let missing_param =
        evaluate_formulas(&["A = $p + X"], &props(&[("X", vec![1.0])]), &params(&[]));
    assert!(matches!(missing_param, Err(AlgoError::NotFound(_))));

    let missing_property = evaluate_formulas(&["A = X + 1"], &props(&[]), &params(&[]));
    assert!(matches!(missing_property, Err(AlgoError::NotFound(_))));

    let cycle = FormulaBlock::parse(&["A = B + 1", "B = A + 1"]);
    assert!(matches!(cycle, Err(AlgoError::InvalidArgument(_))));

    let shape = evaluate_formulas(
        &["A = X + Y"],
        &props(&[("X", vec![1.0, 2.0]), ("Y", vec![1.0])]),
        &params(&[]),
    );
    assert!(matches!(shape, Err(AlgoError::InvalidArgument(_))));
}

#[test]
fn rejects_non_finite_params_and_unknown_functions() {
    let bad_param = evaluate_formulas(
        &["A = $p + X"],
        &props(&[("X", vec![1.0])]),
        &params(&[("p", f64::INFINITY)]),
    );
    assert!(matches!(bad_param, Err(AlgoError::InvalidArgument(_))));

    let unknown = evaluate_formulas(&["A = sin(X)"], &props(&[("X", vec![1.0])]), &params(&[]));
    assert!(matches!(unknown, Err(AlgoError::InvalidArgument(_))));
}
