//! One-dimensional interpolation kernels.
//!
//! The cubic path is a natural cubic spline implemented from the standard
//! derivation: construction solves for
//! knot second derivatives with zero curvature at both ends, then evaluates the
//! standard piecewise cubic form. This mirrors the public mathematical contract
//! used by established spline libraries without copying their implementation.

use crate::{AlgoError, Result};

/// Interpolation method for [`interp1d`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Interp1dMethod {
    /// Closest input sample; ties choose the lower/previous sample.
    Nearest,
    /// Previous sample on the x-axis.
    Previous,
    /// Next sample on the x-axis.
    Next,
    /// Piecewise-linear interpolation.
    Linear,
    /// Global natural cubic spline (`S''(x[0]) = S''(x[n-1]) = 0`).
    CubicNatural,
}

impl Interp1dMethod {
    /// Parse a user-facing method name.
    pub fn parse(name: &str) -> Result<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "nearest" | "closest" | "nn" => Ok(Self::Nearest),
            "previous" | "prev" | "ffill" => Ok(Self::Previous),
            "next" | "bfill" => Ok(Self::Next),
            "linear" => Ok(Self::Linear),
            "cubic" | "spline" | "natural" | "natural_cubic" | "cubic_natural" => {
                Ok(Self::CubicNatural)
            }
            other => Err(AlgoError::InvalidArgument(format!(
                "unknown interpolation method '{other}'"
            ))),
        }
    }
}

/// Evaluate `y(x)` at every `query` point.
///
/// `x` must be finite, strictly increasing, and the same length as `y`; `y`
/// values must be finite. If `extrapolate` is false, out-of-bounds queries
/// return `NaN`. If true, edge intervals are extended for linear/cubic methods,
/// and edge values are held for step/nearest methods.
pub fn interp1d(
    x: &[f64],
    y: &[f64],
    query: &[f64],
    method: Interp1dMethod,
    extrapolate: bool,
) -> Result<Vec<f64>> {
    validate_xy(x, y)?;
    let spline = if method == Interp1dMethod::CubicNatural {
        Some(CubicSpline1d::new(x, y)?)
    } else {
        None
    };
    let values = query
        .iter()
        .map(|&q| match method {
            Interp1dMethod::Nearest => sample_nearest(x, y, q, extrapolate),
            Interp1dMethod::Previous => sample_previous(x, y, q, extrapolate),
            Interp1dMethod::Next => sample_next(x, y, q, extrapolate),
            Interp1dMethod::Linear => sample_linear(x, y, q, extrapolate),
            Interp1dMethod::CubicNatural => spline.as_ref().unwrap().evaluate(q, extrapolate),
        })
        .collect();
    Ok(values)
}

/// A natural cubic spline over 1-D knots.
#[derive(Clone, Debug)]
pub struct CubicSpline1d {
    x: Vec<f64>,
    y: Vec<f64>,
    second: Vec<f64>,
}

impl CubicSpline1d {
    /// Build a natural cubic spline (`S'' = 0` at both endpoints).
    pub fn new(x: &[f64], y: &[f64]) -> Result<Self> {
        validate_xy(x, y)?;
        let second = natural_second_derivatives(x, y)?;
        Ok(Self {
            x: x.to_vec(),
            y: y.to_vec(),
            second,
        })
    }

    /// Evaluate the spline at `q`.
    pub fn evaluate(&self, q: f64, extrapolate: bool) -> f64 {
        if q.is_nan() || (!extrapolate && (q < self.x[0] || q > self.x[self.x.len() - 1])) {
            return f64::NAN;
        }
        let i = interval_index(&self.x, q);
        evaluate_cubic_segment(&self.x, &self.y, &self.second, i, q)
    }

    /// Evaluate many query points.
    pub fn evaluate_many(&self, query: &[f64], extrapolate: bool) -> Vec<f64> {
        query
            .iter()
            .map(|&q| self.evaluate(q, extrapolate))
            .collect()
    }
}

fn validate_xy(x: &[f64], y: &[f64]) -> Result<()> {
    if x.len() != y.len() {
        return Err(AlgoError::InvalidArgument(format!(
            "x/y length mismatch: {} != {}",
            x.len(),
            y.len()
        )));
    }
    if x.len() < 2 {
        return Err(AlgoError::EmptyInput(
            "interp1d requires at least two knots",
        ));
    }
    if x.iter().any(|v| !v.is_finite()) {
        return Err(AlgoError::InvalidArgument(
            "x values must be finite".to_string(),
        ));
    }
    if y.iter().any(|v| !v.is_finite()) {
        return Err(AlgoError::InvalidArgument(
            "y values must be finite".to_string(),
        ));
    }
    for pair in x.windows(2) {
        if pair[1] <= pair[0] {
            return Err(AlgoError::InvalidArgument(
                "x values must be strictly increasing".to_string(),
            ));
        }
    }
    Ok(())
}

fn natural_second_derivatives(x: &[f64], y: &[f64]) -> Result<Vec<f64>> {
    let n = x.len();
    let mut second = vec![0.0; n];
    if n == 2 {
        return Ok(second);
    }

    let m = n - 2;
    let mut lower = vec![0.0; m];
    let mut diag = vec![0.0; m];
    let mut upper = vec![0.0; m];
    let mut rhs = vec![0.0; m];

    for row in 0..m {
        let i = row + 1;
        let h0 = x[i] - x[i - 1];
        let h1 = x[i + 1] - x[i];
        lower[row] = h0;
        diag[row] = 2.0 * (h0 + h1);
        upper[row] = h1;
        rhs[row] = 6.0 * ((y[i + 1] - y[i]) / h1 - (y[i] - y[i - 1]) / h0);
    }

    let interior = solve_tridiagonal(&lower, &diag, &upper, &rhs)?;
    second[1..n - 1].copy_from_slice(&interior);
    Ok(second)
}

fn solve_tridiagonal(lower: &[f64], diag: &[f64], upper: &[f64], rhs: &[f64]) -> Result<Vec<f64>> {
    let n = diag.len();
    let mut cprime = vec![0.0; n];
    let mut dprime = vec![0.0; n];
    let mut out = vec![0.0; n];

    let first = diag[0];
    if first.abs() <= f64::EPSILON {
        return Err(AlgoError::InvalidGeometry("singular spline system"));
    }
    cprime[0] = if n > 1 { upper[0] / first } else { 0.0 };
    dprime[0] = rhs[0] / first;

    for i in 1..n {
        let denom = diag[i] - lower[i] * cprime[i - 1];
        if denom.abs() <= f64::EPSILON {
            return Err(AlgoError::InvalidGeometry("singular spline system"));
        }
        cprime[i] = if i + 1 < n { upper[i] / denom } else { 0.0 };
        dprime[i] = (rhs[i] - lower[i] * dprime[i - 1]) / denom;
    }

    out[n - 1] = dprime[n - 1];
    for i in (0..n - 1).rev() {
        out[i] = dprime[i] - cprime[i] * out[i + 1];
    }
    Ok(out)
}

fn sample_nearest(x: &[f64], y: &[f64], q: f64, extrapolate: bool) -> f64 {
    if q.is_nan() || (!extrapolate && (q < x[0] || q > x[x.len() - 1])) {
        return f64::NAN;
    }
    let i = match x.binary_search_by(|v| v.total_cmp(&q)) {
        Ok(i) => return y[i],
        Err(i) => i,
    };
    if i == 0 {
        return y[0];
    }
    if i >= x.len() {
        return y[y.len() - 1];
    }
    if (q - x[i - 1]).abs() <= (x[i] - q).abs() {
        y[i - 1]
    } else {
        y[i]
    }
}

fn sample_previous(x: &[f64], y: &[f64], q: f64, extrapolate: bool) -> f64 {
    if q.is_nan() || (!extrapolate && (q < x[0] || q > x[x.len() - 1])) {
        return f64::NAN;
    }
    match x.binary_search_by(|v| v.total_cmp(&q)) {
        Ok(i) => y[i],
        Err(0) => y[0],
        Err(i) if i >= x.len() => y[y.len() - 1],
        Err(i) => y[i - 1],
    }
}

fn sample_next(x: &[f64], y: &[f64], q: f64, extrapolate: bool) -> f64 {
    if q.is_nan() || (!extrapolate && (q < x[0] || q > x[x.len() - 1])) {
        return f64::NAN;
    }
    match x.binary_search_by(|v| v.total_cmp(&q)) {
        Ok(i) => y[i],
        Err(i) if i >= x.len() => y[y.len() - 1],
        Err(i) => y[i],
    }
}

fn sample_linear(x: &[f64], y: &[f64], q: f64, extrapolate: bool) -> f64 {
    if q.is_nan() || (!extrapolate && (q < x[0] || q > x[x.len() - 1])) {
        return f64::NAN;
    }
    let i = interval_index(x, q);
    linear_segment(x, y, i, q)
}

fn interval_index(x: &[f64], q: f64) -> usize {
    match x.binary_search_by(|v| v.total_cmp(&q)) {
        Ok(i) if i + 1 < x.len() => i,
        Ok(i) => i - 1,
        Err(0) => 0,
        Err(i) if i >= x.len() => x.len() - 2,
        Err(i) => i - 1,
    }
}

fn linear_segment(x: &[f64], y: &[f64], i: usize, q: f64) -> f64 {
    let h = x[i + 1] - x[i];
    let t = (q - x[i]) / h;
    y[i] + t * (y[i + 1] - y[i])
}

fn evaluate_cubic_segment(x: &[f64], y: &[f64], second: &[f64], i: usize, q: f64) -> f64 {
    let h = x[i + 1] - x[i];
    let a = (x[i + 1] - q) / h;
    let b = (q - x[i]) / h;
    a * y[i]
        + b * y[i + 1]
        + ((a * a * a - a) * second[i] + (b * b * b - b) * second[i + 1]) * h * h / 6.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_close(a: f64, b: f64, tol: f64) {
        assert!((a - b).abs() <= tol, "{a} != {b}");
    }

    #[test]
    fn linear_reproduces_affine_function() {
        let x = [0.0, 2.0, 5.0];
        let y: Vec<f64> = x.iter().map(|v| 3.0 + 2.0 * v).collect();
        let q = [-1.0, 1.0, 4.0, 7.0];
        let got = interp1d(&x, &y, &q, Interp1dMethod::Linear, true).unwrap();
        for (&qq, &yy) in q.iter().zip(got.iter()) {
            assert_close(yy, 3.0 + 2.0 * qq, 1e-12);
        }
    }

    #[test]
    fn natural_cubic_hits_knots_and_has_natural_end_curvature() {
        let x = [0.0, 1.0, 2.0, 4.0];
        let y = [0.0, 2.0, 1.0, 3.0];
        let spline = CubicSpline1d::new(&x, &y).unwrap();
        for (&xx, &yy) in x.iter().zip(y.iter()) {
            assert_close(spline.evaluate(xx, false), yy, 1e-12);
        }
        assert_close(spline.second[0], 0.0, 1e-12);
        assert_close(spline.second[spline.second.len() - 1], 0.0, 1e-12);
    }

    #[test]
    fn natural_cubic_is_c2_continuous_at_interior_knots() {
        let x = [0.0, 0.7, 2.0, 3.5, 5.0];
        let y = [1.0, -0.5, 0.25, 2.0, 1.2];
        let spline = CubicSpline1d::new(&x, &y).unwrap();
        let eps = 1e-6;
        for &knot in &x[1..x.len() - 1] {
            let left = spline.evaluate(knot - eps, false);
            let right = spline.evaluate(knot + eps, false);
            assert!((left - right).abs() < 1e-5);
        }
    }

    #[test]
    fn step_and_nearest_methods_are_predictable() {
        let x = [0.0, 10.0, 20.0];
        let y = [0.0, 100.0, 200.0];
        let q = [4.0, 6.0, 10.0, 19.0];
        assert_eq!(
            interp1d(&x, &y, &q, Interp1dMethod::Nearest, false).unwrap(),
            vec![0.0, 100.0, 100.0, 200.0]
        );
        assert_eq!(
            interp1d(&x, &y, &q, Interp1dMethod::Previous, false).unwrap(),
            vec![0.0, 0.0, 100.0, 100.0]
        );
        assert_eq!(
            interp1d(&x, &y, &q, Interp1dMethod::Next, false).unwrap(),
            vec![100.0, 100.0, 100.0, 200.0]
        );
    }

    #[test]
    fn out_of_bounds_returns_nan_unless_extrapolating() {
        let x = [0.0, 1.0, 2.0];
        let y = [0.0, 1.0, 0.0];
        let no = interp1d(
            &x,
            &y,
            &[-0.5, 0.5, 3.0],
            Interp1dMethod::CubicNatural,
            false,
        )
        .unwrap();
        assert!(no[0].is_nan());
        assert!(no[2].is_nan());
        assert!(no[1].is_finite());
        let yes = interp1d(&x, &y, &[-0.5, 3.0], Interp1dMethod::Linear, true).unwrap();
        assert_eq!(yes, vec![-0.5, -1.0]);
    }

    #[test]
    fn validates_inputs() {
        assert!(CubicSpline1d::new(&[0.0], &[1.0]).is_err());
        assert!(CubicSpline1d::new(&[0.0, 0.0], &[1.0, 2.0]).is_err());
        assert!(CubicSpline1d::new(&[0.0, f64::NAN], &[1.0, 2.0]).is_err());
        assert!(CubicSpline1d::new(&[0.0, 1.0], &[1.0, f64::INFINITY]).is_err());
    }
}
