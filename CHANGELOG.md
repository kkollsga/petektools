# Changelog

All notable changes to petekTools are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/); this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — `petektools.synth_asset` owns the synthetic export fixture
- Rehomed the synthetic Petrel-export composer into the petekTools Python wheel
  as `petektools.synth_asset`, with public single-file writers for IRAP, CPS-3,
  EarthVision, LAS 2.0, wellpath, and Petrel well-tops fixtures. The Rust crate
  remains format-I/O-free; this is a wheel-only test-data unit.
- Added a Python API-lock test for `petektools.__all__` and smoke tests for the
  writer markers plus a small deterministic synthetic tree.

## [0.2.1] - 2026-07-05

### Fixed — broken import on Python 3.10/3.11 (0.2.0 wheel)
- **`petektools.viewer` failed to import on Python 3.10 and 3.11** — a
  `SyntaxError` at load, so the 0.2.0 wheel was unusable on those interpreters
  despite the declared `requires-python >= 3.10`. Cause: `viewer/_save.py` used
  a backslash inside an f-string expression (legal only from Python 3.12). The
  replacement is hoisted into a plain local; the shipped `python/` tree is
  audited clean of pre-3.12-only f-string constructs.
- **CI matrix corrected to the 3.10 floor** (dropped 3.9 — the wheel is
  abi3-py310) and the **Release workflow is now gated**: fmt / clippy / tests /
  the Python smoke suite must pass on the runner before any build or publish
  job runs. A red CI blocks the release.

## [0.2.0] - 2026-07-05

### Added — `sgs_seeded` (shared-params, explicit-seed SGS for parallel-layer callers)
- **`geostat::sgs_seeded(coords, lattice, &params, seed)`** runs [`sgs`] with an
  explicit RNG `seed` that overrides `params.seed`. `sgs(c, l, p)` is now exactly
  `sgs_seeded(c, l, p, p.seed)` — a pure refactor, bit-for-bit unchanged.
- **Why.** A per-layer SGS sweep (petekStatic's zone-property population) simulates
  many independent layers that share everything *except* the seed — the collocated
  secondary is layer-invariant. `sgs_seeded` lets the caller borrow ONE `&SgsParams`
  across all layers in parallel and pass each layer's seed here, instead of cloning
  the secondary field into a fresh `SgsParams` per layer. Enables a bit-identical
  parallel-layer population downstream with no per-layer allocation of the secondary.

### Fixed — `MinCurvatureOperator` no longer goes singular on anchorless bilinear clouds
- **`factor(.., Conditioning::Bilinear)` now solves an anchorless cloud** (real
  seismic: tens of thousands of samples, **none** landing on a frame node). It
  previously reported the system singular and forced the caller to fall back to
  the iterative kernel (which, in petekStatic/petekSim, surfaced as a stack build
  failing with "scatter horizon landed no point on the lattice").
- **Root cause.** The tensioned natural-dip biharmonic annihilates the low-order
  family {1, x, y, xy}; the bilinear data-fit normal equations pin those modes
  only where samples reach. When the cloud clears the frame margin (data in the
  central region, boundary ring data-void), exactly **one** boundary-supported
  mode is left essentially unpinned — the assembled operator is near-singular
  (one ~1e-12-relative, sign-indefinite pivot; confirmed genuine, not
  unpivoted-elimination growth: full partial pivoting sees the same tiny pivot),
  so the unpivoted band LU collapses on its final pivot. On-node samples pin the
  null family directly, which is why only real off-node seismic tripped it.
- **Fix.** The exact system is factored first (bit-identical for every
  well-posed / anchored / mixed case — that path is untouched). Only on its
  failure, and only with at least the biharmonic null-family dimension (4) of
  independent controls, a **minimal Tikhonov ridge** (`1e-8` of the largest
  assembled diagonal) pins the residual boundary null mode and the factor
  retries. The ridge is negligible (~1e-8 relative) on every data-reached node,
  so the honoured reservoir interior — where volumes live — is unchanged; it
  biases only the otherwise-unconstrained margin mode toward its minimum-norm
  (smoothest) extension. A **genuinely** under-constrained system (fewer than 4
  controls, e.g. a lone anchor) still reports singular so the caller keeps the
  documented iterative fallback.
- Regression: an anchorless world-georef (doctrine-R1) jittered-cloud fixture
  factors and solves to an all-finite field honouring the off-node data (max
  ~0.3 m, rms ~0.01 m misfit on a 2000 m field); stabilized factor+solve ~30 ms
  at a 41×37 / 1500-sample shape.

### Changed — minimum-curvature now solves DIRECTLY (⚠ behaviour change on converged fields)
- **The minimum-curvature kernel is factored-and-solved directly instead of
  relaxed by SOR.** The fused system (tensioned 13-point biharmonic + bilinear
  data-fit normal equations) is assembled as a sparse **banded** operator and
  solved by an in-crate band **LU** — factor once, back-substitute per
  right-hand side. All the one-shot entries (`grid(.., MinimumCurvature)`,
  `grid_min_curvature_seeded`, `grid_min_curvature_conditioned`,
  `ConvergentGridder`) route through it, falling back to the old SOR only for a
  degenerate (<2×2) lattice or a singular/under-constrained system.
- **⚠ Results change (within tolerance) on any field the old SOR left
  under-converged.** The direct solve lands exactly on the linear system's fixed
  point — the point the SOR was iterating toward but, on conditioning-heavy
  problems, hit its 20 000-sweep cap before reaching. Anchors are still honoured
  bit-exact; on-node/plane cases are unchanged; solved interior/boundary values
  move by up to ~1e-4 on a ~1e2-magnitude field (the SOR's residual tail) — the
  direct path is the **more** accurate of the two. Determinism is preserved (a
  fixed elimination order; no RNG).
- **Performance:** the convicted hotspot (~122×116 lattice, ~39k off-node
  `Bilinear` samples) drops from a cap-bound ~60 s SOR to a **~0.44 s** direct
  one-shot (assemble+factor 0.44 s + solve 7 ms); each subsequent horizon over
  the same sample `(x, y)` footprint solves in **~6 ms** via the reuse handle
  below.

### Added — `MinCurvatureOperator`: factor-once / solve-many minimum curvature
- `MinCurvatureOperator::factor(&Lattice, &[[f64; 2]] sample_xy, Conditioning)`
  assembles + factors the conditioning operator once; `.solve(&[f64] z)` grids
  each horizon (its z-values, aligned with `sample_xy`) by a cheap
  back-substitution. For the Monte-Carlo regeneration of one surface — many
  realizations that share the sample footprint and redraw only the depths — this
  factors once and pays ~6 ms/realization instead of a full solve each time.
  `.lattice()` / `.sample_count()` introspect. Errors `InvalidGeometry`
  (degenerate lattice) / `InvalidArgument` (singular system / z-length mismatch).
  Re-exported at the crate root.

### Changed — organize wave: module structure + scratch reuse (behavior-neutral)
- **`geostat::sgs` split into concern submodules** (`sweep` / `scratch` /
  `collocated` / `session`; `mod.rs` keeps `SgsParams` + the one-shot entries).
  Pure move; public surface unchanged; the bit-parity battery moved verbatim.
- **`synth::wells` split into `placement` / `tops` / `trajectory`** submodules;
  the 12-item public surface re-exported unchanged.
- **Python `synth` bindings split per generator family** (`logs` / `facies` /
  `petro` / `surface` / `wells` / `outline` / `georef`); every `synth::<name>`
  registration path unchanged.
- **`viewer.js` restructured into ordered concat parts** (`assets/viewer/NN-*.js`,
  one feature area per file) assembled at build time by the packaging layer
  (`serve()` writes the assembled file; `save_view()` inlines it) — the zero-CDN
  rule stands (no runtime imports; the assembled bundle is byte-identical to the
  former monolith, sha256-verified). New `viewer/_bundle.py` + an assembly-shape
  test. See VIEWER.md "How the viewer JS is organized".
- **Per-node solver-scratch reuse** in `LocalKriging` (retained `OkScratch`
  mat/rhs/perm/sol per krige pass) and `OrdinaryKriging` (retained solution
  buffer via `LuFactorization::solve_into`) — closes the 2026-07-04 review
  deferral; identical arithmetic, bit-identical outputs; 40k scale ~112 ms.

### Added — units: `M2_PER_KM2` area scale (peteksim ask)
- `units::{M2_PER_KM2, km2_to_m2, m2_to_km2}` — the areal report scale (`1e6`
  m²/km²), mirroring `M3_PER_MCM` on the volume side. Purely additive. Lets
  consumers (peteksim) drop their local `const M2_PER_KM2 = 1e6` re-declarations
  and share one source of truth. Exposed in the Python wheel
  (`pt.km2_to_m2` / `pt.m2_to_km2`).

### License — Apache-2.0 (`decision_license_ratified`)
- The project is licensed under **Apache-2.0**. Canonical Apache License 2.0 text
  is provided as [LICENSE](LICENSE); a [NOTICE](NOTICE) names the copyright holder.
  Cargo `[workspace.package] license` and `pyproject` `license` / classifier are
  set to Apache-2.0.

### Added — serde derives on the public value types (`task_petektools_serde`)
- `#[derive(Serialize, Deserialize)]` added to `Sampler`, `Clamped`, `Variogram`,
  `VariogramModel`, `WellProfile` (and its `BuildHold` / `BuildHoldDrop`
  payloads). Purely additive — no field or behaviour change. Unblocks the
  config-layer scenario round-trip in downstream consumers (petekStatic
  `McInputs` wraps `Sampler` / `Clamped`). Covered by `tests/serde_roundtrip.rs`
  (round-trip equals value). The search index `Neighbourhood` is intentionally
  **not** serialisable — it is a live `rstar` R*-tree rebuilt from points, not a
  config value; its search parameters live as plain scalars on `SgsParams`.

### Added — viewer: section "Color by: property | zone" mode + long-fence label polish
- **Color-by-zone on the Intersection tab.** A new **Color by: property | zone**
  select flips each section cell's FILL between the property colormap and the
  fixed **categorical zone identity**. Payload (additive, FROZEN field names): a
  `SectionBundle` gains `zones: [{name, color?}]` and each `Column` gains
  `zone_ids` (per-k, aligned/NaN-gapped exactly like `values`; an index into
  `zones`). The trapezoid / sugar-cube **geometry path is unchanged** — only the
  fill source swaps. Zone colour rule: a **user-declared hex WINS** over the
  automatic palette; a zone with no declared colour takes the **same categorical
  identity slot the Volume/Wells zone legend uses for that name** (identity
  follows the entity across views — the dataviz rule). In zone mode the legend
  swaps to **zone chips** and hover shows the **zone name + the property value**.
- **Graceful fallback.** A payload without `zone_ids` (or without `zones`) never
  shows the select and stays on the property colormap — no error.
- **Colour discipline.** Zone identity reuses the pre-validated categorical slots
  (`--c1..--c8`); no new colours are introduced. **User-declared hexes bypass the
  validated palette by design** (the owner's colour choice wins) — the viewer
  surfaces this once per bundle as a `console.info` (advisory, not enforced).
- **Long-fence horizon-label polish.** On a ~16 km fence the interior-horizon
  labels all end against the right edge and clustered. The slot ledger is extended
  on two axes: the existing vertical slot PLUS a **horizontal stagger** (a
  displaced label steps left of the last, leader-lined back to its trace end) and
  a **fade** for a heavily-dragged label — so the on-line labels stay legible
  instead of a right-edge blob.
- **Tests.** Playwright harnesses `zone_bench.mjs` (zone-mode render, identity
  consistency vs the Volume legend, user-hex override, select-hidden fallback,
  both themes, zero console errors) and `label_bench.mjs` (no-overlap + stagger/
  fade engaged, both themes), driven from `test_viewer_perf.py`. Exposed test
  hooks: `window.__PETEK_SECTION_COLORBY`, `__PETEK_SECTION_HAS_ZONES`,
  `__PETEK_SECTION_LABELS`.

### Added — gridding: off-node scatter conditioning (`Conditioning::Bilinear`)
- **First-class off-node conditioning in the minimum-curvature solve.** New
  `Conditioning` enum + `grid_min_curvature_conditioned(coords, lattice, seed,
  conditioning)` — the additive superset of `grid_min_curvature_seeded`. The
  historical path (`Conditioning::NearestNode`, the default) snaps each sample to
  its nearest node, so a sample sitting **between** nodes carries a snap error up
  to the local gradient × its node-offset — metres on a dipping/curved flank
  (petekStatic's structure-fidelity audit measured ~0.5 m rms / 2.0 m max AT the
  data on a ~65 m scatter over a 100 m lattice). `Conditioning::Bilinear` instead
  honours an off-node sample through the **bilinear interpolation of its four
  surrounding nodes** (`Σ wₖ·zₖ = z_data`), folded into the SOR as a bilinear
  **least-squares** term in the combined biharmonic + data-fit normal equations
  (both SPD → the sweep stays convergent). The *interpolated surface* passes
  through the datum, eliminating the snap error. On the audit-shaped fixture
  (dense off-node scatter over a plane + dome) the on-data rms drops
  **0.569 m → 0.092 m (−84 %)**, max **4.49 m → 0.73 m**, holding identically under
  a world-scale georef.
- **Contracts preserved (additive; opt-in).** `grid()`, `grid_min_curvature_seeded`
  and `ConvergentGridder` are unchanged and keep `NearestNode` semantics
  bit-for-bit. A sample that lands **on** a node is still a hard anchor in both
  modes, honoured bit-exactly (an on-node-only input makes `Bilinear` bit-identical
  to `NearestNode`); the solve stays deterministic and warm-start compatible
  (`warm == cold` to solver tolerance on a well-determined fixture). The data-fit
  weight is a hard-honouring limit, not a tuning knob — the result is insensitive
  to it from `1e3` to `1e6`.
- **Bench (`benches/gridding.rs`, ~23 k off-node samples on 100×100).** Cold solve
  175 ms → 214 ms (+22 %); warm re-solve 0.57 ms → 4.75 ms (heavier because every
  data-region node is *free*, governed by the least-squares fit, not hard-pinned —
  the inherent cost of honouring off-node data; still low single-digit ms). The
  fix does not blow up solve time.
- **Adoption.** petekStatic's `solve_surface_converged` / `solve_surface_seeded`
  adopt it explicitly by passing each off-node control as its fractional node
  position `[x/xinc, y/yinc, z]` (unit-spaced solve lattice) with
  `Conditioning::Bilinear`, instead of snap-authoring scatter → node upstream.

### Added — synth: deviated well trajectories + world-frame default posture
- **Directional trajectory synthesis (`synth::synth_trajectory_profile`).** A new
  builder grows believable **deviated** wells from a [`WellProfile`]: `Vertical`
  (the unchanged default — bit-identical to `synth_trajectory`), `BuildHold`
  (kick off at a depth, build to a hold inclination at a believable rate, hold on
  a target azimuth), and `BuildHoldDrop` (the S-well that drops back toward
  vertical). Stations are placed by the **minimum-curvature** relation between
  adjacent `(inclination, azimuth)` pairs, so a bore sweeps real world `x/y` and
  crosses many areal columns at reservoir depth. This is trajectory *synthesis*
  (we author the analytic angle schedule) — **not** survey interpretation, which
  petekIO owns; the two only share the minimum-curvature geometry. Fully
  deterministic (no RNG). `BuildHold` / `BuildHoldDrop` validate their inputs
  (build/drop rates in `(0, 6]` °/30 m, `MAX_BUILD_RATE_DEG_PER_30M`; azimuth
  normalized to `[0, 360)`; drop after the build ends; `final_incl ∈ [0, hold]`).
  `max_dogleg_severity(&Trajectory)` scores a path's believability (deg/30 m MD).
  Station `z` convention unchanged (`kb_elevation − tvd`, subsea +up) — the
  `.wellpath` writer path keeps consuming it.
- **World frame is the documented default posture (`synth::Georef`).** Every
  spatial generator already honours a world georeference — the georeference *is*
  the `Lattice` / extent / wellhead you pass (house style: no separate georef
  vocabulary), so handing a world-placed input keeps the whole picture in the
  world. New `Georef` (a fictional origin, `FICTIONAL_ORIGIN = [431000, 6521000]`
  via `Georef::fictional()`) is a convenience over that default: it builds a
  world-placed `Lattice` (`.lattice(...)`) and translates a locally-built point /
  point-list / extent into the same frame (`.place_point` / `.place_points` /
  `.place_extent`) — the build-local → place-in-world idiom. No existing signature
  changed; a `Georef`-built lattice is an ordinary `Lattice`.
- **Tests.** The build/hold/drop segments are pinned against the analytic profile
  (bit-deterministic per seed); a dogleg-severity bound proves believability; a
  **world-frame round-trip** proves a top picked at a deviated well's reservoir
  crossing lands at the trajectory's actual `(x, y)` there, not the wellhead's
  (the frame + AlongBore escape the suite testing doctrine's R1 rule targets).
- **Python bindings (pass-through).** `synth_trajectory_profile(...,
  profile="vertical"|"build_hold"|"build_hold_drop", ...)` returns the same
  columnar dict as `synth_trajectory`; `max_dogleg_severity(md, incl, azim)` and a
  `Georef` class (`.lattice`, `.place_point`, `.place_points`, `.origin`) round out
  the surface. Covered by new smoke + round-trip tests in `test_petektools.py`.

### Added — pyo3 boundary hardening: GIL release, cached variogram getters, flat grid crossing
- **GIL released (`py.detach`) around the seconds-capable kernels.** `sgs` /
  `sgs_flat`, `local_kriging_grid` / `local_kriging_grid_flat`, `resample` /
  `resample_flat`, `experimental_variogram`, `Variogram.fit`, and the compute-
  heavy `synth` generators (`synth_dome_surface`, `synth_isochore`,
  `synth_trend_map`, `synth_log_series`, `synth_facies_series`,
  `synth_por_with_facies`, `synth_petro_curves`) now run their kernel with the
  GIL released — a long call no longer blocks other Python threads. Inputs are
  extracted to owned Rust *before* the release boundary (no `PyAny` crosses it).
  A spinner-thread smoke test (`python/tests/test_boundary.py`) proves the main
  thread keeps running during `experimental_variogram` / `sgs`.
- **`ExperimentalVariogram` getters are now cheap.** The `lags` /
  `semivariances` / `counts` lists are materialized **once** at construction and
  cached, so each access is a `Py` refcount bump instead of a full `Vec` clone +
  Python-list rebuild.
- **Flat grid crossing (additive).** New `*_flat` variants of the grid
  producers/consumers cross a field as a single little-endian `f64` `bytes`
  buffer + `(ncol, nrow)` shape — one `memcpy` instead of a boxed list-of-lists
  of ~1M Python floats: `sgs_flat`, `local_kriging_grid_flat`, `resample_flat`,
  `synth_dome_surface_flat`, `synth_isochore_flat`, `synth_trend_map_flat`. The
  nested list API is unchanged (the viewer glue and existing callers keep
  working); wrap the flat result with
  `np.frombuffer(buf, dtype='<f8').reshape(ncol, nrow)`. **Measured** at a
  1M-node grid (identical bilinear kernel, only the crossing differs): nested
  ~25 ms vs flat ~8 ms — **~3.1× faster**, 8 MB `bytes` vs 1M float objects
  (`test_flat_boundary_cost_1m`).

### Added — `store`: opt-in flush-behind writer (slab-bounded RSS for streaming builds)
- `StoreWriter::with_flush_behind(true)` (default off) makes each completed
  `write_slab_*` `msync` its byte range then page-evict it
  (`madvise(MADV_DONTNEED)` on unix), so a streaming build's resident set stays
  slab-bounded instead of growing `O(store)`. The in-place `slab_mut_*` fill path
  gets the same ceiling via the explicit `flush_behind_slab(name, slab)` hook.
- **Byte-determinism preserved:** flush-behind only controls page residency,
  never content — a flush-behind store is byte-identical to a plain one and
  reads back bit-exact (`flush_behind_is_byte_identical_and_reads_back`).
- **Platform behaviour (documented, honest):** on Linux `MADV_DONTNEED` drops the
  clean shared pages immediately (RSS stays slab-bounded — where an out-of-core
  RSS ceiling is asserted); on macOS/Darwin it is a softer deactivation hint
  (pages remain resident/reclaimable until pressure, so no write-time RSS drop —
  measured 190 MB either way at the 50M-elem scale); non-unix degrades to the
  `msync` alone. Write-throughput cost at 50M f32 (~200 MB): plain ~1.29 GiB/s
  vs flush-behind ~1.20 GiB/s (~7 %, msync overhead). New
  `benches/store.rs::store_write/slab_sequential_flush_behind` +
  `flush_behind_rss_probe` (ignored; `--ignored --nocapture`).

### Added — viewer: section cells follow zone edges by default (the sugar-cube ruling)
- Owner ruling: flat-box section cells are "sugar cube mode" and must not be the
  default. Against the FROZEN v4-additive schema (`IntersectionBundle` root gains
  `sugar_cube: bool`; each column gains `layer_tops_l/r` + `layer_bases_l/r` —
  the cell interval at the column's left/right fence edges, NaN-gapped exactly
  like `layer_tops`), the Intersection tab now renders each cell as a
  **trapezoid** `(d0,top_l)-(d1,top_r)-(d1,bot_r)-(d0,bot_l)` when the edge
  arrays are present and `sugar_cube` is false/absent — fill and the top/base
  horizon traces follow the dip within each column (`Number.isFinite` null-gap
  idiom throughout; an edge-NaN cell falls back to its centroid rect; the depth
  frame includes the edge extremes). `sugar_cube: true` or an older payload
  without edge arrays keeps the flat-rect path unchanged, gracefully. Hover
  keeps the **centroid** `layer_tops`/`layer_bases`; the 5× default vertical
  exaggeration is unchanged. Render mode exposed as
  `window.__PETEK_SECTION_MODE` (`"trapezoid"` | `"rect"`).
- **Label polish:** same-depth contact pairs (a GOC/OWC at one depth) now
  **combine** into a single label ("GOC + OWC 2,100 m") and the label slotter
  searches away from the nearer frame edge, so edge-clamped labels stack instead
  of overprinting; interior-horizon name labels at the right edge **stagger**
  via the same slot ledger.
- Playwright coverage over a hand-authored dipping fixture (petekStatic's
  producer half lands separately; round-trip at the next validation pass):
  pixel-samples the rendered canvas at two x positions inside one column —
  trapezoid mode is decisively non-horizontal (34 px of dip), sugar-cube and
  legacy payloads are flat (0 px), both themes, zero console errors
  (`test_section_trapezoid_follows_dip_both_themes`,
  `test_section_sugar_cube_and_legacy_fall_back_flat`). SCHEMA.md documents the
  v4-additive fields.

### Fixed — viewer: the volume tab never hangs on a bad mesh (empty-mesh + decode watchdog)
- A real build surfaced a volume whose mesh decoded to **0 triangles** (an
  upstream engine bug) and left the viewer stuck on "Decoding mesh…" forever with
  no error. The volume tab now **refuses loudly** instead of hanging: a decode
  that completes with zero triangles shows an in-tab message ("Mesh is empty —
  N cells declared, 0 triangles; this is a producer bug.") + a banner; and a
  **decode watchdog** (`DECODE_WATCHDOG_MS_DEFAULT = 30 s`, overridable via
  `window.PETEK_DECODE_WATCHDOG_MS`) surfaces a visible failure with diagnostics
  if the worker neither reports back nor errors in time. A crashed decode worker
  now surfaces the in-flight failure too (was silently dropped). The outcome is
  exposed for tests via `window.__PETEK_VOLUME_STATUS`. Complements the engine
  fix — the viewer refuses-loudly, never hangs. Playwright coverage:
  `test_volume_empty_mesh_refuses_loudly` + `test_volume_decode_watchdog_never_hangs`.

### Added — `geostat::SgsSession`: a reusable multi-layer SGS context (fast-resim)
- New `SgsSession` (additive; `sgs` / `sgs_unconditional` unchanged and now
  delegate through the same sweep core). Construct **once** over the layer-
  invariant frame — `SgsSession::new(lattice, variogram, max_neighbours, radius)`
  — then simulate **many layers** through it: `simulate(&coords, seed)` and
  `simulate_collocated(&coords, seed, &secondary, rho)`. Each call returns the
  `(ncol × nrow)` field in data space. The motivating workload is *resimulate*
  (rebuild a property model layer by layer); across layers only the conditioning
  point values/membership change, so the session threads one set of working
  buffers through every sweep instead of re-allocating per layer.
- **Determinism preserved exactly.** For the same data + seed (+ secondary) the
  session field is **bit-for-bit identical** to the corresponding one-shot `sgs`
  call — visitation order, RNG stream, and kriging arithmetic are unchanged; the
  session is an allocation restructure, not an algorithmic one. Proven by
  `session_matches_oneshot_across_layers` (6 layers, differing conditioning +
  seed), `session_collocated_matches_oneshot_across_layers` (Markov-1 variant),
  and `session_reuse_does_not_leak_state`; the bench additionally cross-checks
  field equality at 1M-cell scale.
- **What is retained vs. rebuilt** (see `SgsScratch` docs): the informed-node
  arrays, the visiting path, the per-node neighbour buffers, and — the point of
  the change — the simple-kriging **solver scratch** (matrix/rhs/perm/solution,
  via new `lu_factor_in_place` / `lu_solve_into` and `simple_kriging_with`) are
  reused with zero per-node allocation. The **R\*-tree is rebuilt per sweep by
  design**: it grows in visiting-path order (which differs per layer), so reusing
  or bulk-reloading it would change nearest-neighbour tie-breaking and break the
  pinned determinism.
- **Measured delta (honest).** New `benches/geostat.rs` sweeps 25 layers of a
  200×200 lattice (~1M cells) with 300 conditioning points/layer, old per-layer
  `sgs` vs. session, at two neighbourhood sizes. In steady state the two are
  **within noise** at both `max_n=8` (2.113 s vs 2.113 s) and `max_n=24` (5.46 s
  vs ~5.5 s); a cold single-shot sweep showed up to ~1.09× at `max_n=8`. Takeaway:
  the eliminated allocation was **not** the resim bottleneck — the cost is the
  determinism-pinned R\*-tree build/query and the per-node solve. The session is
  shipped as correct, bit-identical infrastructure (and the natural home for any
  future determinism-safe index reuse), not as a headline speedup.

### Fixed — viewer: `isFinite(null)` poisoned the section depth frame (rogue ~-250 m top)
- petekStatic emits `f64::NAN` for an inactive/truncated layer (follow-conformity
  pinch); serde serializes NaN → JSON `null`. The section renderer guarded depths
  with the **global** `isFinite()`, which *coerces* (`Number(null) === 0`), so
  `isFinite(null) === true` and null layer depths counted as **depth 0** — the
  frame's `zlo` collapsed to 0, the 12 % margin inflated off the full depth, and
  the axis stretched to a rogue negative top with a flat 1 px trace at `Y(0)`.
  Reported by peteksim (inbox 2026-07-04); reproduced against a reverted build
  (`zmin ≈ -234 m`) before fixing.
- **Every section depth read now uses `Number.isFinite`** (rejects null): the
  depth-axis framing (`resDepths` + contact depths), the layer fill loop (an
  inactive cell draws nothing), `drawTrace` (a null run now also **breaks** the
  top/base polyline instead of bridging the gap), the contact line draw, and the
  hover layer-hit (no phantom band at the frame top). The v4 interior-horizon
  trace gap check was already null-safe; tightened to the same idiom.
- The payload is CORRECT per the NaN=inactive wire contract — the fix is
  viewer-side (a JSON `null` depth is *inactive*, never 0). The correlation demo's
  gapped trace now ships JSON `null` (not a Python NaN → `NaN` literal, which is
  invalid JSON for the served `model.json`).
- Regression: `test_section_null_depths_frame_finite_extent` — a section with
  null *runs* (a pinched-out layer across columns + a fully-inactive column + a
  null contact) must frame to the finite extent exactly (asserted via the new
  `window.__PETEK_SECTION_FRAME` harness hook; `wells_bench.mjs` reports it).

### Added — viewer wave 4: the Wells correlation tab + the two v4 render obligations
- **A fourth view — the `Wells` tab (multi-well log correlation).** Consumes a new
  `WellLogBundle` (`kind: "wells_logs"`, `schema_version: 4`) — N wells
  side-by-side on a **shared inverted depth axis**, per-well track sets (a
  flag/facies strip, **PHIE** with a cutoff line + reservoir fill, a derived
  **NTG** curve, **SW**), **boxed per-track headers** (name + hi–lo scale, no
  legend boxes), **tops** as cross-track lines labelled once + **zone shading**
  between them, a **hover readout** (depth + per-curve values), and per-well
  **show/hide + reorder**. Two **hanging modes**: *TVD* (absolute) and
  **flatten-on-pick** (choose a horizon; every well shifts so that pick aligns at
  Δ = 0 — the transform is viewer-side). A well with no top for the chosen pick is
  **parked** (drawn at absolute TVD, dashed frame + a tag). **Curve identity is by
  track** (mnemonic), never by well. Both themes.
- **The log lanes ride the existing decode path.** `md_m` / `tvd_m` / curve
  `values` are v3-style f32 binary blocks (`{dtype,shape,data(base64)}`, LE,
  `NaN`=`0x7FC00000`) decoded on the **same** `PETEK_DECODE` kernel the volume
  blocks use — synchronously (lanes are tiny; no worker, no special casing).
- **Section interior-horizon traces (v4).** The Intersection tab now renders
  `SectionBundle.horizon_traces` — one polyline per *interior* framework horizon,
  its `depths` parallel to `columns`, **NaN-gapped** where a column doesn't reach
  it, labelled once at the right (closes `question_viewer_interior_traces`).
- **Map well-tie glyphs (v4).** A well carrying `ties` wears a small **3-pip
  tie-quality glyph** beside its marker (filled by mean-|residual| tier: ≤2 m
  good, ≤5 m fair, else poor — **text tokens, never a series hue**); the hover
  readout adds a `mean |tie|` + tier row.
- **Reference fixture (`_wells.py`).** `build_well_log_bundle()` hand-authors a
  believable multi-well bundle — sandy / shaly / mixed zones with **coupled**
  PHIE·NTG·SW·facies shapes (net flag derived from PHIE by a cutoff, SW
  anti-correlated), tops + a flatten pick, and **one well deliberately missing a
  pick** (the parked-well path). `encode_lane` reuses `_v3._le_bytes`. This is the
  round-trip contract test the upcoming peteksim/petekio producers must satisfy.
  `python -m petektools.viewer.demo --wells` renders it self-contained.
- **Coverage.** `test_viewer.py` adds the `wells_logs` schema + lane round-trip +
  believability + missing-pick + correlation-demo tests; `test_viewer_perf.py` +
  `viewer_perf/wells_bench.mjs` add a Playwright leg over the Wells tab at 1/4/8
  wells (both hang modes, hover, theme flip, section + map) under the zero-console-
  error watch. `SCHEMA.md` / `VIEWER.md` document the `wells_logs` kind + the two
  v4 render obligations.

### Added — `store`: the chunked mmap lane store (out-of-core R1)
- **A new `store` unit** — a domain-agnostic chunked, memory-mapped lane store:
  the spill-to-disk backing for larger-than-memory models (out-of-core ruling
  **R1**, consumed by petekStatic's slab-streaming build). One file of named
  typed **lanes** chunked along the slow (**k-slab**) axis, so slab-sequential
  streaming writes and windowed random reads are both natural. Same file family
  as `.pproj` / the v3 wire lanes: little-endian, versioned header, **fixed
  strides, no compression**, **no heavy deps** (`memmap2` + `bytemuck` only — no
  HDF5/Arrow/parquet).
- **Deterministic layout.** Lane offsets are recomputed identically by writer and
  reader (never stored), so identical schema + data → **byte-identical file**
  (asserted). Lanes are 64-byte aligned ⇒ all typed views are **zero-copy**.
- **Dtypes** `f32` (default) / `f64` (opt-in, ruling R4) / `u16` / `u32`; **lane
  kinds** `Slab { elems_per_slab }` (k-chunked) and `Flat { len }` (k-invariant,
  e.g. `COORD`). **API:** `StoreWriter::create` → `write_slab_*` / `slab_mut_*`
  (streaming, in-place) / `write_flat_*` → `finalize` (writes an end-of-store
  seal); `Store::open` (validates header + dims + seal) → `slab_*` / `window_*` /
  `lane_*` / `flat_*` slices + `*_view_*` ndarray `ArrayView1`/`ArrayView2`.
- **Loud typed failures** on the crate taxonomy: bad magic / newer version /
  **unfinalized or truncated file** → `Parse`; dtype/length/range/kind →
  `InvalidArgument`; unknown lane → `NotFound`. 9 integration tests
  (`tests/store_roundtrip.rs`) + criterion benches (`benches/store.rs`): 50M-elem
  f32 lane — write ≈ 1.5 GiB/s, sequential read ≈ 7 GiB/s, random-window read
  ≈ 7 GiB/s.
- **Crate-level `#![forbid(unsafe_code)]` relaxed to `#![deny(...)]`** — the only
  `unsafe` in the crate is the store's two `memmap2` map calls (each documented
  with a `SAFETY` note); the rest of the crate stays unsafe-free. `store` is the
  crate's second deliberate I/O carve-out alongside `container`.

### Added — viewer scale hardening (never-crash, graceful degradation)
- **Automatic graceful degradation.** The Volume tab's triangle budget (5M,
  overridable via `window.PETEK_TRI_BUDGET`) no longer *refuses* an over-budget
  shell — the worker **decimates it to a 1-in-`stride` preview** (`stride =
  ceil(T / budget)`) so the render buffer and JS heap stay bounded, and a **loud
  banner** + a `1:stride` badge say exactly what was decimated and why (with the
  raise-threshold / re-export-a-coarser-LOD remedy). A payload whose inline blocks
  exceed the hard memory cap (can't even be read) still refuses gracefully and
  points at sidecar mode. The viewer **never crashes, OOMs, or blanks silently**.
- **Decimation in the decode kernel.** `expandRenderPositions` / `decimateTriCell`
  / `decodeSync` take a `stride`; the inline worker emits only every `stride`-th
  triangle (bounded output + heap), keeping `tri_cell`→cell identity, recolour and
  the threshold/zone filter intact on the preview.
- **Windowed + resolution-capped map raster.** The Map tab rasters only the grid
  cells inside the current viewport, never finer than one sample per screen pixel
  (subsampled beyond that) into a **reused** offscreen buffer via a **256-entry
  colormap LUT** — so a full repaint is a screenful regardless of ncol×nrow
  (a 2000×2000 field repaints in ~2 ms vs a full-grid ~150 ms), and never
  allocates an ncol×nrow image. Hover still reads the full-resolution value array.
  The Intersection fills are likewise windowed (≤2 columns per horizontal pixel).
- **Playwright memory-cap + fps harness.** `render_bench.mjs` now asserts a JS-heap
  cap, a map-render (windowed-raster) budget, per-tab liveness, theme flips, and a
  **zero console-error** watch, and can force + screenshot the degradation state
  (`--tri-budget`, `--expect-degraded`, `--screenshot`). Driven by
  `test_viewer_perf.py` at the ledger scales (100k / 1M / **5M**, the last proving
  the never-OOM guarantee) — heap 15/45/242 MB, decode+render 0.17/0.27/0.88 s, no
  console errors; skips cleanly when playwright/chromium is absent (CI).
- **Bug fix:** `[hidden] { display: none !important; }` — a class rule
  (`.empty { display: flex }`) was overriding the `hidden` attribute, leaving a
  stale empty-state overlay painted over a tab after switching away from it.

### Added — viewer v3 volume (binary exterior-shell payload)
- **v3 `VolumeBundle` decode.** The Volume tab reads petekStatic's v3 wire
  contract (its `API.md`): a corner-point **exterior shell** in raw little-endian
  binary blocks (`positions`/`indices`/`tri_cell`/`cell_values`/`zone_ids`),
  either base64-inlined (self-contained) or **sidecar** (`model.bin` offset/length
  manifest). Blocks decode straight into typed arrays in an **inline Web Worker**
  — no JS-array materialization — killing the ~537 MB V8 string wall the JSON soup
  hit at ~1M cells (1M cells now decode in ~15 ms at ~11 MB heap; 5M in ~64 ms at
  ~45 MB). The legacy v2 JSON soup still renders as a fallback (version-switched on
  the bundle's `schema_version`).
- **Flat-shaded shell render.** Deduped verts re-expand per triangle so each face
  flat-shades in its own `tri_cell` colour (`DoubleSide`); the **threshold** +
  **zone** toggles rebuild a visible-triangle index client-side; colormap switches
  re-bake colour in the worker; z-exaggeration is a `mesh.scale.y`.
- **Guards.** A declared **triangle budget** (5M) and an inline-payload size cap
  refuse-gracefully with a visible banner + a k-slab/LOD suggestion; a failed
  decode / `JSON.parse` / `model.json` load now surfaces a **loud banner** (no
  more silent blank page).
- **Server re-cut seam.** A pluggable `/volume` provider (`volume_provider`,
  mirroring `section_provider`) lets a served viewer re-cut the shell at a cutoff
  for true interior exposure (peteksim wires it later); a sidecar `model.bin` is
  served alongside `model.json`.
- **SCHEMA.md → v3**, top-level `schema_version` **3**; the standalone demo emits a
  v3 exterior-shell volume; a Node decode bench + Playwright render harness land
  under `python/tests/viewer_perf/`.

### Changed — viewer polish round (validation W18–W22 + coordinator inspection)
- **Map.** Defaults to the **top-horizon depth map** (structure first); the areal
  raster is **clipped to the outline polygon** (an *Unclipped raster* QC toggle
  disables it); **co-located wells** (sidetracks sharing a wellhead) render as one
  shared marker with a **bore-count badge** and radially fanned, leader-lined
  labels; contact subcrop masks gain a **45°/135° hatch + 2px identity outline**;
  the canvas **fits & centres** the full drawn content (frame ∪ outline ∪ wells).
- **Intersection.** The depth axis frames the **reservoir envelope** (layers +
  contacts + margin) instead of the whole surface→TD trajectory (which squashed the
  reservoir to a sliver); the bore path is clamped into the window with an
  **off-scale arrow** where it exits; contact labels collision-nudge; margins padded.
- **Volume.** A **z-exaggeration** slider (1–20) **defaulting to 5×** (fixed, as
  for the section), with a **fit z ×N** button that applies the aspect-derived
  suggestion so a thin, wide reservoir shows relief, not a pancake; display-only
  depth scale; `z ×N` corner badge; true depths in the readout.
- **Tornado.** Folds negligible-swing rows (`< fold_threshold · |base|`, default
  0.5%) into "N others"; renders a bar `display_name` (e.g. `PORO level shift` vs
  `porosity (draw)`).
- **Distribution.** Exceedance panel gains 0/25/50/75/100 % y-ticks; a single-series
  distribution drops the legend box; histogram bars keep a 2px surface gap.
- **Display names everywhere.** An optional `display_name` renders in place of the
  raw name; absent it, a scoped `A::B` name beautifies to `A (B)`. The identity
  colour slot always keys off the raw name.
- **Grid geometry panel.** A **Grid** group (cell dims i×j×k + mean cell size) shows
  on every tab.
- **Well ties.** Per-horizon surface-tie residuals (payload `wells[].ties`) show on
  map well hover and in the layer panel's per-bore entries.
- Additive schema fields (`display_name`, `wells[].ties`, tornado `fold_threshold`)
  documented in `SCHEMA.md`; behaviour in `VIEWER.md`. All additive → `schema_version`
  stays **2**.

### Added
- **`synth::petro` — coupled petrophysics (net-to-gross DERIVED from porosity)**
  (public; Python-exposed). `PetroZoneSpec` + `synth_petro_curves` emit one
  `PetroCurves { phie, net_flag }` where `net_flag = (phie ≥ net_cutoff)` **by
  construction** (default cutoff `0.10`) — not an independently generated second
  channel. The spec is stated in the numbers a petrophysicist quotes: the zone
  `ntg_target`, the **net-rock** `{mean, std}` (`net_por`, i.e. `φ | φ ≥ cutoff`),
  and the shale porosity distribution (`nonnet_por`). The generator **solves a
  facies mixture** (sand distribution + facies proportion, via the moment-matched
  logit-normal machinery and a smooth 2-D Newton calibration) so the *realized*
  series hits both `ntg_target` and `net_por` — correctly accounting for the
  **across-cutoff leak** (a sand bed's below-cutoff tail and a silty shale's
  above-cutoff tail both cross the flag, so `NTG ≠ sand fraction` and the net rock
  is a genuine sand+shale mixture, `net ≠ sand`). Infeasible specs error typed with
  the achievable bound stated — the **NTG floor** (`P(nonnet ≥ cutoff)`, the shale
  leak) and the **net-std floor** (the between-facies spread a heavy leak imposes on
  the bimodal net rock). `ntg_curve` renders the derived flag as a continuous NTG
  display curve (windowed mean). Accuracy (≥5–6 seeds, 30 k samples): realized NTG
  within ~0.013, net mean/std within ~0.002 of target — even with a heavy 15 % shale
  leak; autocorrelation of the derived flag preserved; bounds strict.
  - **Migration.** This is the petrophysically-honest replacement for composing an
    **independent** porosity/NTG pair. To couple net to φ, use `synth_petro_curves`
    (net derived) + `ntg_curve` (display) instead of pairing `synth_facies_series` /
    `synth_por_with_facies` with a separately-generated NTG. The lower-level facies
    primitives (`synth_facies_series`, `synth_por_with_facies`, `Facies`,
    `MomentSpec`) remain as building blocks — the coupled generator composes them.
- **`synth` — believable synthetic subsurface data** (public, namespaced
  `petektools::synth`; Python-exposed). Seeded, deterministic generators that
  compose into a whole synthetic asset (a stand-in for a confidential dataset):
  - **1-D logs** — `ZoneSpec` + `synth_log_series`: one continuous,
    depth-autocorrelated property curve hitting each zone's `{mean, std}` in
    `[0,1]`, with optional graded boundary transitions. Two documented maths
    primitives underneath: an AR(1)/exponential correlated-Gaussian series (the
    depth memory) and a **moment-matched logit-normal transform** onto `[0,1]`
    (nested-bisection quadrature; Bernoulli-variance cap; bounds never violated).
  - **Facies** — `synth_facies_series` (truncated-Gaussian binary sand/shale at a
    target NTG, realistic bed thicknesses) + `MomentSpec` / `synth_por_with_facies`
    (sand/shale porosity contrast on an independent sub-stream so facies selection
    does not bias porosity).
  - **2-D recipes** — `NoiseSpec` + `synth_dome_surface` (four-way closure + tilt +
    correlated noise), `synth_isochore` (non-negative thickness), `synth_trend_map`
    (a `[0,1]` depositional trend, optionally correlated at a known `ρ` with a
    supplied field for collocated-cokriging tests). All via `sgs_unconditional`.
  - **Wells** — `place_wells` / `place_wells_in_polygon`, `tops_from_surface`
    (bilinear pick + residual `Sampler`), and `Station` / `Trajectory` /
    `synth_trajectory` (vertical today; the type is deviated-ready).
  - **Outlines** — `closure_outline` (marching squares) + `study_area_outline`.

  Every generator is bit-reproducible per seed; statistical acceptance (per-zone
  means/stds, facies proportion == NTG, autocorrelation length, recovered `ρ`) is
  tested across ≥3 seeds. Math cited per module; derived independently.
- **`geostat::sgs_unconditional`** — the same sequential-Gaussian machinery as
  `sgs` but with no conditioning data and a **parametric** `N(mean, variance)`
  target (the shared sweep was extracted from `sgs`; existing `sgs` behaviour and
  bit-reproducibility unchanged). The synthetic 2-D field primitive.
- **Generic chart marks in the viewer unit — the `charts` bundle** (Charts tab;
  `schema_version` **2**, additive). The reserved chart-mark section of the render
  schema is now real: three theme-aware, hover-default, **strictly render-only**
  canvas-2D marks, one colour system (the validated diverging pair for signed
  data; the existing identity slots + sequential ramp for the rest):
  - **`tornado`** — ranked sensitivity with the nested-bar signature (inner P90→P10,
    faint outer min→max) around a symmetric base line, diverging two-hue swings, a
    top-N + "N others" fold; hover shows lo/hi pivot inputs + output range.
  - **`scatter`** (crossplot) — x/y with optional per-axis log scale,
    colour-by-third (continuous ramp + colorbar / categorical identity + legend),
    optional per-group trend lines whose coefficients arrive **in** the payload.
  - **`distribution`** — histogram + exceedance-CDF as **two stacked panels sharing
    the x-axis** (the dual-y twinx overlay is deliberately not used), P90/P50/P10 in
    the reservoir convention, multi-series overlay.
  - Codified in `python/petektools/viewer/SCHEMA.md` (§ ChartBundle); the standalone
    `demo` gains one of each mark (the second-consumer proof stays true).
- **The viewer unit — `petektools.viewer`** (wheel-only; owner ruling
  `decision_viewer_home_petektools`, 2026-07-04). A domain-agnostic renderer of
  typed JSON bundles (map raster layers · section columns · corner-point mesh),
  relocated from peteksim's v1 viewer because it serves **all** layers (petekStatic,
  petekIO, peteksim) — horizontal capability, not a product feature.
  - `viewer.serve(payload, port=0, block=False, open_browser=True, section_provider=None)`
    — the background-thread local server (127.0.0.1) with a pluggable `/section`
    endpoint; the `section_provider` callback (`line=`, `well=`, `property=`) is how
    a **domain** package answers live fence/well requests. The unit computes nothing.
  - `viewer.save_view(payload, path, precomputed_sections=None)` — one
    self-contained HTML file (all JS + data inlined; opens via `file://` with **zero
    external fetches**). `viewer.build_server(...)` is the lower-level `(httpd, url)`.
  - `payload` is a dict **or** a pre-serialized JSON string; the **generic render
    schema** (petekTools' new contract) is codified in
    `python/petektools/viewer/SCHEMA.md`, extracted from what the renderer reads.
  - JS assets (three.js r160 vendored global, map/section/volume tabs, the palette
    system) ship as wheel package data (`python/petektools/viewer/assets/`); the
    crates.io Rust kernel crate **excludes** them and stays lean.
  - `python -m petektools.viewer.demo` — a standalone raster + section + mesh demo
    (no peteksim / petekStatic), the second-consumer proof of the ruling.
  - SPEC gains the **viewer-unit carve-out** (modeled on the `container` one):
    domain-agnostic rendering of typed JSON bundles; no domain logic, no computation,
    no domain I/O. See `VIEWER.md`.

### Fixed
- `gridding` (`ConvergentGridder`): **re-controlling a node now replaces its held
  value** instead of averaging. Previously each `add_control(ip, jp, z)` appended a
  fresh coincident sample, so adding a second control at a node the caller had
  already set left that node at the *mean* of the two values (e.g. `99` then `50`
  settled at `74.5`) — contradicting the documented hard-constraint promise. The
  gridder now keys controls by node and rewrites the held row in place, so the
  **latest** value wins and `coords` no longer grows unboundedly across a long
  interactive session. **Behaviour change** for callers that re-controlled a node
  and relied on the averaging; the single-set and cold paths are unchanged. Purely
  internal — no public signature change. (review finding T3)
- `gridding` (minimum-curvature): **interior sag on dipping surfaces eliminated.**
  The SOR relaxation (`grid` `MinimumCurvature`, `grid_min_curvature_seeded`, and
  the `ConvergentGridder` warm path — one shared kernel) previously treated
  lattice-boundary nodes with a one-sided harmonic (flat/free) fallback, which let
  interior solutions sag toward the edge instead of following the regional dip. On
  a 5-control dipping-plane analytic reference (a plane is the exact minimum-curvature surface)
  this sagged **~12.5 ft** where the reference solver holds ~0. The kernel now
  applies the **natural-dip boundary condition**: the stencil runs at every free
  node with out-of-lattice nodes synthesized by linear extrapolation
  (`z[t] = 2·z[t+1] − z[t+2]`), so a planar regional-dip field is an exact fixed
  point everywhere (max per-node drift on the analytic reference now < 1e-3 ft). This brings
  the kernel to node-for-node parity with the family cold solver (`petekStatic`
  `srs-gridder::solve_surface`). Purely internal — **no public signature change**.

### Changed
- `geostat` (`LocalKriging`) / `gridding` (`OrdinaryKriging`): the coincident-point
  merge is now a single shared `O(n)` hash-grid pass (was an `O(n²)` scan copied
  in both kernels). On the 40 k-point local-kriging scale check this roughly
  **halves** end-to-end time (~303 ms → ~105 ms); output is byte-for-byte
  identical (golden-tested against the old scan). Internal — no public signature
  change. (review finding T1)
- `gridding` (minimum-curvature): to make the natural-dip boundary converge, the
  relaxation now blends a light **tension** (`T = 0.25`, Smith & Wessel 1990) into
  the biharmonic stencil, stops on an **absolute** tolerance (`max_delta < 1e-6`,
  was scaled by data range), and raises the sweep cap to `MAX_ITERS = 20 000` — all
  matching the family cold solver. The near-Neumann boundary relaxes smooth modes
  slowly, so a **cold** one-shot solve is materially slower (bench
  `min_curvature_cold_40x40`: ~1.5 ms → ~0.50 s) in exchange for correctness; a
  **warm** re-solve from a converged field still stops in ~1 sweep (bench
  `min_curvature_warm_40x40`: ~13 µs → ~44 µs), so the warm-start speed-up widens
  (~115× → ~11 000×). Fixed points are unchanged by these knobs; the `warm == cold`
  continuity guarantee holds (now to ~1e-6 rather than ~1e-3).

### Added
- `gridding`: **grid → grid resample** — `resample(src_grid, src_georef, target,
  ResampleMethod::{Bilinear, Nearest})` resamples a native regular grid (values on
  a georeferencing `Lattice`) onto a foreign target `Lattice`, the counterpart to
  the scattered → grid kernels (a private trend-surface resampler downstream will
  retire onto it). **Axis-aligned only** (`rotation_deg == 0`; `yflip` honoured
  through the coordinate maps — Petrel exports are axis-aligned, rotation is future
  work); no new georef type (the source `Lattice` already carries origin + spacing
  + counts in world coordinates). **Null / extent policy** (fixed + documented):
  outside the source extent → `NaN` (never extrapolate); `Nearest` snaps to the
  closest node; `Bilinear` returns `NaN` if the *nearest* corner is `NaN`, else the
  weighted mean over the **finite** corners with weights renormalized (a `NaN`
  corner is dropped). Tested: bit-equal identity, bilinear exact on an affine field
  under 2× refinement, nearest snap, null-hole propagation, outside-extent `NaN`,
  and an offset-origin world-coords case (georeference honoured, not index-space).
  Re-exported at the crate root. Additive and non-breaking.
- `units`: the **SI/metric reporting layer** (family standard,
  `decision_si_units_standard`) — `m3_to_mcm`/`mcm_to_m3` (`M3_PER_MCM = 1e6`),
  `m3_to_msm3`/`msm3_to_m3` (`SM3_PER_MSM3 = 1e6`, oil), `m3_to_bcm`/`bcm_to_m3`
  (`SM3_PER_BCM = 1e9`, gas), `scf_to_sm3`/`sm3_to_scf`
  (`SCF_PER_SM3 = 35.314_666_721_488_59 = (1/0.3048)³`, the pure geometric
  `ft³/m³` factor — no standard-condition correction), `stb_to_sm3`/`sm3_to_stb`
  (`SM3_PER_STB = M3_PER_BBL = 0.158_987_294_928`), and a `format_volume` display
  helper (`"12.4 mcm"` / `"4.0 bcm"` / `"950.0 m³"` by magnitude). `Sm³` is a
  scale label at this layer (`1 Sm³ ≡ 1 m³`), documented as **not** a PVT
  conversion. The module doc now states the family SI-standard convention once
  (imperial = opt-in). Additive.
- **Python wheel:** exposed `resample` (grid → grid over `Lattice`, `"bilinear"`
  / `"nearest"`, `NaN`-aware) and the SI `units` reporting layer (`m3_to_mcm` /
  `m3_to_msm3` / `m3_to_bcm` + inverses, `scf`/`stb` ↔ `Sm³`, `format_volume`)
  through the `petektools` wheel, with smoke tests in
  `python/tests/test_petektools.py`.
- `geostat`: the `#[ignore]`d 40k local-kriging scale test now **enforces** the
  scalability contract — a release-gated assertion of a 2 s budget (≈5× headroom
  over the measured ~0.3 s), so the contract is asserted, not merely printed
  (still `#[ignore]`d for normal runs; asserts under `--release --ignored`).
- **Python wheel (`petektools`, PyO3)** — a thin binding crate (`py/`, a
  `publish = false` workspace member) + maturin mixed layout (`pyproject.toml` at
  the root, package in `python/petektools/`). abi3-py39 → one wheel for CPython
  3.9+ (pyo3 0.29). Exposes the toolkit front-door: all `Sampler` variants +
  `.clamped()` + a seeded `Rng` (`sample`/`sample_n`/`sample_n_seeded`); the
  `stats` descriptive + weighted family; `reservoir_summary` (P90=low) and
  `aggregate`; and the `geostat` front-door (`experimental_variogram`,
  `Variogram` fit/params, `local_kriging_grid`, `sgs`) over a `Lattice`. Vector
  inputs accept a `list` or a numpy array (no numpy dependency); outputs are
  plain floats/lists. **Cross-language reproducibility** is pinned by a parity
  vector (`tests/parity.rs`), re-asserted from the wheel
  (`python/tests/test_petektools.py`): same seed + params → the identical Rust
  stream. A `.cargo/config.toml` defers Python-symbol resolution on macOS so a
  workspace-wide `cargo` build/test still gates without breaking the non-Python
  build; CI gains a wheel build + import matrix (py 3.9–3.14).
- `geostat`: a new **geostatistics module** — the inference/scale/stochastic layer
  above the single global krige. Type-agnostic (`[[f64; 3]]` + `Lattice`),
  reusing the crate `Variogram`, the OK dense LU solver, and `rstar`. Derived from
  primary literature (GSLIB; Goovaerts 1997; Xu et al. 1992 / Almeida & Journel
  1994; Chilès & Delfiner) — no third-party code. Additive and non-breaking.
  - `experimental_variogram(coords, lag, n_lags)` → `ExperimentalVariogram`
    (omnidirectional Matheron estimator, binned by lag, empty bins dropped, mean
    lag per class).
  - `Variogram::fit(model, &experimental)` — pair-count weighted least-squares fit
    (for a fixed range the model is linear in nugget+sill → closed-form 2×2 with
    non-negativity; range by deterministic grid search + refinement). Recovers
    known spherical/exponential parameters from synthetic data within tolerance.
  - `LocalKriging` — moving-neighbourhood ordinary kriging (max-n neighbours
    within a radius via `rstar`, small per-node dense solves). Reproduces global
    `OrdinaryKriging` when the neighbourhood covers all data; scales where the
    global solve cannot (**~40k conditioning points → 120×120 grid in ~0.4 s**,
    release). Nodes with no data in range are `NaN`.
  - `NormalScore` — the normal-score transform (`fit`/`forward`/`back`, Hazen
    plotting position, tie-merged, tails clamped) over `statrs`'s Φ/Φ⁻¹.
  - `sgs(coords, lattice, &SgsParams)` — sequential Gaussian simulation, conditioned
    exactly on the data, seeded/bit-reproducible, with an optional collocated
    cokriging (Markov-1) secondary (`SgsParams.collocated = Some((field, ρ))`;
    `ρ=0` reduces to plain SGS bit-for-bit). Build-fast (one simulation per
    property build, per `decision_mc_composition`). The per-node simple-kriging /
    collocated-cokriging core (`simple_kriging`, correlogram form) is shared with
    `LocalKriging`. AlgorithmSpec back-fill for these contracts is pending
    (coordinator-authored).
- `sampling`: **sampler hardening** for bounded appraisal inputs.
  - `Sampler::TruncatedNormal { mean, std_dev, lo, hi }` (via
    `new_truncated_normal`) — a normal *reshaped* onto `[lo, hi]`, drawn by the
    exact **clipped-CDF (inverse-transform)** method (no rejection loop, always
    in-bounds).
  - `Sampler::clamped(lo, hi) -> Clamped` — a general hard-limiter combinator over
    *any* sampler. Clamping piles tail mass at the bounds (point masses) and is
    documented as distinct from truncation (which reshapes the density).
  - `reservoir_summary(&[f64]) -> ReservoirSummary { p90, p50, p10, mean }` — the
    oil-industry **P90 = low / P10 = high** exceedance digest (`P90 ≤ P50 ≤ P10`),
    over the crate's own type-7 percentiles (Excel `PERCENTILE` parity). The
    convention is documented once, on the module.
  - `aggregate(segments, Correlation) -> Vec<f64>` — sum per-segment realization
    vectors under `Correlation::{Independent, Comonotonic}` (index-wise; result
    length = shortest segment). `Correlation` is `#[non_exhaustive]`; a rank
    (`Rank(rho)`) coupling is the planned next variant. Uses `statrs` for the
    standard-normal CDF/quantile in the truncated draw. Namespaced under
    `sampling`; additive and non-breaking.
- `units`: the daily SI/metric conversions — `ft_to_m` / `m_to_ft`
  (`FT_TO_M = 0.3048`, exact), `m3_to_bbl` / `bbl_to_m3`
  (`M3_PER_BBL = 0.158_987_294_928`, exact oil barrel), `psi_to_bar` /
  `bar_to_psi` (`BAR_PER_PSI = 0.068_947_572_931_683_6`), and `md_to_m2` /
  `m2_to_md` (`MD_TO_M2 = 9.869_233e-16`, the standard millidarcy factor). Same
  const + `#[must_use]` fn style, exact factors in the doc comments,
  hand-checked tests. The module was imperial-only before. Additive.
- `foundation::AlgoError`: new `InvalidArgument(String)` variant for bad
  parameter / out-of-range errors from the `stats` / `sampling` front-doors
  (previously these masqueraded as `InvalidGeometry`). The enum is now
  `#[non_exhaustive]` so any future variant stays non-breaking — landed before
  the 0.2.0 publish so it is never a breaking change later.

### Changed
- `stats` / `sampling`: parameter and range errors (e.g. a percentile outside
  `[0, 100]`, a non-positive `std_dev`, a `values`/`weights` length mismatch)
  now return `AlgoError::InvalidArgument` instead of `AlgoError::InvalidGeometry`
  — an honest taxonomy (geometry errors stay for degenerate lattices/kriging
  systems).

### Fixed
- `stats::{percentile, median}`: **now implement true type-7** (Hyndman & Fan
  1996) linear interpolation — rank `p·(n−1)` on the 0-based order statistics —
  matching Excel `PERCENTILE` / R's default `quantile`
  (`percentile([1,2,3,4,5], 25) == 2.0`). The previous path delegated to
  `statrs`'s `OrderStatistics::quantile`, which is type-8 (it returned `1.667`
  for that case) while the docstring claimed type-7. `statrs` is still used for
  the moments. `weighted_percentile` keeps its documented
  centre-of-weight-interval convention, now with an explicit note that it does
  not coincide with the unweighted type-7 percentile even at equal weights.
- `gridding::kriging`: **`Variogram::new` now validates on the variance each
  model's `gamma()` actually consumes.** A `Nugget` model ignores `sill`
  (γ(h>0) = c₀), so `Variogram::new(Nugget, nugget=0, sill>0, ..)` previously
  passed the naïve `nugget + sill > 0` check yet produced an all-zero Γ and a
  singular kriging system that only surfaced at krige-time as a misleading
  "singular system … duplicate points" error. It is now rejected at
  construction with an honest message.

### Added
- `gridding::kriging`: **ordinary kriging** with the standard variogram-model
  family. `Variogram` (`VariogramModel::{Nugget, Spherical, Exponential,
  Gaussian}` + nugget/sill/range, validated at `Variogram::new`) exposes the
  semivariance `gamma(h)`; `OrdinaryKriging` is a global-neighbourhood ordinary-
  kriging gridder — `grid(coords, lattice)` for the estimate field, or
  `krige(coords, lattice)` for `(estimate, variance)`. Exact interpolator with no
  nugget; coincident data are averaged. Derived from the primary geostatistics
  literature (Matheron 1963; Journel & Huijbregts 1978; Isaaks & Srivastava 1989;
  Cressie 1993). Re-exported at the crate root. Additive and non-breaking.
- `gridding::Gridder`: a trait unifying the scattered-data → grid backends behind
  one interface — implemented by `GridMethod` (so
  `method.grid(coords, lattice) == grid(coords, lattice, method)`) and by
  `OrdinaryKriging`, usable as `Box<dyn Gridder>`. The stateful/seeded warm-start
  entry points (`grid_min_curvature_seeded`, `ConvergentGridder`) are documented
  as intentionally outside the trait. Re-exported at the crate root. Additive and
  non-breaking (no existing signature changed).
- `stats`: a curated, validated descriptive-statistics front-door. Unweighted
  `mean` / `variance` / `std_dev` / `percentile` / `median` thinly wrap `statrs`
  (returning a `Result` instead of panicking); the weighted family
  `weighted_mean` / `weighted_variance` / `weighted_std_dev` /
  `weighted_percentile` (reliability weights; not in `statrs`) is our own. Adds
  the `statrs` dependency. Namespaced under `stats` (not root-re-exported).
- `sampling`: a curated, validated distribution-sampling front-door over `rand` +
  `rand_distr`. `Sampler` (`Uniform` / `Normal` / `LogNormal` / `Triangular`,
  validated at construction) with `sample` / `sample_n`, plus `seeded_rng(seed)`
  for reproducible Monte-Carlo streams. Adds the `rand` and `rand_distr`
  dependencies. Namespaced under `sampling` (not root-re-exported).

## [0.1.0] - 2026-07-03

### Added
- `container`: a domain-agnostic single-file section container (file magic + JSON
  header + per-section `zstd`-compressed opaque payload blobs, with partial reads
  and byte-lossless `filter_to` / `merge_to`). `write` / `open` / `Reader` /
  `Section` / `Entry` / `filter_to` / `merge_to`, namespaced under `container`
  (not re-exported at the crate root). Lifted verbatim from petekio's `.pproj`
  framing — the **on-disk format is unchanged** (magic `PIO\x01`); petekio now
  depends on it and keeps its GeoData element DTOs on top. Adds the `serde`,
  `serde_json`, and `zstd` dependencies. Additive and non-breaking.
- `AlgoError`: three additive variants backing `container` — `Io(#[from]
  std::io::Error)`, `Parse(String)`, `NotFound(String)`. Non-breaking (existing
  `EmptyInput` / `InvalidGeometry` unchanged).
- `units`: domain-agnostic oilfield-unit conversion constants and helpers
  (`ACRE_TO_FT2`, `FT3_PER_BBL`; `acres_to_ft2`, `acre_ft_to_ft3`,
  `ft3_to_acre_ft`, `ft3_to_rb`, `rb_to_ft3`, `degf_to_degr`) — moved verbatim
  from petekSim's `srs-units` crate, which keeps its `SrsError`. Pure `f64`
  arithmetic, namespaced under `units` (not re-exported at the crate root);
  additive and non-breaking.

## [0.0.2] - 2026-07-01

First release under the `petektools` name, adding warm-start / convergent
minimum-curvature gridding.

### Changed
- **Renamed the crate `petekalgorithms` → `petektools`** (repository and import
  path likewise). The old `petekalgorithms` crate on crates.io is retired
  (yanked); depend on `petektools` going forward. No API changes came with the
  rename.

### Added
- `gridding`: `grid_min_curvature_seeded(coords, lattice, seed)` — warm-start
  minimum-curvature gridding that relaxes the SOR from a lattice-shaped prior
  field instead of the cold IDW seed (`None`/wrong-shape → cold behaviour;
  non-breaking superset of `grid(.., MinimumCurvature)`). Held at parity with
  petekio's seeded `grid_min_curvature`.
- `gridding`: `ConvergentGridder` — a stateful minimum-curvature gridder for
  interactive re-gridding. `new` cold-solves; `add_control(ip, jp, z)` /
  `add_controls(&[(ip, jp, z)])` hold node controls as hard constraints and warm
  re-solve from the held field; `field()` returns the current field. Continuity
  (`warm == cold` to solver tolerance) and determinism are tested.

## [0.0.1] - 2026-06-29

First public release. GATE-0: the locked public contract (`Lattice`,
`GridMethod`, `grid`) backed by the three ported gridding kernels.

### Changed
- `gridding`: ported the kernels from `transfer/` (petekio 0.2.0 prior art) into
  real implementations behind the locked `grid()` dispatcher, swapping
  `GridGeometry` → `Lattice` 1:1 and keeping the algorithms/defaults/tolerances.
  - `nearest`: `rstar` R*-tree, one nearest-neighbour query per node. Added the
    `rstar = "0.13"` dependency.
  - `idw`: global inverse-distance weighting (p = 2), exact at coincident
    samples.
  - `min_curvature`: Briggs biharmonic SOR relaxation (ω = 1.5, TOL = 1e-6,
    MAX_ITERS = 5000) — IDW seed, snap-and-fix sample anchors, 13-point
    biharmonic interior with a 5-point harmonic edge fallback. Reproduces a
    linear trend exactly.

### Added
- GATE-0 scaffold: crate skeleton + locked public contract.
  - `foundation`: `AlgoError`/`Result`, `BBox`, and the rotatable `Lattice`
    (IRAP/RMS model) with `node_xy` / `xy_to_ij` / `bbox` — held at field- and
    behaviour-parity with petekio's `GridGeometry`.
  - `gridding`: `GridMethod` + the `grid()` dispatcher (locked), backed by the
    three ported kernels above.
- `tests/lattice_parity.rs`: golden test pinning `Lattice` ⇄ petekio
  `GridGeometry` (`node_xy` / `xy_to_ij`) across rotated and y-flipped cases.
- `inbox/` and `dev-docs/` working systems.

### Removed
- `transfer/`: the porting knowledge base (provenance copies of petekio's
  kernels + geometry) is retired now that the kernels are ported and parity is
  pinned by a golden test.
