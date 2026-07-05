//! A compact dense LU solver for the (small) kriging systems.
//!
//! Global [`OrdinaryKriging`] builds one dense `(n+1) × (n+1)` symmetric-indefinite
//! (saddle-point) coefficient matrix **shared by every grid node** — only the
//! right-hand side changes per node — so it factors once (LU with partial
//! pivoting) and back-substitutes per node, rather than re-solving from scratch.
//! The per-node kernels — moving-neighbourhood [`LocalKriging`] and the
//! simple-kriging core behind [`sgs`] — reuse the same factorisation for their
//! own small `(n+1) × (n+1)` / `n × n` systems, one factor-and-solve per node.
//!
//! [`OrdinaryKriging`]: crate::OrdinaryKriging
//! [`LocalKriging`]: crate::geostat::LocalKriging
//! [`sgs`]: crate::geostat::sgs
//!
//! This is the textbook Gaussian-elimination / LU factorisation with partial
//! pivoting (Golub, G.H. & Van Loan, C.F. (2013), *Matrix Computations*, 4th ed.,
//! Algorithms 3.2.1 & 3.4.1). It is kept in-crate deliberately: the system here
//! is tiny, the kernel must stay a portable pure leaf (no LAPACK/BLAS system
//! dependency, PyO3-wheel friendly), and the factorisation is fully
//! deterministic. A dedicated dense-algebra backend (`faer`) remains the option
//! if large local-neighbourhood systems are added later.

/// Factor the `n × n` row-major matrix `a` **in place** (`a` becomes the packed
/// `LU`), writing the partial-pivot permutation into `perm` (reset and refilled).
/// Returns `false` if the matrix is singular to working precision (a zero pivot
/// survives pivoting), leaving `a` partially reduced.
///
/// This is the scratch-reusing core: it borrows the coefficient buffer and the
/// permutation vector instead of consuming/allocating them, so a caller solving
/// millions of tiny systems (moving-neighbourhood kriging, sequential simulation)
/// factors into retained buffers with **no per-solve allocation**. Bit-for-bit
/// the same arithmetic as the owning [`LuFactorization::factor`], which delegates
/// here.
pub(crate) fn lu_factor_in_place(a: &mut [f64], n: usize, perm: &mut Vec<usize>) -> bool {
    debug_assert_eq!(a.len(), n * n);
    perm.clear();
    perm.extend(0..n);

    for k in 0..n {
        // Partial pivot: largest-magnitude entry in column k, rows k..n.
        let mut pivot_row = k;
        let mut pivot_mag = a[k * n + k].abs();
        for i in k + 1..n {
            let mag = a[i * n + k].abs();
            if mag > pivot_mag {
                pivot_mag = mag;
                pivot_row = i;
            }
        }
        if pivot_mag == 0.0 {
            return false; // singular
        }
        if pivot_row != k {
            for col in 0..n {
                a.swap(k * n + col, pivot_row * n + col);
            }
            perm.swap(k, pivot_row);
        }

        let pivot = a[k * n + k];
        for i in k + 1..n {
            let factor = a[i * n + k] / pivot;
            a[i * n + k] = factor; // store the multiplier in L
            for col in k + 1..n {
                a[i * n + col] -= factor * a[k * n + col];
            }
        }
    }
    true
}

/// Solve `A x = b` into `out` (reset and refilled with the solution), against the
/// packed `lu`/`perm` from [`lu_factor_in_place`]. `b` is read-only (preserved) in
/// its original, unpermuted row order; `b.len()` must equal `n`.
///
/// Scratch-reusing twin of [`LuFactorization::solve`] (which delegates here): the
/// solution buffer is reused rather than allocated. The permute-then-in-place
/// forward/back substitution is the *same* sequence of floating-point operations
/// as the owning solver — the reuse is an allocation change only.
// The triangular-solve inner loops index the packed LU matrix by `(i, j)`
// alongside the running vector, so an iterator rewrite would not simplify them.
#[allow(clippy::needless_range_loop)]
pub(crate) fn lu_solve_into(lu: &[f64], perm: &[usize], n: usize, b: &[f64], out: &mut Vec<f64>) {
    debug_assert_eq!(b.len(), n);
    debug_assert_eq!(lu.len(), n * n);

    // Apply the row permutation to the RHS into the reused buffer.
    out.clear();
    out.extend((0..n).map(|i| b[perm[i]]));

    // Forward substitution: L y = P b (L unit-lower, multipliers in `lu`).
    for i in 0..n {
        let mut sum = out[i];
        for j in 0..i {
            sum -= lu[i * n + j] * out[j];
        }
        out[i] = sum;
    }

    // Back substitution: U x = y (in place on the same buffer).
    for i in (0..n).rev() {
        let mut sum = out[i];
        for j in i + 1..n {
            sum -= lu[i * n + j] * out[j];
        }
        out[i] = sum / lu[i * n + i];
    }
}

/// An in-place LU factorisation `PA = LU` of a square matrix, with the partial-
/// pivot permutation. Solve any number of right-hand sides against it.
///
/// The owning form: takes the matrix by value and allocates its own buffers. The
/// hot per-node kernels instead call [`lu_factor_in_place`] / [`lu_solve_into`]
/// against retained scratch; both paths run identical arithmetic.
pub(crate) struct LuFactorization {
    /// `n × n`, row-major: unit-lower `L` (below the diagonal) and `U` (on/above).
    lu: Vec<f64>,
    /// Row permutation: `perm[i]` is the original row now in position `i`.
    perm: Vec<usize>,
    n: usize,
}

impl LuFactorization {
    /// Factor the `n × n` row-major matrix `a` (consumed). Returns `None` if the
    /// matrix is singular to working precision (a zero pivot survives pivoting).
    pub(crate) fn factor(mut a: Vec<f64>, n: usize) -> Option<LuFactorization> {
        let mut perm: Vec<usize> = Vec::with_capacity(n);
        if lu_factor_in_place(&mut a, n, &mut perm) {
            Some(LuFactorization { lu: a, perm, n })
        } else {
            None
        }
    }

    /// Solve `A x = b` for `x`, given `b` in the original (unpermuted) row order.
    /// `b.len()` must equal the matrix dimension.
    /// Allocating convenience over [`solve_into`](Self::solve_into) — used by the
    /// unit tests; every production path now solves into a retained buffer.
    #[cfg(test)]
    pub(crate) fn solve(&self, b: &[f64]) -> Vec<f64> {
        let mut out = Vec::with_capacity(self.n);
        lu_solve_into(&self.lu, &self.perm, self.n, b, &mut out);
        out
    }

    /// As [`solve`](Self::solve), but into a caller-retained solution buffer
    /// (reset and refilled) — the zero-allocation form for a caller solving one
    /// factorisation against many right-hand sides (global ordinary kriging's
    /// per-node loop). Identical arithmetic to [`solve`](Self::solve).
    pub(crate) fn solve_into(&self, b: &[f64], out: &mut Vec<f64>) {
        lu_solve_into(&self.lu, &self.perm, self.n, b, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn solves_a_known_system() {
        // A = [[2,1,1],[4,-6,0],[-2,7,2]], b = [5,-2,9] -> x = [1,1,2].
        let a = vec![2.0, 1.0, 1.0, 4.0, -6.0, 0.0, -2.0, 7.0, 2.0];
        let lu = LuFactorization::factor(a, 3).unwrap();
        let x = lu.solve(&[5.0, -2.0, 9.0]);
        assert_relative_eq!(x[0], 1.0, epsilon = 1e-12);
        assert_relative_eq!(x[1], 1.0, epsilon = 1e-12);
        assert_relative_eq!(x[2], 2.0, epsilon = 1e-12);
    }

    #[test]
    fn factor_once_solve_many() {
        // Identity-ish reuse: same factorisation, several RHS.
        let a = vec![3.0, 0.0, 0.0, 4.0]; // [[3,0],[0,4]]? row-major 2x2
        let lu = LuFactorization::factor(a, 2).unwrap();
        let x1 = lu.solve(&[6.0, 8.0]);
        let x2 = lu.solve(&[3.0, 4.0]);
        assert_relative_eq!(x1[0], 2.0, epsilon = 1e-12);
        assert_relative_eq!(x1[1], 2.0, epsilon = 1e-12);
        assert_relative_eq!(x2[0], 1.0, epsilon = 1e-12);
        assert_relative_eq!(x2[1], 1.0, epsilon = 1e-12);
    }

    #[test]
    fn needs_pivoting() {
        // Zero leading pivot forces a row swap.
        let a = vec![0.0, 1.0, 1.0, 0.0]; // [[0,1],[1,0]] -> swaps x,y
        let lu = LuFactorization::factor(a, 2).unwrap();
        let x = lu.solve(&[3.0, 7.0]);
        assert_relative_eq!(x[0], 7.0, epsilon = 1e-12);
        assert_relative_eq!(x[1], 3.0, epsilon = 1e-12);
    }

    #[test]
    fn detects_singular() {
        let a = vec![1.0, 2.0, 2.0, 4.0]; // rank 1
        assert!(LuFactorization::factor(a, 2).is_none());
    }
}
