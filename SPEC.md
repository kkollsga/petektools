# petekTools — design constitution

The rules that keep this library robust and scalable as it grows. `API.md` is
the *what* (the locked surface); this is the *why* and the *how*.

## 1. One job: the numerics Rust is missing

petekTools exists for **scattered-data gridding / geostatistics** — the one
gap with no production-grade Rust crate. Everything else it touches (linear
algebra, stats, distributions, neighbour search) it **curates** from mature
crates (`faer`, `statrs`, `rand_distr`, `kiddo`, `rstar`), never reimplements.
If a need is already met by a good crate, depend on it.

## 2. Pure leaf, one direction

petekTools depends only on general-purpose numeric crates — **never** on
petekio or petekSim. The dependency arrows run `petekSim → petekio →
petekTools`; there are no cycles. This is what lets the crate ship and be
tested on its own (and, later, as a PyO3 wheel).

## 3. Type-agnostic kernels

Kernels take `Lattice` + `[[f64; 3]]` slices and return `ndarray` arrays — never
a consumer's domain type (no `Surface`, no `GridGeometry`, no I/O type). A
consumer adapts at the call boundary. This is the discipline that keeps the leaf
reusable and the boundary thin.

**Carve-out — the `container` module.** The single deliberate exception to
"no I/O" is `container`: a *domain-agnostic* single-file section container
lifted here so all layers share one framing. It does no domain- or
format-specific I/O — it round-trips opaque, tagged byte blobs and knows nothing
about any caller's domain. Domain/format I/O (parsing surfaces, wells, DTOs)
stays in petekio.

**Carve-out — the `store` unit.** The chunked, memory-mapped lane store (the
spill-to-disk backing for larger-than-memory models; out-of-core ruling R1). Like
`container` it does only *domain-agnostic* array I/O — it round-trips named,
typed, k-slab-chunked binary lanes and knows nothing about ZCORN/PORO/COORD
beyond their shape. It is also the one place the crate's `deny(unsafe_code)` is
locally relaxed, for the two `memmap2` map calls only (each carries a `SAFETY`
note). No heavy deps (`memmap2` + `bytemuck`; no HDF5/Arrow/parquet), fixed
strides, no compression.

**Carve-out — the `viewer` unit (`petektools.viewer`, wheel-only).** A third
deliberate exception, in the same spirit: a *domain-agnostic* renderer of **typed
JSON bundles** — map raster layers, section columns, a corner-point mesh (and,
later, chart marks) — shipped as petekTools wheel package data (the crates.io Rust
kernel crate excludes it and stays lean; the Rust kernel charter is unwidened).
It carries **no domain logic, performs no computation, and does no domain I/O**:
it draws exactly what the payload declares. New cross-sections come from a
consumer-supplied `section_provider` callback (live) or are pre-computed into the
payload (file). petekTools defines the **generic render schema** (its contract,
`python/petektools/viewer/SCHEMA.md`); each library maps its domain bundles onto
it (petekStatic `StaticModel` views, petekIO logs/crossplots, peteksim MC charts).
The viewer is horizontal capability because it serves all layers — owner ruling
`decision_viewer_home_petektools` (2026-07-04).

## 4. Hold parity with the source you consolidate

Where a kernel is lifted from petekio (the author's own prior art — the GATE-0
kernels came from petekio 0.2.0 via the now-retired `transfer/` knowledge base),
keep behaviour parity — same algorithm, same defaults, same tolerances — and
carry the citation. Parity is what makes a future delegation (petekio calling
these kernels) safe; it is pinned for the geometry by `tests/lattice_parity.rs`.

## 5. Split the elephant

One module per concept, one concept per file; split before a file does two jobs.
Layering, lowest to highest:

```
foundation/   error + Lattice (the vocabulary everything speaks)
gridding/     scattered-data → grid kernels (one file per method) + kriging
stats/        curated descriptive statistics (unweighted + weighted)
sampling/     curated distribution sampling
units/        domain-agnostic unit conversions
container/    domain-agnostic single-file section container (the I/O carve-out)
store/        domain-agnostic chunked mmap lane store (the out-of-core carve-out)
py/           PyO3 bindings — a workspace member, thin over the above
python/petektools/viewer/   the viewer unit — wheel-only, domain-agnostic bundle
              renderer (JS assets + serve/save_view); excluded from the Rust crate
```

Boundaries are traits where backends are plural (the future `Gridder` trait for
kriging/RBF); enums where the set is small and closed (`GridMethod`).

## 6. PyO3-ready by construction

Public kernel signatures stay binding-friendly: owned inputs, no public
lifetimes, plain numeric types and `ndarray`. When bindings land they are a thin
`py/` member that delegates — no redesign required.

## 7. Numerical honesty

Kernels are deterministic and documented to a stated tolerance; tests assert
analytic cases (a linear trend is the exact minimum-curvature solution, IDW is
exact at coincident samples, etc.). No silent clamping or magic defaults —
locked constants (e.g. IDW `p = 2`) are named and cited.
