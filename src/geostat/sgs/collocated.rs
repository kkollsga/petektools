//! Collocated-secondary (Markov-1) support: standardising the secondary field
//! before it is folded into each node's kriging as a collocated cokriging datum.

use ndarray::Array2;

/// Standardise a secondary field to zero mean / unit variance over its finite
/// nodes. A constant (zero-variance) field is mapped to all-zeros (it then
/// carries no drift).
pub(super) fn standardize(field: &Array2<f64>) -> Array2<f64> {
    let finite: Vec<f64> = field.iter().cloned().filter(|v| v.is_finite()).collect();
    let n = finite.len();
    if n == 0 {
        return field.clone();
    }
    let mean = finite.iter().sum::<f64>() / n as f64;
    let var = finite.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n as f64;
    let sd = var.sqrt();
    field.mapv(|v| {
        if v.is_finite() && sd > 0.0 {
            (v - mean) / sd
        } else {
            0.0
        }
    })
}
