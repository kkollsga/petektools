# petekTools

**Scattered-data gridding & geostatistics kernels for Rust** — the numerics
layer the ecosystem is missing.

Rust has excellent crates for linear algebra (`faer`), statistics and
distributions (`statrs`, `rand_distr`), FFT (`rustfft`), and spatial indexing
(`kiddo`, `rstar`). What it has lacked is a production-grade way to turn
**scattered `(x, y, z)` observations into a regular grid** — minimum-curvature
surfaces, inverse-distance weighting, nearest-neighbour fills. petekTools
fills exactly that gap, and curates the rest behind one small front-door.

If you have points and need a surface — a depth grid from well picks, a property
map from samples, any scattered field on a regular lattice — this is the crate.

## Why reach for it

- **Real gridding methods, not toys.** Briggs minimum-curvature (biharmonic SOR),
  inverse-distance weighting, and nearest-neighbour — the workhorses, with their
  defaults and tolerances stated and tested, not hand-waved.
- **Warm-start / incremental re-gridding.** Editing a surface point-by-point?
  Re-solving from scratch each time is wasteful. Seed the solver from the prior
  field and it converges in a fraction of the iterations — **~4–7× faster** on a
  typical structural edit, rising to **~250×** in the near-converged incremental
  limit (measured: 1.55 ms → 13.6 µs, 64 points → 40×40), converging to the same
  field. A stateful [`ConvergentGridder`] makes interactive,
  one-control-at-a-time refinement cheap.
- **Type-agnostic by design.** Kernels speak a plain [`Lattice`] + `[[f64; 3]]`
  rows and return `ndarray::Array2<f64>` — never a domain type. Any regular,
  rotatable areal lattice (the IRAP/RMS model) maps on field-for-field, so
  adoption is a conversion at the call site, not a rewrite.
- **Deterministic and honest.** No RNG, no silent clamping; named, cited
  constants. Analytic cases are asserted as tests — a linear trend is the exact
  minimum-curvature solution, IDW is exact at coincident samples.
- **A pure leaf.** Depends only on general-purpose numeric crates. No I/O, no
  domain model, no heavy framework to adopt — drop it in.
- **Binding-friendly.** Owned inputs, no public lifetimes on kernels; PyO3
  bindings are a planned thin layer over this same surface.

## Install

```sh
cargo add petektools
```

## Quick start

```rust
use petektools::{grid, GridMethod, Lattice};

// A 100×80 grid, 25 m spacing, origin at (1000, 2000).
let lattice = Lattice::regular(1000.0, 2000.0, 25.0, 25.0, 100, 80);

// Scattered observations: [x, y, z] rows.
let points = [
    [1010.0, 2008.0, 12.5],
    [1240.0, 2300.0, 18.1],
    [1880.0, 3100.0,  9.4],
];

// Interpolate onto the grid → an (ncol × nrow) Array2<f64>;
// undefined nodes are NaN.
let surface = grid(&points, &lattice, GridMethod::MinimumCurvature).unwrap();
```

### Methods

| `GridMethod`        | What it does                                              |
| ------------------- | -------------------------------------------------------- |
| `Nearest`           | Each node takes its areally-closest sample's `z` (blocky, exact at data). |
| `InverseDistance`   | Global IDW, `p = 2`; exact at coincident samples.        |
| `MinimumCurvature`  | Briggs biharmonic SOR — smooth, honours the samples.     |

### Warm-start an incremental re-grid

```rust
use petektools::{grid, grid_min_curvature_seeded, GridMethod, Lattice};

let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 64, 64);
let points = [[1.0, 1.0, 10.0], [60.0, 60.0, 40.0]];

let cold = grid(&points, &lattice, GridMethod::MinimumCurvature).unwrap();

// Later, after nudging the data: relax from the prior field instead of
// cold-starting. A None / wrong-shape seed falls back to a cold solve.
let warm = grid_min_curvature_seeded(&points, &lattice, Some(&cold)).unwrap();
```

### Interactive refinement with `ConvergentGridder`

```rust
use petektools::{ConvergentGridder, Lattice};

let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 64, 64);
let points = [[1.0, 1.0, 10.0], [60.0, 60.0, 40.0]];

let mut gridder = ConvergentGridder::new(&points, &lattice).unwrap();

// Pin node (32, 40) to 25.0 as a hard constraint and re-solve incrementally.
let field = gridder.add_control(32, 40, 25.0);   // warm — cheap
// … add more controls; each call returns the updated field.
```

## Geometry: `Lattice`

A regular, **rotatable** areal lattice (the IRAP/RMS model): origin, spacing,
node counts, CCW rotation, and an optional y-flip. It carries the forward map
`node_xy(i, j)` and its inverse `xy_to_ij(x, y)`, plus a `bbox()` — everything a
kernel needs to place a sample on the grid.

## Design

- **One job.** Scattered-data gridding / geostatistics — the gap. Everything else
  (linear algebra, stats, neighbour search) is curated from mature crates, never
  reimplemented.
- **Type-agnostic kernels.** `Lattice` + `[[f64; 3]]` in, `ndarray` out. No
  domain types, no I/O.
- **Numerical honesty.** Deterministic, documented to a stated tolerance, with
  analytic tests as the safety net.

See [`SPEC.md`](SPEC.md) for the design constitution and [`API.md`](API.md) for
the locked public contract.

## Status & roadmap

The public contract — `Lattice`, `GridMethod`, `grid`, the warm-start entries —
is **locked and analytically tested**. Also shipped: ordinary kriging behind a
`Gridder` trait, the curated `stats` / `sampling` front-doors over `statrs` /
`rand_distr`, and the `units` / `container` modules. On the roadmap: a PyO3
wheel (and RBF backends if a need appears).

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
