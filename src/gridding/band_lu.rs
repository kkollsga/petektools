//! An **unpivoted band LU** factorization, factored once and back-substituted
//! per right-hand side.
//!
//! The minimum-curvature conditioning system (a tensioned 13-point biharmonic
//! stencil fused with the bilinear data-fit normal equations; see
//! [`super::mincurv_operator`]) is sparse and — under a lattice-lexicographic
//! node ordering along the **shorter** axis — **banded** with half-bandwidth
//! `b ≈ 2·min(ncol, nrow)`. Its symmetric part is positive-definite, but the
//! **natural-dip boundary** (the linear extrapolation `z[t] = 2 z[t+1] − z[t+2]`
//! of [`super::min_curvature`]'s `z_at`, resolved i-before-j) makes the corner
//! rows slightly **non-symmetric**, so an LU — not a Cholesky — is the direct
//! solver that reproduces the SOR fixed point *exactly*.
//!
//! Unpivoted Gaussian elimination on a banded matrix preserves the band with
//! **no fill** (Golub & Van Loan 2013, §4.3.1): `L` keeps `b` sub-diagonals, `U`
//! keeps `b` super-diagonals. It is stable here because the matrix's symmetric
//! part is positive-definite (the biharmonic energy Hessian + the PSD data
//! block); a pivot that collapses to ~0 is reported so the caller falls back to
//! the iterative kernel. No pivoting → the elimination order is fixed → the
//! factorization is bit-deterministic.
//!
//! Kept in-crate deliberately, exactly as the dense kriging LU
//! ([`super::kriging`] `solve`): a textbook banded LU, the leaf must stay
//! portable (no LAPACK/BLAS system dependency, PyO3-wheel friendly), and
//! determinism is a hard requirement. A lattice-lexicographic (natural) ordering
//! already gives a minimal band on a regular grid — the fill-reducing
//! reorderings (Cuthill & McKee 1969; AMD) that a general sparse solver needs are
//! unnecessary for this structured pattern.
//!
//! References (independent derivation; standard academic attribution):
//! - Golub, G.H. & Van Loan, C.F. (2013), *Matrix Computations*, 4th ed.,
//!   §3.2 (LU) & §4.3.1 (band LU, no-fill).
//! - Davis, T.A. (2006), *Direct Methods for Sparse Linear Systems*, SIAM.
//! - Cuthill, E. & McKee, J. (1969), *Reducing the bandwidth of sparse symmetric
//!   matrices*, Proc. 24th ACM Nat. Conf. — why the natural lattice ordering
//!   already minimizes the band here.

/// A square band matrix under assembly, then factored in place to its unpivoted
/// `LU`. Both triangles are stored: for row `i`, columns
/// `[i.saturating_sub(bw) ..= (i+bw).min(n-1)]`.
///
/// Storage: `a` is `n × (2·bw + 1)` row-major; slot `a[i*(2bw+1) + (j - i + bw)]`
/// is matrix entry `(i, j)` for `|i - j| <= bw`. After [`factor`](Self::factor):
/// the strict-lower band holds `L`'s multipliers (unit diagonal implicit) and the
/// upper band (diagonal included) holds `U`.
pub(crate) struct BandLu {
    n: usize,
    /// Half-bandwidth: sub- and super-diagonal count. `bw == 0` is pure-diagonal.
    bw: usize,
    /// Band storage, `n × (2·bw+1)` row-major.
    a: Vec<f64>,
    /// Row stride (`2·bw + 1`).
    stride: usize,
    factored: bool,
}

impl BandLu {
    /// A zero `n × n` band matrix with half-bandwidth `bw`, ready for
    /// [`add`](Self::add) then [`factor`](Self::factor).
    pub(crate) fn zeros(n: usize, bw: usize) -> Self {
        let stride = 2 * bw + 1;
        BandLu {
            n,
            bw,
            a: vec![0.0; n.saturating_mul(stride)],
            stride,
            factored: false,
        }
    }

    #[inline]
    fn idx(&self, i: usize, j: usize) -> usize {
        debug_assert!(i.abs_diff(j) <= self.bw, "entry outside the band");
        i * self.stride + (j + self.bw - i)
    }

    /// Accumulate `val` into entry `(i, j)`. `|i - j| <= bw` is required.
    pub(crate) fn add(&mut self, i: usize, j: usize, val: f64) {
        let k = self.idx(i, j);
        self.a[k] += val;
    }

    /// Factor the assembled matrix in place to `A = L·U` (unit-lower `L`, no
    /// pivoting, band-preserving). Returns `false` if a pivot collapses relative
    /// to the matrix scale — i.e. the system is (near-)singular — or goes
    /// non-finite; the caller then falls back to the iterative kernel.
    ///
    /// Near-singularity is judged against the largest original diagonal
    /// magnitude: a pivot below `1e-10 ·` that scale is treated as a rank
    /// deficiency (an under-constrained surface whose plane null space is not
    /// pinned), comfortably separating a genuine (well-conditioned-lattice)
    /// biharmonic pivot from a machine-epsilon-scale collapse.
    pub(crate) fn factor(&mut self) -> bool {
        let (n, bw, stride) = (self.n, self.bw, self.stride);
        let scale = (0..n)
            .map(|k| self.a[k * stride + bw].abs())
            .fold(0.0_f64, f64::max);
        let pivot_floor = 1e-10 * scale;
        for k in 0..n {
            let piv = self.a[k * stride + bw]; // (k, k)
            if !piv.is_finite() || piv.abs() <= pivot_floor {
                return false;
            }
            let ihi = (k + bw).min(n - 1);
            for i in (k + 1)..=ihi {
                // f = A(i,k) / piv
                let f = self.a[i * stride + (k + bw - i)] / piv;
                if !f.is_finite() {
                    return false;
                }
                self.a[i * stride + (k + bw - i)] = f; // store L multiplier
                if f == 0.0 {
                    continue;
                }
                // Row i -= f · row k, over U's columns k+1 ..= k+bw.
                let jhi = (k + bw).min(n - 1);
                for j in (k + 1)..=jhi {
                    let akj = self.a[k * stride + (j + bw - k)];
                    self.a[i * stride + (j + bw - i)] -= f * akj;
                }
            }
        }
        self.factored = true;
        true
    }

    /// Solve `A·x = b` into `out` (cleared and refilled) against the factored
    /// `L·U`. `b.len()` must equal `n`. `O(n·bw)`.
    // The triangular-solve inner loops index the packed band alongside the running
    // vector, so an iterator rewrite would not simplify them.
    #[allow(clippy::needless_range_loop)]
    pub(crate) fn solve_into(&self, b: &[f64], out: &mut Vec<f64>) {
        debug_assert!(self.factored, "solve before a successful factor");
        debug_assert_eq!(b.len(), self.n);
        let (n, bw, stride) = (self.n, self.bw, self.stride);
        out.clear();
        out.extend_from_slice(b);

        // Forward: L·y = b (unit-lower L, multipliers in the strict-lower band).
        for i in 0..n {
            let klo = i.saturating_sub(bw);
            let mut sum = out[i];
            for k in klo..i {
                sum -= self.a[i * stride + (k + bw - i)] * out[k];
            }
            out[i] = sum;
        }
        // Back: U·x = y (U in the upper band, diagonal included).
        for i in (0..n).rev() {
            let khi = (i + bw).min(n - 1);
            let mut sum = out[i];
            for k in (i + 1)..=khi {
                sum -= self.a[i * stride + (k + bw - i)] * out[k];
            }
            out[i] = sum / self.a[i * stride + bw];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    /// A small band system solved against a hand value (tridiagonal, bw=1).
    #[test]
    fn solves_a_known_system() {
        // A = [[4,1,0],[1,4,1],[0,1,4]], x=[1,2,3] → b=[6,12,14].
        let mut m = BandLu::zeros(3, 1);
        for (i, v) in [4.0, 4.0, 4.0].into_iter().enumerate() {
            m.add(i, i, v);
        }
        m.add(1, 0, 1.0);
        m.add(0, 1, 1.0);
        m.add(2, 1, 1.0);
        m.add(1, 2, 1.0);
        assert!(m.factor());
        let mut x = Vec::new();
        m.solve_into(&[6.0, 12.0, 14.0], &mut x);
        assert_relative_eq!(x[0], 1.0, epsilon = 1e-12);
        assert_relative_eq!(x[1], 2.0, epsilon = 1e-12);
        assert_relative_eq!(x[2], 3.0, epsilon = 1e-12);
    }

    /// Factor once, solve several RHS against the same factorization.
    #[test]
    fn factor_once_solve_many() {
        let mut m = BandLu::zeros(2, 1);
        m.add(0, 0, 3.0);
        m.add(1, 1, 4.0);
        assert!(m.factor());
        let mut x = Vec::new();
        m.solve_into(&[6.0, 8.0], &mut x);
        assert_relative_eq!(x[0], 2.0, epsilon = 1e-12);
        assert_relative_eq!(x[1], 2.0, epsilon = 1e-12);
        m.solve_into(&[3.0, 4.0], &mut x);
        assert_relative_eq!(x[0], 1.0, epsilon = 1e-12);
        assert_relative_eq!(x[1], 1.0, epsilon = 1e-12);
    }

    /// An **asymmetric** band system — LU (unlike Cholesky) handles it, matching
    /// the boundary-fold asymmetry of the real operator.
    #[test]
    fn solves_asymmetric_system() {
        // A = [[3,1],[-4,2]] (asymmetric). x=[1,2] → b=[5,0].
        let mut m = BandLu::zeros(2, 1);
        m.add(0, 0, 3.0);
        m.add(0, 1, 1.0);
        m.add(1, 0, -4.0);
        m.add(1, 1, 2.0);
        assert!(m.factor());
        let mut x = Vec::new();
        m.solve_into(&[5.0, 0.0], &mut x);
        assert_relative_eq!(x[0], 1.0, epsilon = 1e-12);
        assert_relative_eq!(x[1], 2.0, epsilon = 1e-12);
    }

    /// A wider band (bw=2) pentadiagonal, asymmetric, cross-checked against a
    /// dense reference multiply.
    #[test]
    #[allow(clippy::needless_range_loop)]
    fn solves_pentadiagonal() {
        let n = 6;
        let mut m = BandLu::zeros(n, 2);
        let dense = |i: usize, j: usize| -> f64 {
            match i as isize - j as isize {
                0 => 6.0,
                1 => -1.0,  // sub
                -1 => -1.5, // super (asymmetric)
                2 => -0.5,
                -2 => -0.25,
                _ => 0.0,
            }
        };
        for i in 0..n {
            for j in 0..n {
                let v = dense(i, j);
                if v != 0.0 {
                    m.add(i, j, v);
                }
            }
        }
        assert!(m.factor());
        let x_true = [1.0, -2.0, 3.0, 0.5, -1.5, 2.0];
        let mut b = [0.0; 6];
        for i in 0..n {
            for j in 0..n {
                b[i] += dense(i, j) * x_true[j];
            }
        }
        let mut x = Vec::new();
        m.solve_into(&b, &mut x);
        for (got, want) in x.iter().zip(x_true.iter()) {
            assert_relative_eq!(got, want, epsilon = 1e-10);
        }
    }

    /// A zero pivot is reported (a singular system), not silently divided by.
    #[test]
    fn detects_zero_pivot() {
        let mut m = BandLu::zeros(2, 1);
        m.add(0, 0, 0.0);
        m.add(0, 1, 1.0);
        m.add(1, 0, 1.0);
        m.add(1, 1, 1.0);
        assert!(!m.factor());
    }
}
