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

**Carve-out — the `asset` unit (`petektools.synth_asset`, wheel-only).** A
deliberate pure-Python test-data writer for synthetic Petrel-export-shaped
trees and single-file format fixtures. It lives in the wheel, not the Rust
crate: the Rust core still owns only generators over `Lattice` + plain arrays.
The writer emits vendor formats so downstream loaders can prove the ingest seam,
but it carries no domain model and no confidential data. `spill_recipe` remains
in petekSim because it depends on the static-model live-set formula.

**Carve-out — the `viewer` unit (`petektools.viewer`, wheel-only).** A third
deliberate exception, in the same spirit: a *domain-agnostic* renderer of **typed
JSON bundles** — map raster layers, section columns, a corner-point mesh (and,
later, chart marks) — shipped as petekTools wheel package data (the crates.io Rust
kernel crate excludes it and stays lean; the Rust kernel charter is unwidened).
It carries **no domain logic, performs no computation, and does no domain I/O**:
it draws exactly what the payload declares. Its generic Python adapters may
discover producer-declared render lanes through small duck-typed conventions
(`value_layer` / `attr_names`), but never interpret their domain meaning. Stable
producer `kind` strings classify points (`point_set`), geometry-only shells
(`grid_geometry`, `structured_shell`, `mesh_shell`), and value surfaces
(`surface`, `structured_mesh`, `tri_surface`) before overlapping method ducks;
only the value-surface role participates in omitted-fill lane discovery.
Workspace-v2 surface attributes preserve the generic descriptor
`{id,label,kind,units,codes}` and expose independent geometry `attribute` and
paint `color_by` selectors; changing geometry resets paint, while explicit paint
selection decouples them. Legacy `lane` maps to both selectors and remains a v1
compatibility path. Attributes over identical topology share one normalized
full/LOD mesh in memory and one content-addressed resource/block table on the
wire. A shared Map carries each attribute value block once, and 2-D/3-D are
camera modes over that resource: neither selector nor mode multiplies live or
static identity. The complete table remains embedded in offline saved views
without an attribute-by-colour Cartesian export.
An exact affine structured fill uses `regular_grid` metadata plus row-major
typed values/mask and never expands nodes or triangles. The renderer maps its
node-centred index raster through `origin + i*step_i + j*step_j`, gives each
node the half-step footprint `[-.5,ncol-.5] × [-.5,nrow-.5]`, uses the inverse
affine for inspection, and treats a false mask or NaN as a hole. It never
averages four nodes or synthesizes a categorical code. Direct ScalarLayer and
compact affine producers therefore share exact geometry, sample colour, fit,
and cursor semantics; TriFill remains the non-affine compatibility path.
Legacy affine 3-D surfaces continue to use typed `regular_surface`
elevation/mask/value blocks. A shared v2 Map instead carries one affine Frame,
mask, and ordered value blocks for both camera modes. `Frame` additively declares
intrinsic rotation/y-flip and optional free-text CRS/world units; absent fields
retain the historic axis-aligned behavior and are never guessed. The 2-D camera
is an independent view transform: zero is east-right/north-up, positive camera
rotation turns north clockwise on screen, and its north HUD never inherits the
Frame's intrinsic rotation or y-flip. Fit, hit testing, cached geometry, wells,
and overlays all use that one exact world/screen composition. The fixed
screen-space HUD reports zoom, a constant-scale 2-D bar, and the exact inverse
cursor world coordinate plus available i/j/value; it prints CRS and unit suffixes
only when the Frame/attribute declares them. Perspective/3-D gets no misleading
constant scale bar. The focusable Map provides keyboard pan/zoom/north-up parity
without rotating HUD text or labels. A provider may
advertise ordered preview/full tiers; preview is rendered first, full builds
GPU-ready position/index/colour arrays from the already decoded shared blocks in
bounded yielding chunks, and the renderer swaps it without clearing preview
state, moving either camera, or re-entering global Loading. Shared source blocks
are reference-only descriptors: they are neither cloned nor transferred; only
the derived topology, position, paint, and GPU allocations are cached. A paint
change reuses the stable scene and GPU topology, while a mask or scene-center
change invalidates positions. Full evicts that item's superseded preview without
disturbing another still-preview item; null mask remains implicit all-valid and
allocates no hidden raster. Static export embeds the full tier once when it is
advertised.
Map resources may also carry additive contextual well overlays keyed by stable
surface/fill and base-well item identities. Selection is local to the already
materialized bundle: the active fill atomically chooses the producer-declared
trajectory for draw and fit, while base wellhead/style/visibility remain
unchanged. Producers may add an MD-ordered `intersections` list; the viewer uses
the greatest-MD pick among visible contexts while singular `intersection`
remains the compatibility fallback. The stable candidate order is catalog
context then MD/source-record order; an accessible screen-space control gives
pointer and keyboard users the same deterministic cycle, resetting only when
visibility changes the candidate signature. `no_hit` retains the wellhead marker
and `error` remains a localized diagnostic even when another surface has a valid
hit. petekTools does not compute intersections,
measured depth, clipping, or depth conversion; missing and invalid records
degrade locally to base paths.
Its optional project-workspace shell is equally generic: an insertion-ordered
tree, or a producer's `view_catalog()` / `view_resource()` duck, supplies stable
render-item IDs and typed resources. petekTools never traverses a project,
interprets an asset role, or computes a section; managed libraries own those
catalog and resource adapters.
Project-backed v2 producers supply persisted display title, free-text CRS, and
primary project unit plus durable per-attribute metadata; older/unknown values
remain absent. Continuous colormap state is the pair `(colormap,
colormap_reversed)`, with reverse defaulting false and categorical code tables
never degraded to a continuous ramp.
The shell treats navigation and rendering state explicitly: small actionable
branches disclose without materialization, user expansion never fetches, lazy
views report loading/empty/malformed/runtime states locally, and deferred/LOD
work cannot reset a user-owned camera. Control buttons share one accessible
tooltip channel while data inspection in Map/3-D remains click-to-toggle.
cross-sections come from a consumer-supplied `section_provider` callback (live)
or are pre-computed into the
payload (file). petekTools defines the **generic render schema** (its contract,
`python/petektools/viewer/SCHEMA.md`); each library maps its domain bundles onto
it (petekStatic `StaticModel` views, petekIO logs/crossplots, peteksim MC charts).
The viewer is horizontal capability because it serves all layers — owner ruling
`decision_viewer_home_petektools` (2026-07-04).

Viewer layout specifications such as `CorrelationTemplate` are similarly
domain-agnostic JSON values: they name generic curve lanes, scales, tracks and
marks but never import or interpret a petekIO/petekStatic/petekSim object. A
producer may persist the dictionary and apply it to its own bundle; petekTools
owns validation and rendering without a reverse dependency.

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
