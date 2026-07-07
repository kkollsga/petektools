//! Formula bindings — domain-free expression evaluation over named vectors.

use std::collections::HashMap;

use petektools::formula::FormulaBlock;
use pyo3::prelude::*;

use crate::to_pyerr;

/// Inspect a formula block without evaluating it.
///
/// Returns sorted dependency lists under `params` and `properties`, plus output
/// names in source order (`outputs`) and topological evaluation order (`order`).
#[pyfunction]
pub fn formula_info(assignments: Vec<String>) -> PyResult<HashMap<String, Vec<String>>> {
    let block = FormulaBlock::parse(&assignments).map_err(to_pyerr)?;
    Ok(HashMap::from([
        ("outputs".to_string(), block.outputs()),
        ("order".to_string(), block.evaluation_order()),
        (
            "params".to_string(),
            block.params().into_iter().collect::<Vec<_>>(),
        ),
        (
            "properties".to_string(),
            block
                .property_dependencies()
                .into_iter()
                .collect::<Vec<_>>(),
        ),
    ]))
}

/// Evaluate assignment strings over named equal-length property vectors.
///
/// `$name` tokens are scalar runtime parameters from `params`; bare symbols are
/// property vectors or prior assignments in the same block. Scalars broadcast.
#[pyfunction]
#[pyo3(signature = (assignments, properties, params = None))]
pub fn evaluate_formula(
    assignments: Vec<String>,
    properties: HashMap<String, Vec<f64>>,
    params: Option<HashMap<String, f64>>,
) -> PyResult<HashMap<String, Vec<f64>>> {
    let params = params.unwrap_or_default();
    let block = FormulaBlock::parse(&assignments).map_err(to_pyerr)?;
    block.evaluate(&properties, &params).map_err(to_pyerr)
}
