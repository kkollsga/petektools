# petekTools — locked public API (GATE 0)

> **This file is the contract.** The build must expose exactly these signatures
> (names, arguments, return types). Bodies are the implementer's; the *surface*
> is fixed. Changing a signature here requires sign-off. See `SPEC.md` for the
> design constitution.

Conventions: `Result<T> = std::result::Result<T, AlgoError>`; grids are
`ndarray::Array2<f64>` shaped `(ncol, nrow)`; undefined node = `NaN`. Kernels are
**type-agnostic** — they speak `Lattice` + `[[f64; 3]]`, never a consumer type.

---

## foundation

```rust
pub type Result<T> = std::result::Result<T, AlgoError>;

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]                    // match with a wildcard arm; new variants are non-breaking
pub enum AlgoError {
    EmptyInput(&'static str),       // a kernel got no data
    InvalidGeometry(&'static str),  // degenerate lattice / singular kriging system
    InvalidArgument(String),        // bad parameter / out-of-range (stats, sampling, variogram, geostat)
    Io(#[from] std::io::Error),     // container: file open/read/write
    Parse(String),                  // container: corrupt / unparsable bytes
    NotFound(String),               // container: no such section
}

pub struct BBox { pub xmin: f64, pub ymin: f64, pub xmax: f64, pub ymax: f64 }

/// Regular, rotatable areal lattice (IRAP/RMS model). Field- and behaviour-
/// identical to petekio's `GridGeometry` so adoption is a 1:1 map.
pub struct Lattice {
    pub xori: f64, pub yori: f64,     // origin (node 0,0)
    pub xinc: f64, pub yinc: f64,     // node spacing
    pub ncol: usize, pub nrow: usize, // node counts (i along x, j along y)
    pub rotation_deg: f64,            // CCW of the I-axis from East
    pub yflip: bool,
}
impl Lattice {
    pub fn regular(xori: f64, yori: f64, xinc: f64, yinc: f64,
                   ncol: usize, nrow: usize) -> Lattice;  // unrotated, unflipped
    pub fn yflip_factor(&self) -> f64;
    pub fn node_xy(&self, i: usize, j: usize) -> (f64, f64);
    pub fn xy_to_ij(&self, x: f64, y: f64) -> Option<(f64, f64)>; // fractional; None if degenerate
    pub fn bbox(&self) -> BBox;
}
```

## gridding

```rust
pub enum GridMethod { Nearest, InverseDistance, MinimumCurvature }

/// Interpolate scattered `[x, y, z]` rows onto `lattice`. Returns the
/// `(ncol × nrow)` node array (NaN where undefined). Errs only on empty input.
pub fn grid(coords: &[[f64; 3]], lattice: &Lattice, method: GridMethod)
    -> Result<ndarray::Array2<f64>>;
```

The three methods mirror petekio's so its `PointSet::to_surface(geom, method)`
can later delegate here by mapping `GridGeometry → Lattice`.

## interp — 1-D resampling kernels

```rust
pub enum Interp1dMethod { Nearest, Previous, Next, Linear, CubicNatural }

pub struct CubicSpline1d { /* private: knots, values, natural second derivatives */ }

impl CubicSpline1d {
    pub fn new(x: &[f64], y: &[f64]) -> Result<CubicSpline1d>;
    pub fn evaluate(&self, q: f64, extrapolate: bool) -> f64;
    pub fn evaluate_many(&self, query: &[f64], extrapolate: bool) -> Vec<f64>;
}

pub fn interp1d(
    x: &[f64],
    y: &[f64],
    query: &[f64],
    method: Interp1dMethod,
    extrapolate: bool,
) -> Result<Vec<f64>>;
```

`x` must be finite, strictly increasing, and match `y.len()`. `CubicNatural` is
an independent natural cubic spline implementation (`S'' = 0` at both endpoints), not SciPy's
default not-a-knot boundary condition. Python exposes this as
`pt.interp1d(x, y, query, method="linear", extrapolate=False)` with method names
`nearest`/`closest`, `previous`/`ffill`, `next`/`bfill`, `linear`, and
`cubic`/`spline`.

## gridding — grid → grid resample (added; additive/non-breaking)

Resample a native regular grid (values on a georeferencing `Lattice`) onto a
foreign target `Lattice` — the grid → grid counterpart to the scattered → grid
kernels. **Axis-aligned only** (`rotation_deg == 0`; `yflip` honoured through the
coordinate maps): Petrel exports are axis-aligned, rotation is future work. No new
georef type — the source `Lattice` already carries origin + spacing + counts in
world coordinates.

**Null / extent policy:** a target node outside the source extent
(`[0, ncol−1] × [0, nrow−1]` in source index space) is `NaN` — never
extrapolated. `Nearest` snaps to the closest node (`NaN` if it is `NaN`).
`Bilinear` null policy: `NaN` if the *nearest* of the four corners is `NaN`,
else the weighted mean over the **finite** corners with the weights
**renormalized** (a `NaN` corner is dropped, not treated as zero).

```rust
pub enum ResampleMethod { Bilinear, Nearest }

/// Resample `src_grid` (shaped `(src_georef.ncol, src_georef.nrow)`, NaN =
/// undefined) onto `target`'s node lattice. Errors on a src_grid/src_georef
/// shape mismatch or degenerate source geometry.
pub fn resample(src_grid: &ndarray::Array2<f64>, src_georef: &Lattice,
                target: &Lattice, method: ResampleMethod) -> Result<ndarray::Array2<f64>>;
```

## units

Domain-agnostic oilfield-unit conversion constants and helpers (moved from
petekSim's `srs-units`). Pure `f64` arithmetic — no I/O, no domain types, no
error surface. Namespaced under `units` (not re-exported at the crate root).

**Family convention: SI / metric is the standard** (`decision_si_units_standard`):
metres; **mcm** (`1e6 m³`) / **MSm³** (`1e6 Sm³`, oil); **bcm** (`1e9 Sm³`, gas);
Sm³/d. The imperial factors are **opt-in** for imperial inputs / legacy data. At
this units-labeling layer `1 Sm³ ≡ 1 m³` numerically — the `m³ → MSm³/bcm` and
`scf/stb → Sm³` helpers are a labeling + geometric-scale convention, **not** a
PVT (formation-volume-factor) conversion; any standard-condition temperature /
pressure correction belongs to a PVT model downstream (petekSim). The
`scf ↔ Sm³` factor is the **pure geometric** `ft³ ↔ m³` factor (no such
correction).

```rust
// imperial / oilfield (opt-in)
pub const ACRE_TO_FT2: f64;   // 43_560.0 (square feet per acre)
pub const FT3_PER_BBL: f64;   // 5.614_583_333_333_333 (cubic feet per reservoir bbl)
pub const FT_TO_M: f64;       // 0.3048 (metres per foot, exact)
pub const M3_PER_BBL: f64;    // 0.158_987_294_928 (cubic metres per oil barrel, exact)
pub const BAR_PER_PSI: f64;   // 0.068_947_572_931_683_6 (bar per psi)
pub const MD_TO_M2: f64;      // 9.869_233e-16 (square metres per millidarcy)
// SI / metric reporting scales (the family standard)
pub const M3_PER_MCM: f64;    // 1e6  (cubic metres per mcm)
pub const SM3_PER_MSM3: f64;  // 1e6  (Sm³ per MSm³ — oil)
pub const SM3_PER_BCM: f64;   // 1e9  (Sm³ per bcm — gas)
pub const SCF_PER_SM3: f64;   // 35.314_666_721_488_59 = (1/0.3048)³ (geometric ft³/m³; no std-cond correction)
pub const SM3_PER_STB: f64;   // 0.158_987_294_928 (== M3_PER_BBL; stock-tank is a label, same barrel volume)
pub const M2_PER_KM2: f64;    // 1e6  (square metres per km² — areal report scale)

pub fn acres_to_ft2(acres: f64) -> f64;      // area:   acres    -> ft^2
pub fn acre_ft_to_ft3(acre_ft: f64) -> f64;  // volume: acre-ft  -> ft^3
pub fn ft3_to_acre_ft(ft3: f64) -> f64;      // volume: ft^3     -> acre-ft
pub fn ft3_to_rb(ft3: f64) -> f64;           // volume: ft^3     -> reservoir bbl
pub fn rb_to_ft3(bbl: f64) -> f64;           // volume: bbl      -> ft^3
pub fn degf_to_degr(degf: f64) -> f64;       // temp:   °F       -> °R
pub fn ft_to_m(ft: f64) -> f64;              // length: ft       -> m
pub fn m_to_ft(m: f64) -> f64;               // length: m        -> ft
pub fn m3_to_bbl(m3: f64) -> f64;            // volume: m^3      -> bbl
pub fn bbl_to_m3(bbl: f64) -> f64;           // volume: bbl      -> m^3
pub fn psi_to_bar(psi: f64) -> f64;          // pressure: psi    -> bar
pub fn bar_to_psi(bar: f64) -> f64;          // pressure: bar    -> psi
pub fn md_to_m2(md: f64) -> f64;             // perm:   mD       -> m^2
pub fn m2_to_md(m2: f64) -> f64;             // perm:   m^2      -> mD
// SI reporting helpers
pub fn m3_to_mcm(m3: f64) -> f64;  pub fn mcm_to_m3(mcm: f64) -> f64;    // m³ <-> mcm
pub fn m3_to_msm3(m3: f64) -> f64; pub fn msm3_to_m3(msm3: f64) -> f64;  // Sm³ <-> MSm³ (oil)
pub fn m3_to_bcm(m3: f64) -> f64;  pub fn bcm_to_m3(bcm: f64) -> f64;    // Sm³ <-> bcm  (gas)
pub fn scf_to_sm3(scf: f64) -> f64; pub fn sm3_to_scf(sm3: f64) -> f64;  // scf <-> Sm³ (geometric)
pub fn stb_to_sm3(stb: f64) -> f64; pub fn sm3_to_stb(sm3: f64) -> f64;  // stb <-> Sm³
pub fn km2_to_m2(km2: f64) -> f64; pub fn m2_to_km2(m2: f64) -> f64;    // km² <-> m² (areal scale)
pub fn format_volume(v_m3: f64) -> String;   // "12.4 mcm" / "4.0 bcm" / "950.0 m³" by magnitude
```

## formula

A domain-free assignment-expression module for vectorized calculations over
named arrays. It has no grid/static-model semantics: `$name` is a scalar runtime
parameter, and a bare symbol is either an input property array or a prior
assignment in the same block.

Supported operators: `+`, `-`, `*`, `/`, `**`; comparisons `==`, `!=`, `<`,
`<=`, `>`, `>=` returning `1.0` or `0.0`; unary `+`/`-`; parentheses; and
functions `sqrt`, `pow`, `log`, `log10`, `exp`, `min`, `max`, `clip`, `abs`,
and vectorized `if(condition, true_value, false_value)`. Scalars broadcast over
arrays; arrays must be equal length. Missing params/properties, cycles, shape
mismatches, invalid assignment lhs, unsupported functions, and parse errors fail
loudly through `AlgoError`.

```rust
pub struct Assignment { /* private fields */ }
impl Assignment {
    pub fn parse(text: &str) -> Result<Self>;
    pub fn lhs(&self) -> &str;
    pub fn params(&self) -> std::collections::BTreeSet<String>;     // no `$`
    pub fn variables(&self) -> std::collections::BTreeSet<String>;  // bare symbols
}

pub struct FormulaBlock { /* private fields */ }
impl FormulaBlock {
    pub fn parse<S: AsRef<str>>(lines: &[S]) -> Result<Self>;
    pub fn assignments(&self) -> &[Assignment];
    pub fn outputs(&self) -> Vec<String>;            // source order
    pub fn evaluation_order(&self) -> Vec<String>;   // dependency order
    pub fn params(&self) -> std::collections::BTreeSet<String>;
    pub fn property_dependencies(&self) -> std::collections::BTreeSet<String>;
    pub fn evaluate(&self,
        properties: &std::collections::HashMap<String, Vec<f64>>,
        params: &std::collections::HashMap<String, f64>)
        -> Result<std::collections::HashMap<String, Vec<f64>>>;
}

pub fn evaluation_order(assignments: &[Assignment]) -> Result<Vec<usize>>;
pub fn evaluate_assignments(assignments: &[Assignment],
    properties: &std::collections::HashMap<String, Vec<f64>>,
    params: &std::collections::HashMap<String, f64>)
    -> Result<std::collections::HashMap<String, Vec<f64>>>;
pub fn evaluate_formulas<S: AsRef<str>>(lines: &[S],
    properties: &std::collections::HashMap<String, Vec<f64>>,
    params: &std::collections::HashMap<String, f64>)
    -> Result<std::collections::HashMap<String, Vec<f64>>>;
```

## container

A **domain-agnostic** single-file section container: file magic + a JSON header
+ per-section `zstd`-compressed opaque `payload` blobs. Round-trips tagged,
versioned, kinded byte blobs with partial reads and byte-lossless
`filter_to` / `merge_to` (compressed blobs copied verbatim — never re-encoded).
Knows nothing about any caller domain. Lifted from petekio's `.pproj` framing;
the **on-disk format is unchanged** (magic `PIO\x01`). petekio layers its GeoData
element DTOs on top; an opaque `model/*` sidecar rides through untouched.
Namespaced under `container` (not re-exported at the crate root).

```rust
pub struct Section {                 // caller's view: metadata + UNcompressed payload
    pub kind: String, pub name: String, pub tags: Vec<String>,
    pub version: u32, pub payload: Vec<u8>,
}
pub struct Entry {                   // one header-index row (metadata only, no payload)
    pub kind: String, pub name: String, pub tags: Vec<String>,
    pub version: u32, pub offset: u64, pub size: u64,
}
pub struct Reader { /* private: file handle + parsed header */ }

/// Write a container, compressing each section payload.
pub fn write(path: &Path, app: &serde_json::Value, data_version: u32,
             sections: &[Section]) -> Result<()>;
/// Open a container (header only; blobs pulled on demand).
pub fn open(path: &Path) -> Result<Reader>;
impl Reader {
    pub fn data_version(&self) -> u32;
    pub fn app(&self) -> &serde_json::Value;
    pub fn entries(&self) -> &[Entry];      // list without reading a blob
    pub fn read(&mut self, name: &str) -> Result<Section>;  // decompress one section
}
/// Copy `src` → `dst` keeping sections whose `Entry` passes `keep` (byte-lossless).
pub fn filter_to(src: &Path, dst: &Path, keep: impl Fn(&Entry) -> bool) -> Result<()>;
/// Merge `a` + `b` → `dst` (on kind+name clash `b` wins); blobs copied verbatim.
pub fn merge_to(a: &Path, b: &Path, dst: &Path) -> Result<()>;
```

---

## store — the chunked mmap lane store (added; namespaced, not root-re-exported)

A **domain-agnostic** chunked, memory-mapped lane store: the spill-to-disk
backing for larger-than-memory models (out-of-core ruling **R1**,
`petekSuite/dev-docs/designs/out-of-core-strategy.md`). A store is one file of
named typed **lanes** chunked along the slow (**k-slab**) axis, so
slab-sequential streaming writes and windowed random reads are both natural.
Same file family as `.pproj` / the v3 wire lanes: little-endian, versioned
header, **fixed strides, no compression** (mmap wants fixed strides — a ruled
non-goal), **no heavy deps** (memmap2 + bytemuck only; no HDF5/Arrow/parquet).
Rust-only in v1. Namespaced under `store`.

### On-disk format (v1) — the authoritative wire contract

```text
magic(4) = b"PTS\x01"   (bytes 0..3 = family; byte 3 = hard format version = 1)
header_len(u32 LE)
header (JSON, header_len bytes)         = the StoreSchema (below)
zero pad → 64-align
lane 0 region · lane 1 region · …       lane-major on disk; each lane 64-aligned;
                                        WITHIN a lane the k-slabs are contiguous
                                        (slab 0 first) → a k-window is ONE
                                        contiguous slice
zero pad → 8-align
seal: b"PTSZ" + nslabs(u64 LE) + data_end(u64 LE)   written by finalize()
```

- **Lane offsets are NOT stored** — writer and reader recompute them identically
  from `(header_len, schema)` by the same `align_up(·, 64)` walk. That is what
  makes the layout **deterministic**: identical schema + identical data (and
  identical `app`) → byte-identical file.
- A **slab lane** of `elems_per_slab` elements occupies `nslabs · elems_per_slab`
  elements; slab `k` is `[k·elems_per_slab, (k+1)·elems_per_slab)` within the
  lane's region. A **flat lane** is a single `len`-element array (k-invariant,
  e.g. `COORD` pillars).
- 64-byte lane alignment (≥ any dtype's alignment) + a page-aligned mmap base ⇒
  every typed view is well-aligned, so reads/writes are **zero-copy**.
- The **seal** is the finalize marker AND the partial-write detector: an
  unfinalized or truncated file has no valid seal and `open` fails loudly with
  `AlgoError::Parse`. Bad magic / a newer hard version are likewise `Parse`.

```rust
pub enum Dtype { F32, F64, U16, U32 }        // f32 default, f64 opt-in (R4); u16/u32 ids
impl Dtype { pub fn size(self) -> usize; pub fn as_str(self) -> &'static str; }

pub enum LaneKind {
    Slab { elems_per_slab: u64 },            // k-chunked; total = nslabs·elems_per_slab
    Flat { len: u64 },                       // k-invariant single array
}
pub struct LaneSpec { pub name: String, pub dtype: Dtype, pub kind: LaneKind }
impl LaneSpec {
    pub fn slab(name: impl Into<String>, dtype: Dtype, elems_per_slab: u64) -> Self;
    pub fn flat(name: impl Into<String>, dtype: Dtype, len: u64) -> Self;
}
pub struct StoreSchema { pub nslabs: u64, pub lanes: Vec<LaneSpec>, pub app: serde_json::Value }
impl StoreSchema {
    pub fn new(nslabs: u64, lanes: Vec<LaneSpec>) -> Self;   // app = null
    pub fn with_app(self, app: serde_json::Value) -> Self;   // opaque caller metadata
}

// Writer — create preallocates + maps the whole file; fill slab-by-slab; finalize seals.
pub struct StoreWriter { /* private */ }
impl StoreWriter {
    pub fn create(path: &Path, schema: StoreSchema) -> Result<Self>;   // overwrites path
    pub fn with_flush_behind(self, on: bool) -> Self;   // opt-in RSS ceiling (default off); chainable
    pub fn flush_behind_enabled(&self) -> bool;
    pub fn schema(&self) -> &StoreSchema;
    // one method per dtype TY ∈ {f32,f64,u32,u16}:
    pub fn write_slab_TY(&mut self, lane: &str, slab: u64, data: &[TY]) -> Result<()>;
    pub fn slab_mut_TY(&mut self, lane: &str, slab: u64) -> Result<&mut [TY]>;   // in-place fill
    pub fn write_flat_TY(&mut self, lane: &str, data: &[TY]) -> Result<()>;
    pub fn flat_mut_TY(&mut self, lane: &str) -> Result<&mut [TY]>;
    pub fn flush_behind_slab(&mut self, lane: &str, slab: u64) -> Result<()>;  // explicit evict (slab_mut path)
    pub fn flush(&mut self) -> Result<()>;    // msync (does NOT seal)
    pub fn finalize(self) -> Result<()>;      // write seal + msync
}

// Reader — open validates header + dims + seal; all reads are zero-copy views.
pub struct Store { /* private */ }
pub fn open(path: &Path) -> Result<Store>;
impl Store {
    pub fn open(path: &Path) -> Result<Store>;
    pub fn nslabs(&self) -> u64;
    pub fn lanes(&self) -> &[LaneSpec];
    pub fn lane(&self, name: &str) -> Option<&LaneSpec>;
    pub fn app(&self) -> &serde_json::Value;
    // one set per dtype TY ∈ {f32,f64,u32,u16}:
    pub fn slab_TY(&self, lane: &str, slab: u64) -> Result<&[TY]>;
    pub fn window_TY(&self, lane: &str, start: u64, end: u64) -> Result<&[TY]>;  // [start,end) contiguous
    pub fn lane_TY(&self, lane: &str) -> Result<&[TY]>;                          // all slabs
    pub fn flat_TY(&self, lane: &str) -> Result<&[TY]>;
    pub fn slab_view_TY(&self, lane: &str, slab: u64) -> Result<ArrayView1<TY>>;
    pub fn window_view_TY(&self, lane, start, end) -> Result<ArrayView2<TY>>;    // [nwin, elems_per_slab]
}
```

**Flush-behind (opt-in RSS ceiling).** A streaming build writes every slab
through the mmap; the written pages stay resident (page cache), so total RSS
grows `O(store)` even though only one slab is live — soft (OS-reclaimable) but it
inflates measured RSS and weakens a hard streaming-RSS ceiling.
`create(...).with_flush_behind(true)` makes each completed `write_slab_TY`
`msync` its byte range then page-evict it (`madvise(MADV_DONTNEED)` on unix); the
in-place `slab_mut_TY` fill path evicts explicitly via `flush_behind_slab`.
**Byte-determinism is unchanged** — flush-behind controls page residency, never
content (a flush-behind store is byte-identical to a plain one and reads back
bit-exact). **Platform behaviour:** on Linux `MADV_DONTNEED` drops the clean
(msync'd) shared pages immediately → resident growth stays slab-bounded; on
macOS/Darwin it is a softer deactivation hint (pages stay resident/reclaimable
until pressure, so no write-time RSS drop); non-unix degrades to the `msync`
alone. Write-throughput cost at 50M f32: ~7 % (msync overhead). Off by default.

**Errors** (the crate taxonomy): a bad schema / dtype mismatch / wrong length /
out-of-range slab / wrong lane kind → `InvalidArgument`; an unknown lane →
`NotFound`; bad magic / newer version / unfinalized / truncated → `Parse`; a
map/open failure → `Io`. **Benches** (50M-element f32 lane, ~200 MB, one
machine): slab-sequential write ≈ 1.5 GiB/s (flush-behind ≈ 1.20 GiB/s vs plain
≈ 1.29 GiB/s, ~7 %); slab-sequential read ≈ 7 GiB/s; random 8-slab windowed read
≈ 7 GiB/s (warm cache; read bound by the scalar sum, i.e. bandwidth, not the
store).

---

## gridding — warm-start (LOCKED; signed off by petekio + petekSim 2026-06-29)

> Requested firm by both consumers (petekio L1, petekSim L2) and **signed off by
> both** on 2026-06-29 — now part of the locked surface. **Additive and
> non-breaking** — `grid()` is unchanged. See
> `dev-docs/designs/warm-start-gridding.md`.

```rust
// L1 — seeded minimum-curvature primitive (parity with petekio's
// `grid_min_curvature(.., seed)`). Relax the SOR from `seed` (lattice-shaped)
// instead of the cold IDW seed; `None`/wrong-shape → current cold behaviour.
// Re-solves the WHOLE field from the seed (no region restriction) — this is
// what guarantees warm == cold to tolerance + determinism.
pub fn grid_min_curvature_seeded(
    coords: &[[f64; 3]], lattice: &Lattice, seed: Option<&ndarray::Array2<f64>>,
) -> Result<ndarray::Array2<f64>>;

// L2 — stateful convergent gridder for interactive/iterative re-gridding
// (petekSim's refinement loop). Holds the lattice, the current solved field,
// and the node-indexed control set; each add warm-starts from the held field
// via L1. NB: re-solves the whole field warm (fast: far fewer iters), NOT a
// region-restricted solve — diverges from the "affected region only" wording
// to preserve the warm == cold continuity guarantee.
pub struct ConvergentGridder { /* private: Lattice + Array2<f64> + controls */ }
impl ConvergentGridder {
    pub fn new(coords: &[[f64; 3]], lattice: &Lattice) -> Result<ConvergentGridder>;
    pub fn add_control(&mut self, ip: usize, jp: usize, z: f64) -> &ndarray::Array2<f64>;
    pub fn add_controls(&mut self, controls: &[(usize, usize, f64)]) -> &ndarray::Array2<f64>;
    pub fn field(&self) -> &ndarray::Array2<f64>;
}
```

## gridding — off-node scatter conditioning (added; additive/non-breaking)

> `task_petektools_scatter_conditioning`. **Additive** — `grid()`,
> `grid_min_curvature_seeded` and `ConvergentGridder` are unchanged and keep the
> `NearestNode` snap semantics bit-for-bit. Consumers adopt the off-node honouring
> **explicitly** by calling the new entry with `Conditioning::Bilinear`.

```rust
// How the minimum-curvature solve honours a sample that is NOT on a node.
pub enum Conditioning {
    // Snap each sample to its nearest node, hold it fixed (collisions average).
    // Exact on-node; an off-node sample carries a snap error up to the local
    // gradient × its node-offset. The historical behaviour and the Default.
    NearestNode,
    // Honour an off-node sample through the bilinear interpolation of its 4
    // surrounding nodes (Σ wₖ·zₖ = z_data), folded into the SOR as a bilinear
    // least-squares term (combined biharmonic + data-fit normal equations, SPD →
    // convergent). The interpolated surface passes through the datum. A sample on
    // a node is still a hard anchor, bit-identical to NearestNode.
    Bilinear,
}

// Minimum-curvature gridding with an explicit off-node conditioning policy — the
// additive superset of `grid_min_curvature_seeded`. `NearestNode` is bit-for-bit
// identical to it; `Bilinear` removes the sub-node snap error (audit fixture:
// on-data rms 0.57 m → 0.09 m). Same `seed` warm-start contract; deterministic.
// A node-index-space consumer passes each off-node control as its fractional node
// position `[x/xinc, y/yinc, z]` with `Conditioning::Bilinear`.
pub fn grid_min_curvature_conditioned(
    coords: &[[f64; 3]], lattice: &Lattice, seed: Option<&ndarray::Array2<f64>>,
    conditioning: Conditioning,
) -> Result<ndarray::Array2<f64>>;
```

## gridding — minimum-curvature direct solve + factor-once handle (added; additive/non-breaking)

> The minimum-curvature kernel now assembles the fused biharmonic + data-fit
> system as a sparse banded operator and solves it **directly** (in-crate band
> LU, factor-once), replacing the cap-bound SOR. The one-shot entries above are
> unchanged in signature and honour the same `Conditioning`/`seed` contract; on
> fields the SOR left under-converged the results shift within tolerance to the
> exact fixed point (CHANGELOG). `MinCurvatureOperator` exposes the factorization
> for reuse across horizons that share a sample `(x, y)` footprint — the
> petekStatic MC-regeneration path (factor once per surface, solve per depth
> draw).

```rust
// Factored conditioning operator: assemble + factor once for a fixed
// (lattice, sample (x,y) geometry, conditioning); solve each horizon (its
// z-values, aligned with sample_xy, at ~6 ms for a ~14k-node system) by
// back-substitution. An anchorless bilinear cloud (real seismic — no on-node
// sample) is stabilized with a minimal Tikhonov ridge and factors normally.
// `factor` errors InvalidGeometry (<2x2 lattice) / InvalidArgument (GENUINELY
// under-constrained: fewer than 4 independent controls); `solve` errors
// InvalidArgument on a z-length mismatch.
pub struct MinCurvatureOperator { /* private: factored band LU + geometry */ }
impl MinCurvatureOperator {
    pub fn factor(
        lattice: &Lattice, sample_xy: &[[f64; 2]], conditioning: Conditioning,
    ) -> Result<MinCurvatureOperator>;
    pub fn solve(&self, z: &[f64]) -> Result<ndarray::Array2<f64>>;
    pub fn lattice(&self) -> &Lattice;
    pub fn sample_count(&self) -> usize;
}
```

## gridding — the `Gridder` trait + ordinary kriging (added; additive/non-breaking)

Pluggable backends behind one interface. `GridMethod` implements it (so the enum
and the trait agree); `OrdinaryKriging` is the first trait-only backend. The
warm-start entry points stay off the trait by design (seeded / stateful — not a
pure `(coords, lattice) → field`).

```rust
pub trait Gridder {
    fn grid(&self, coords: &[[f64; 3]], lattice: &Lattice) -> Result<ndarray::Array2<f64>>;
}
impl Gridder for GridMethod { /* dispatches to grid(coords, lattice, method) */ }

pub enum VariogramModel { Nugget, Spherical, Exponential, Gaussian }
pub struct Variogram { pub model: VariogramModel, pub nugget: f64, pub sill: f64, pub range: f64 }
impl Variogram {
    pub fn new(model: VariogramModel, nugget: f64, sill: f64, range: f64) -> Result<Variogram>;
    pub fn total_sill(&self) -> f64;
    pub fn gamma(&self, h: f64) -> f64;   // semivariance γ(h); γ(0)=0
}

/// Global-neighbourhood ordinary kriging. Exact (no nugget); coincident data averaged.
pub struct OrdinaryKriging { /* private: Variogram */ }
impl OrdinaryKriging {
    pub fn new(variogram: Variogram) -> OrdinaryKriging;
    pub fn variogram(&self) -> &Variogram;
    pub fn krige(&self, coords: &[[f64; 3]], lattice: &Lattice)
        -> Result<(ndarray::Array2<f64>, ndarray::Array2<f64>)>; // (estimate, variance)
}
impl Gridder for OrdinaryKriging { /* returns the estimate field */ }
```

## geostat — inference · scale · stochastic simulation (added; namespaced, not root-re-exported)

The geostatistics workflow beyond a single global krige: infer a continuity model
from data, krige at scale with a moving neighbourhood, and draw conditional
realizations (SGS), optionally steered by a collocated secondary. Reuses the
crate `Variogram`, the OK dense LU solver, and `rstar`. Type-agnostic
(`[[f64; 3]]` packed coords + `Lattice`). Derived from primary literature (GSLIB;
Goovaerts 1997; Xu et al. 1992 / Almeida & Journel 1994; Chilès & Delfiner) — no
third-party code. AlgorithmSpec back-fill pending (coordinator authors specs from
these shipped contracts).

```rust
// Experimental (empirical) variogram — omnidirectional, binned by lag.
pub struct ExperimentalVariogram { pub lags: Vec<f64>, pub semivariances: Vec<f64>, pub counts: Vec<usize> }
impl ExperimentalVariogram { pub fn len(&self) -> usize; pub fn is_empty(&self) -> bool; }
pub fn experimental_variogram(coords: &[[f64; 3]], lag: f64, n_lags: usize)
    -> Result<ExperimentalVariogram>;   // value = z; empty bins dropped; mean lag per class

// Fit a model to an experimental variogram — pair-count weighted least squares.
impl Variogram { pub fn fit(model: VariogramModel, exp: &ExperimentalVariogram) -> Result<Variogram>; }

// Moving-neighbourhood ordinary kriging (max-n within radius; small dense solves).
// Reproduces global OK when the neighbourhood covers all data; scales to ~40k pts.
pub struct LocalKriging { /* private: Variogram + max_neighbours + radius */ }
impl LocalKriging {
    pub fn new(variogram: Variogram, max_neighbours: usize, radius: f64) -> Result<LocalKriging>;
    pub fn variogram(&self) -> &Variogram;
    pub fn krige(&self, coords: &[[f64; 3]], lattice: &Lattice)
        -> Result<(ndarray::Array2<f64>, ndarray::Array2<f64>)>;  // (estimate, variance); NaN outside radius
}

// Normal-score transform (data ⇄ standard-normal scores; Hazen plotting position).
pub struct NormalScore { /* private: (value, score) knot tables */ }
impl NormalScore {
    pub fn fit(data: &[f64]) -> Result<NormalScore>;
    pub fn forward(&self, value: f64) -> f64;   // data -> score
    pub fn back(&self, score: f64) -> f64;       // score -> data (inverse; tails clamp)
    pub fn score_bounds(&self) -> (f64, f64);
}

// Sequential Gaussian simulation — conditioned exactly on data; seeded/reproducible;
// optional collocated cokriging (Markov-1) secondary. Build-fast (one sim per build).
pub struct SgsParams {
    pub variogram: Variogram,          // modelled on normal-score data (sill ~1)
    pub max_neighbours: usize, pub radius: f64, pub seed: u64,
    pub collocated: Option<(ndarray::Array2<f64>, f64)>,  // (secondary field, correlation ρ)
}
impl SgsParams { pub fn new(variogram: Variogram, max_neighbours: usize, radius: f64, seed: u64) -> Result<SgsParams>; }
pub fn sgs(coords: &[[f64; 3]], lattice: &Lattice, params: &SgsParams) -> Result<ndarray::Array2<f64>>;
// `sgs` with an explicit seed overriding `params.seed` — for a parallel-layer
// caller that shares ONE `&SgsParams` (carrying the layer-invariant collocated
// secondary) across many layers, passing each layer's independent seed here
// instead of cloning the secondary per layer. Bit-for-bit == sgs(.., {params with
// seed}); sgs(c,l,p) == sgs_seeded(c,l,p, p.seed).
pub fn sgs_seeded(coords: &[[f64; 3]], lattice: &Lattice, params: &SgsParams, seed: u64) -> Result<ndarray::Array2<f64>>;

// Reusable multi-layer SGS context (fast-resim): construct once over the
// layer-invariant lattice/variogram/search, simulate many layers through it
// reusing all working scratch (informed arrays, path, per-node kriging solver).
// BIT-FOR-BIT identical to the matching one-shot `sgs` call (same seed+inputs) —
// an allocation restructure, not an algorithm change. Determinism is pinned.
pub struct SgsSession { /* private: frame + variogram + search params + retained scratch */ }
impl SgsSession {
    pub fn new(lattice: Lattice, variogram: Variogram, max_neighbours: usize, radius: f64)
        -> Result<SgsSession>;                          // errors: max_neighbours>=1, radius>0 finite
    pub fn lattice(&self) -> &Lattice;
    pub fn variogram(&self) -> &Variogram;
    pub fn simulate(&mut self, coords: &[[f64; 3]], seed: u64)
        -> Result<ndarray::Array2<f64>>;                // == sgs(coords, lattice, {vg,max_n,radius,seed})
    pub fn simulate_collocated(&mut self, coords: &[[f64; 3]], seed: u64,
        secondary: &ndarray::Array2<f64>, rho: f64)
        -> Result<ndarray::Array2<f64>>;                // == sgs with collocated = Some((secondary, rho))
}

// Unconditional Gaussian field — no data; a parametric N(mean, variance) target
// with the variogram's continuity (shape/range only; sill irrelevant). variance=0
// ⇒ constant; pure-nugget ⇒ white. Seeded/reproducible. The synth-field primitive.
pub fn sgs_unconditional(lattice: &Lattice, mean: f64, variance: f64, variogram: &Variogram,
    max_neighbours: usize, radius: f64, seed: u64) -> Result<ndarray::Array2<f64>>;
```

## stats / sampling — curated front-door (added; namespaced, not root-re-exported)

Thin, validated wrappers over mature crates: `stats` over `statrs` (plus the
weighted family, which `statrs` lacks); `sampling` over `rand` + `rand_distr`.
Both return a `Result` on bad input instead of panicking. Namespaced (like
`units` / `container`).

```rust
// stats — descriptive statistics.
pub fn mean(data: &[f64]) -> Result<f64>;
pub fn variance(data: &[f64]) -> Result<f64>;        // sample (n−1); single value -> 0
pub fn std_dev(data: &[f64]) -> Result<f64>;
pub fn percentile(data: &[f64], p: f64) -> Result<f64>;   // p in [0,100], type-7 (Excel PERCENTILE parity)
pub fn median(data: &[f64]) -> Result<f64>;
pub fn weighted_mean(values: &[f64], weights: &[f64]) -> Result<f64>;
pub fn weighted_variance(values: &[f64], weights: &[f64]) -> Result<f64>;   // reliability weights
pub fn weighted_std_dev(values: &[f64], weights: &[f64]) -> Result<f64>;
pub fn weighted_percentile(values: &[f64], weights: &[f64], p: f64) -> Result<f64>;

// sampling — reproducible draws from the common appraisal distributions.
pub fn seeded_rng(seed: u64) -> rand::rngs::StdRng;
pub enum Sampler {
    Uniform{lo,hi}, Normal{mean,std_dev}, LogNormal{mean,std_dev}, Triangular{min,mode,max},
    TruncatedNormal{mean,std_dev,lo,hi},   // reshaped to [lo,hi]; drawn by exact clipped-CDF
}
impl Sampler {
    pub fn new_uniform(lo: f64, hi: f64) -> Result<Sampler>;
    pub fn new_normal(mean: f64, std_dev: f64) -> Result<Sampler>;
    pub fn new_lognormal(mean: f64, std_dev: f64) -> Result<Sampler>;   // log-space params
    pub fn new_triangular(min: f64, mode: f64, max: f64) -> Result<Sampler>;
    pub fn new_truncated_normal(mean: f64, std_dev: f64, lo: f64, hi: f64) -> Result<Sampler>;
    pub fn clamped(self, lo: f64, hi: f64) -> Result<Clamped>;   // hard-limit ANY sampler
    pub fn sample<R: rand::Rng>(&self, rng: &mut R) -> f64;
    pub fn sample_n<R: rand::Rng>(&self, n: usize, rng: &mut R) -> Vec<f64>;
}
// Clamping snaps out-of-range draws to the bound (mass piles at lo/hi) — NOT a
// truncation of the density (for that, new_truncated_normal reshapes it).
pub struct Clamped { /* private: Sampler + lo + hi */ }
impl Clamped {
    pub fn new(inner: Sampler, lo: f64, hi: f64) -> Result<Clamped>;
    pub fn sample<R: rand::Rng>(&self, rng: &mut R) -> f64;
    pub fn sample_n<R: rand::Rng>(&self, n: usize, rng: &mut R) -> Vec<f64>;
}

// sampling — realization-set helpers (over the crate's own type-7 percentiles).
// The oil-industry P90=low / P10=high exceedance convention: P90 ≤ P50 ≤ P10.
pub struct ReservoirSummary { pub p90: f64, pub p50: f64, pub p10: f64, pub mean: f64 }
pub fn reservoir_summary(data: &[f64]) -> Result<ReservoirSummary>;

// Sum per-segment realization vectors under an explicit dependence assumption.
// Index-wise; result length = shortest segment (empty in -> empty out).
#[non_exhaustive] pub enum Correlation { Independent, Comonotonic }  // Rank(rho) planned
pub fn aggregate(segments: &[&[f64]], corr: Correlation) -> Vec<f64>;
```

## synth — believable synthetic data (added; Rust namespaced, Python re-exported)

Seeded, deterministic generators for a whole synthetic subsurface asset — a
stand-in for a real (confidential) dataset. Built on two documented primitives (an
AR(1)/exponential depth-correlated Gaussian series + a moment-matched logit-normal
`[0,1]` transform) and the crate's `sgs_unconditional` for 2-D fields. Includes
**coupled petrophysics** where net-to-gross is *derived* from porosity by a cutoff
(the calibrated `synth_petro_curves`), not generated independently. Every
generator is **bit-reproducible per seed**; all fraction outputs stay in `[0,1]`.
Type-agnostic (`Lattice` + plain slices/`ndarray`). Derived from the cited
literature (AR(1): Box–Jenkins; logit-normal: Atchison & Shen 1980; truncated
Gaussian facies: Matheron/Armstrong; marching squares: Lorensen & Cline) — no
third-party code.

```rust
// 1-D zone-conformant log: hits each zone's {mean,std} in [0,1], depth-autocorrelated.
pub struct ZoneSpec { pub thickness_m: f64, pub mean: f64, pub std: f64, pub corr_length_m: f64 }
impl ZoneSpec { pub fn new(thickness_m: f64, mean: f64, std: f64, corr_length_m: f64) -> Result<ZoneSpec>; }
pub fn zone_sample_counts(zones: &[ZoneSpec], depth_step: f64) -> Vec<usize>;
pub fn synth_log_series(zones: &[ZoneSpec], depth_step: f64, transition_beds: usize, seed: u64) -> Result<Vec<f64>>;

// Binary facies (truncated Gaussian; sand proportion == ntg) + facies-composed porosity.
pub enum Facies { Sand, Shale }                         // .is_sand(), .code() -> u8 (1/0)
pub struct MomentSpec { pub mean: f64, pub std: f64 }   // MomentSpec::new validates (as ZoneSpec)
pub fn synth_facies_series(n: usize, depth_step: f64, ntg_target: f64, bed_scale_m: f64, seed: u64) -> Result<Vec<Facies>>;
pub fn synth_por_with_facies(facies: &[Facies], depth_step: f64, sand: MomentSpec, shale: MomentSpec, corr_length_m: f64, seed: u64) -> Result<Vec<f64>>;

// COUPLED petrophysics: net-to-gross DERIVED from porosity by a cutoff (net_flag = φ ≥ cutoff),
// calibrated (facies mixture; 2-D Newton) so the realized series hits the zone NTG and the
// NET-ROCK {mean,std} — accounting for the across-cutoff leak (net ≠ sand). The coherent
// replacement for an independent porosity/NTG pair. Infeasible specs error with the achievable
// bound (NTG floor = P(nonnet≥cutoff); net-std floor = the leak's between-facies spread).
pub const DEFAULT_NET_CUTOFF: f64 = 0.10;
pub struct PetroZoneSpec { pub net_cutoff: f64, pub ntg_target: f64, pub net_por: MomentSpec,     // net_por = moments OF NET ROCK
    pub nonnet_por: MomentSpec, pub bed_scale_m: f64, pub correlation_len_m: f64 }                // nonnet_por = shale porosity dist
impl PetroZoneSpec { pub fn new(net_cutoff, ntg_target, net_por, nonnet_por, bed_scale_m, correlation_len_m) -> Result<Self>;
                     pub fn with_default_cutoff(ntg_target, net_por, nonnet_por, bed_scale_m, correlation_len_m) -> Result<Self>; }
pub struct PetroCurves { pub phie: Vec<f64>, pub net_flag: Vec<bool> }                            // net_flag[i] == phie[i] >= net_cutoff
pub fn synth_petro_curves(zone: &PetroZoneSpec, depth_step: f64, n_samples: usize, seed: u64) -> Result<PetroCurves>;
pub fn ntg_curve(net_flag: &[bool], depth_step: f64, window_m: f64) -> Result<Vec<f64>>;          // NTG display curve = windowed mean of net_flag

// 2-D recipes (via sgs_unconditional).
pub struct NoiseSpec { pub variance: f64, pub variogram: Variogram }   // NoiseSpec::new validates
pub fn synth_dome_surface(lattice: &Lattice, relief: f64, aspect: f64, tilt: f64, noise: &NoiseSpec, seed: u64) -> Result<ndarray::Array2<f64>>;  // crest = max
pub fn synth_isochore(lattice: &Lattice, mean_thickness: f64, variability: f64, variogram: &Variogram, seed: u64) -> Result<ndarray::Array2<f64>>;  // clamped >= 0
pub fn synth_trend_map(lattice: &Lattice, variogram: &Variogram, seed: u64,
    correlate_with: Option<(&ndarray::Array2<f64>, f64)>) -> Result<ndarray::Array2<f64>>;   // [0,1]; optional corr at rho

// Wells: placement, surface picks, trajectory (vertical + directional). WORLD FRAME
// is the default posture — extent/polygon/lattice/wellhead are all world coordinates.
pub fn place_wells(extent: &BBox, n: usize, seed: u64) -> Result<Vec<[f64; 2]>>;
pub fn place_wells_in_polygon(polygon: &[[f64; 2]], n: usize, seed: u64) -> Result<Vec<[f64; 2]>>;
pub fn tops_from_surface(surface: &ndarray::Array2<f64>, lattice: &Lattice, well_xy: &[[f64; 2]], residual: &Sampler, seed: u64) -> Vec<f64>;
pub struct Station { pub md: f64, pub x: f64, pub y: f64, pub z: f64, pub tvd: f64, pub incl: f64, pub azim: f64 }  // z = kb − tvd
pub struct Trajectory { pub stations: Vec<Station> }
pub fn synth_trajectory(wellhead_xy: [f64; 2], kb_elevation: f64, td: f64, md_step: f64, seed: u64) -> Result<Trajectory>;  // vertical (unchanged default)

// Directional profiles (believable build/hold/drop; min-curvature station placement — SYNTHESIS,
// not survey interpretation which petekIO owns). Build rates are deg/30m MD (believable ~1–4, ceiling 6).
pub const MAX_BUILD_RATE_DEG_PER_30M: f64 = 6.0;
pub struct BuildHold { pub kickoff_md: f64, pub build_rate_deg_per_30m: f64, pub hold_incl_deg: f64, pub azimuth_deg: f64 }
impl BuildHold { pub fn new(kickoff_md, build_rate_deg_per_30m, hold_incl_deg, azimuth_deg) -> Result<Self>; }   // validates; azimuth → [0,360)
pub struct BuildHoldDrop { pub build_hold: BuildHold, pub drop_start_md: f64, pub drop_rate_deg_per_30m: f64, pub final_incl_deg: f64 }
impl BuildHoldDrop { pub fn new(build_hold, drop_start_md, drop_rate_deg_per_30m, final_incl_deg) -> Result<Self>; }  // drop_start ≥ build end; final ∈ [0,hold]
pub enum WellProfile { Vertical, BuildHold(BuildHold), BuildHoldDrop(BuildHoldDrop) }
pub fn synth_trajectory_profile(wellhead_xy: [f64; 2], kb_elevation: f64, td: f64, md_step: f64, profile: &WellProfile, seed: u64) -> Result<Trajectory>;  // td = MD; Vertical ≡ synth_trajectory
pub fn max_dogleg_severity(traj: &Trajectory) -> f64;  // deg/30m; believability yardstick (0 vertical, ≈ build rate through a build)

// World-frame convenience: the georeference IS the Lattice (no new coord model); Georef places a
// locally-built structure at a fictional world origin — the build-local → place-in-world idiom.
pub const FICTIONAL_ORIGIN: [f64; 2] = [431_000.0, 6_521_000.0];
pub struct Georef { pub east0: f64, pub north0: f64 }
impl Georef { pub fn new(east0, north0) -> Result<Self>; pub fn fictional() -> Self; pub fn origin() -> [f64; 2];
              pub fn lattice(xinc, yinc, ncol, nrow) -> Lattice; pub fn place_point([f64;2]) -> [f64;2];
              pub fn place_points(&[[f64;2]]) -> Vec<[f64;2]>; pub fn place_extent(&BBox) -> BBox; }

// Outlines.
pub fn closure_outline(surface: &ndarray::Array2<f64>, lattice: &Lattice, spill_depth: f64) -> Result<Vec<[f64; 2]>>;  // marching squares; largest closed ring
pub fn study_area_outline(extent: &BBox, corner_radius: f64, arc_steps: usize) -> Vec<[f64; 2]>;
```

## Python (PyO3) surface (added; the `petektools` wheel)

A thin PyO3 wheel (built by maturin) over the front-door above. Mixed layout
(mirrors petekio): `pyproject.toml` at the repo root, the cdylib in `py/`
(`petektools._petektools`, `publish = false`), the importable package in
`python/petektools/`. abi3-py39 → one wheel for CPython 3.9+; pyo3 0.29. The
wheel is **not** part of the published Rust crate (workspace member + `exclude`).

**Conventions.** Every vector argument accepts a `list` **or** a numpy array
(extracted via the iteration protocol — no numpy dependency); results are plain
`float`/`list` (nested lists `field[col][row]` for grids, `NaN` = unestimated).
Percentiles are type-7 (`p` in `[0,100]`; `percentile([1,2,3,4,5],25)==2.0`).

**GIL release.** The seconds-capable kernels (`sgs`, `local_kriging_grid`,
`resample`, `experimental_variogram`, `Variogram.fit`, and the compute-heavy
`synth` generators) release the GIL (`py.detach`) for the kernel call, so a long
run does not block other Python threads.

**Flat grid crossing (additive).** Each grid producer/consumer has a `*_flat`
variant that crosses a field as one little-endian `f64` `bytes` buffer +
`(ncol, nrow)` shape (one `memcpy` vs a boxed list-of-lists of ~1M floats — ~3×
faster at a 1M-node grid): `sgs_flat`, `local_kriging_grid_flat`,
`resample_flat`, `synth_dome_surface_flat`, `synth_isochore_flat`,
`synth_trend_map_flat`. Wrap with `np.frombuffer(buf, '<f8').reshape(ncol, nrow)`;
feed one back with `np.ascontiguousarray(a, '<f8').tobytes()`. The nested API is
unchanged. Example:
`buf, (ncol, nrow) = pt.sgs_flat(coords, lat, vg, max_neighbours, radius, seed)`.
The **P90=low** exceedance convention (`p90 ≤ p50 ≤ p10`) is documented on
`reservoir_summary`. Reproducibility: `Rng(seed)` (the seeded `StdRng`) threaded
through `sample`/`sample_n`, or `sample_n_seeded(n, seed)` — **same seed + params
→ the identical stream as the Rust engine** (pinned by the cross-language parity
vector in `tests/parity.rs`, re-asserted in `python/tests/test_petektools.py`).

```python
import petektools as pt

# sampling — every Sampler variant + the .clamped() hard-limiter combinator.
pt.Sampler.uniform(lo, hi); pt.Sampler.normal(mean, std_dev)
pt.Sampler.lognormal(mean, std_dev)        # log-space params
pt.Sampler.triangular(min, mode, max)
pt.Sampler.truncated_normal(mean, std_dev, lo, hi)   # density reshaped onto [lo,hi]
s.clamped(lo, hi)                          # snaps out-of-range draws to the bound
s.sample(rng) -> float;  s.sample_n(n, rng) -> list[float]   # rng = pt.Rng(seed)
s.sample_n_seeded(n, seed) -> list[float]  # == sample_n(n, pt.Rng(seed))

# stats — mean/variance/std/percentile(p in [0,100])/median + the weighted family.
pt.mean(data); pt.variance(data); pt.std(data); pt.percentile(data, p); pt.median(data)
pt.weighted_mean(values, weights); pt.weighted_variance(...); pt.weighted_std(...)
pt.weighted_percentile(values, weights, p)

# realization-set helpers.
r = pt.reservoir_summary(data)             # r.p90 <= r.p50 <= r.p10, r.mean; r.to_dict()
pt.aggregate(segments, correlation="independent" | "comonotonic") -> list[float]

# formula — domain-free assignment expressions over named vectors.
pt.formula_info(["RQI = $lambda * sqrt(PermXY_BC / PorE_BC)"])
# -> {"outputs": [...], "order": [...], "params": [...], "properties": [...]}
pt.evaluate_formula(assignments, properties, params=None) -> dict[str, list[float]]

# geostat front-door — coords are [x,y,z] rows (list-of-3-lists or (n,3) ndarray).
exp = pt.experimental_variogram(coords, lag, n_lags)     # .lags/.semivariances/.counts
vg  = pt.Variogram.fit("spherical", exp)                 # or Variogram(model, nugget, sill, range)
lat = pt.Lattice(xori, yori, xinc, yinc, ncol, nrow)
est, var = pt.local_kriging_grid(coords, lat, vg, max_neighbours, radius)  # ncol×nrow fields
field    = pt.sgs(coords, lat, vg, max_neighbours, radius, seed)           # seeded, reproducible

# resample — grid → grid. src_grid is nested lists field[col][row] (ncol×nrow),
# on a source Lattice; onto a target Lattice. Axis-aligned; NaN outside extent.
out = pt.resample(src_grid, src_lattice, target_lattice, method="bilinear")  # or "nearest"

# synth — believable synthetic data (seeded, bit-reproducible; fractions in [0,1]).
z  = [pt.ZoneSpec(thickness_m, mean, std, corr_length_m), ...]
pt.zone_sample_counts(z, depth_step)                       # -> [int] per-zone sample layout
phie = pt.synth_log_series(z, depth_step, transition_beds, seed)          # -> [float]
fac  = pt.synth_facies_series(n, depth_step, ntg_target, bed_scale_m, seed)  # -> [int] 1=sand/0=shale
por  = pt.synth_por_with_facies(fac, depth_step, sand_mean, sand_std,
                                shale_mean, shale_std, corr_length_m, seed)   # -> [float]
# coupled petrophysics: NTG derived from PHIE by a cutoff; net_por = NET-ROCK moments (φ|net).
pz   = pt.PetroZoneSpec(ntg_target, net_por_mean, net_por_std, nonnet_por_mean, nonnet_por_std,
                        bed_scale_m, correlation_len_m, net_cutoff=0.10)      # solved facies mixture
cur  = pt.synth_petro_curves(pz, depth_step, n_samples, seed)                 # -> {"phie":[float], "net_flag":[1/0]}
ntg  = pt.ntg_curve(cur["net_flag"], depth_step, window_m)                    # NTG display curve, [0,1]
dome = pt.synth_dome_surface(lat, relief, aspect, tilt, noise_variance, noise_vg, seed)  # ncol×nrow, crest=max
iso  = pt.synth_isochore(lat, mean_thickness, variability, vg, seed)          # ncol×nrow, >= 0
trend= pt.synth_trend_map(lat, vg, seed, correlate_with=(field, rho))         # ncol×nrow in [0,1]; corr optional
wells= pt.place_wells(xmin, ymin, xmax, ymax, n, seed)                        # -> [[x,y]]
wells= pt.place_wells_in_polygon(polygon, n, seed)                           # polygon = [[x,y],...]
tops = pt.tops_from_surface(surface, lat, well_xy, residual_sampler, seed)   # -> [float]; NaN outside extent
traj = pt.synth_trajectory(wellhead_xy, kb_elevation, td, md_step, seed)     # vertical; columnar dict md/x/y/z/tvd/incl/azim
# directional (build_hold | build_hold_drop): td = MD; min-curvature stations; deterministic.
traj = pt.synth_trajectory_profile(wellhead_xy, kb_elevation, td, md_step, seed, "build_hold",
           kickoff_md=800.0, build_rate_deg_per_30m=3.0, hold_incl_deg=45.0, azimuth_deg=90.0)  # + drop_start_md/drop_rate_deg_per_30m/final_incl_deg for build_hold_drop
dls  = pt.max_dogleg_severity(traj["md"], traj["incl"], traj["azim"])        # deg/30m believability yardstick
g    = pt.Georef()                                                           # fictional world origin (or Georef(east0, north0))
lat  = g.lattice(xinc, yinc, ncol, nrow)                                     # world-placed Lattice; g.place_point([x,y]) etc.
ring = pt.closure_outline(surface, lat, spill_depth)                         # -> [[x,y]] (largest closed ring)
ring = pt.study_area_outline(xmin, ymin, xmax, ymax, corner_radius, arc_steps)

# asset — wheel-only synthetic Petrel-export writer/composer. Format dissolves
# at load; these are test-data writers, not petekTools domain I/O.
pt.write_irap_grid(path, field, lat, negate=True)
pt.write_irap_points(path, field, lat)
pt.write_earthvision_grid(path, field, lat)
pt.write_cps3_grid(path, field, lat, negate=True)
pt.write_cps3_lines(path, rings)
pt.write_wellpath(path, trajectory, kb)
pt.write_las2(path, well, md, por, ntg, sw)
pt.write_petrel_tops(path, horizon_picks, contact_rows=[])
m = pt.synth_asset(root, seed=20260704, n_wells=8, ncol=41)  # returns planted-truth manifest

# units — SI/metric reporting (family standard); Sm³ is a scale label, not PVT.
pt.m3_to_mcm(v); pt.mcm_to_m3(v)          # m³  <-> mcm  (1e6)
pt.m3_to_msm3(v); pt.msm3_to_m3(v)        # Sm³ <-> MSm³ (1e6, oil)
pt.m3_to_bcm(v);  pt.bcm_to_m3(v)         # Sm³ <-> bcm  (1e9, gas)
pt.scf_to_sm3(v); pt.sm3_to_scf(v)        # scf <-> Sm³  (geometric ft³/m³)
pt.stb_to_sm3(v); pt.sm3_to_stb(v)        # stb <-> Sm³
pt.km2_to_m2(v);  pt.m2_to_km2(v)         # km² <-> m²   (1e6, areal)
pt.format_volume(12.4e6)                  # "12.4 mcm"
```

## Python — the viewer unit (`petektools.viewer`; wheel-only, not in the Rust crate)

The horizontal **bundle renderer** — domain-agnostic rendering of typed JSON
payloads (see `python/petektools/viewer/SCHEMA.md` for the render schema; `VIEWER.md`
for the tabs/modes). Pure-Python + JS assets shipped as wheel package data; the
crates.io Rust crate excludes it (`/python` in `Cargo.toml` `exclude`) and stays
lean. No domain logic, no computation, no domain I/O — a consumer maps its bundle
onto the schema and hands it here (home ruling `decision_viewer_home_petektools`).

```python
from petektools import viewer

# Generic 2-D adapter. Stable kind metadata separates point sets, geometry-only
# shells, and value surfaces. Omitted fill auto-enumerates primary + named lanes
# only for surface roles offering callable attr_names() and value_layer().
# Explicit fill remains exact: False=off, True=primary, str=one named lane.
# Automatic lanes retain/pack their common full+LOD mesh once. Block payloads
# initially decode shared geometry + the active values only; another lane's
# values decode on first selection and remain cached (A -> B -> A is stable).
# During wheel/drag the renderer affine-composites point/fill plus split
# grid/contour/outline/contact bitmaps (one paint/rAF); data-sized paths rebuild
# at most once after settle. Plain JSON and saved single-file views are unchanged.
viewer.view2d(items, *, title="2D view", color=True, fill=None, contours=None,
              save=None, port=0, block=False, open_browser=True,
              max_grid_lines=800, max_line_points=1000, point_limit=200_000,
              max_mesh_edges=150_000, lod=True, encoding="blocks",
              block_threshold_bytes=65_536) -> str | dict
viewer.view2d_payload(items, *, title="2D view", color=True, fill=None,
                      contours=None, max_grid_lines=800, max_line_points=1000,
                      point_limit=200_000, max_mesh_edges=150_000, lod=True,
                      encoding="blocks", block_threshold_bytes=65_536) -> dict

# Live: background local server; returns the URL. `section_provider` is the
# pluggable /section callback (line=, well=, property=) by which a DOMAIN package
# answers fence/well requests — the unit computes nothing itself.
viewer.serve(payload, port=0, block=False, open_browser=True, section_provider=None) -> str

# Static: ONE self-contained HTML file (all JS + data inlined; opens via file://,
# zero external fetches). `precomputed_sections` bakes extra sections into it.
viewer.save_view(payload, path, precomputed_sections=None) -> None

# Lower-level: build (don't start) the server -> (httpd, url).
viewer.build_server(payload, port=0, section_provider=None)

viewer.ASSETS                              # Path to the packaged JS/HTML assets

# payload is a dict OR a pre-serialized JSON string (the generic render schema).
# python -m petektools.viewer.demo         # standalone raster+section+mesh demo
```
