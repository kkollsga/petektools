# petekTools guide

**Scattered-data gridding & geostatistics kernels for Rust** — the numerics
layer the ecosystem was missing, plus a small curated front-door over mature
numeric crates and a domain-agnostic bundle viewer.

## What it is (the gap it fills)

Rust already has excellent crates for linear algebra (`faer`), statistics and
distributions (`statrs`, `rand_distr`), FFT (`rustfft`), and spatial indexing
(`kiddo`, `rstar`). What it has lacked is a production-grade way to turn
**scattered `(x, y, z)` observations into a regular grid** — minimum-curvature
surfaces, inverse-distance weighting, nearest-neighbour fills. petekTools fills
exactly that gap, and curates the rest behind one small door.

If you have points and need a surface — a depth grid from well picks, a property
map from samples, any scattered field on a regular lattice — this is the crate.
It is a **pure leaf**: it depends only on general-purpose numeric crates, never on
a domain model, and stays usable standalone (and, via a thin PyO3 wheel, from
Python).

Design principles that shape the whole surface:

- **One job.** Scattered-data gridding / geostatistics — the gap. Everything else
  (linear algebra, stats, neighbour search) is *curated* from mature crates,
  never reimplemented.
- **Type-agnostic kernels.** A kernel speaks a plain [`Lattice`] + `[[f64; 3]]`
  rows and returns `ndarray::Array2<f64>` — never a caller's domain type. Adoption
  is a conversion at the call site, not a rewrite.
- **Numerical honesty.** Deterministic, documented to a stated tolerance, with
  analytic cases asserted as tests (a linear trend is the exact minimum-curvature
  solution; IDW is exact at coincident samples). No silent clamping, no magic
  defaults — locked constants (e.g. IDW `p = 2`) are named and cited.

## Gridding methods

The `grid(points, lattice, method)` dispatcher takes `[x, y, z]` rows and a
target lattice and returns an `ncol × nrow` `Array2<f64>` (undefined nodes are
`NaN`). Pick the method with the `GridMethod` enum:

| `GridMethod`        | What it does                                                             |
| ------------------- | ------------------------------------------------------------------------ |
| `Nearest`           | Each node takes its areally-closest sample's `z` (blocky, exact at data). |
| `InverseDistance`   | Global IDW with `p = 2`; exact at coincident samples.                    |
| `MinimumCurvature`  | Briggs biharmonic SOR — smooth, honours the samples.                     |

```rust
use petektools::{grid, GridMethod, Lattice};

// A 100×80 grid, 25 m spacing, origin at (1000, 2000).
let lattice = Lattice::regular(1000.0, 2000.0, 25.0, 25.0, 100, 80);
let points  = [[1010.0, 2008.0, 12.5], [1240.0, 2300.0, 18.1], [1880.0, 3100.0, 9.4]];
let surface = grid(&points, &lattice, GridMethod::MinimumCurvature).unwrap();
```

## Warm-start & `ConvergentGridder`

Editing a surface point-by-point? Re-solving minimum curvature from scratch on
every nudge is wasteful. Seed the solver from the prior field and it converges in
a fraction of the iterations to the **same** field — measured **~4–7× faster** on
a typical structural edit, rising to **~250×** in the near-converged incremental
limit. A `None` or wrong-shape seed simply falls back to a cold solve.

```rust
use petektools::{grid, grid_min_curvature_seeded, GridMethod, Lattice};

let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 64, 64);
let points  = [[1.0, 1.0, 10.0], [60.0, 60.0, 40.0]];
let cold = grid(&points, &lattice, GridMethod::MinimumCurvature).unwrap();
// After nudging the data: relax from the prior field instead of cold-starting.
let warm = grid_min_curvature_seeded(&points, &lattice, Some(&cold)).unwrap();
```

For interactive, one-control-at-a-time refinement the stateful `ConvergentGridder`
keeps the field between edits so each new control is cheap:

```rust
use petektools::{ConvergentGridder, Lattice};

let lattice = Lattice::regular(0.0, 0.0, 1.0, 1.0, 64, 64);
let points  = [[1.0, 1.0, 10.0], [60.0, 60.0, 40.0]];
let mut gridder = ConvergentGridder::new(&points, &lattice).unwrap();
let field = gridder.add_control(32, 40, 25.0); // pin a node, re-solve incrementally
```

## Geometry: `Lattice`

A regular, **rotatable** areal lattice (the IRAP/RMS model): origin, spacing,
node counts, CCW rotation, and an optional y-flip. It carries the forward map
`node_xy(i, j)`, its inverse `xy_to_ij(x, y)`, and a `bbox()` — everything a
kernel needs to place a sample on the grid. Kernels never take a caller's grid
type; they take a `Lattice`, so any regular areal grid maps on field-for-field.

## 1-D interpolation

`interp1d` is the shared resampling kernel for curve-like data such as well
logs. The Rust surface accepts finite, strictly increasing `x` knots, matching
`y` values, query positions, an `Interp1dMethod`, and an `extrapolate` flag. The
Python wheel exposes the same kernel as:

```python
import petektools as pt

values = pt.interp1d(
    [1000.0, 1001.0, 1003.0],
    [0.22, 0.25, 0.21],
    [1000.5, 1002.0],
    method="cubic",
)
```

Methods are `nearest`/`closest`, `previous`/`ffill`, `next`/`bfill`, `linear`,
and `cubic`/`spline`. The cubic method is a natural cubic spline (`S'' = 0` at
both endpoints), implemented in Rust from the standard derivation. It is not
SciPy's default not-a-knot spline.

## Geostatistics

Beyond deterministic gridding, petekTools ships a geostatistics front-door: an
omnidirectional **experimental variogram**, a fitted **`Variogram`** model
(`Nugget` / `Spherical` / `Exponential` / `Gaussian`), moving-neighbourhood
**ordinary kriging** (estimate + variance), and **sequential Gaussian
simulation** for conditioned stochastic realizations. Kriging and SGS both solve
small dense neighbourhoods (up to `max_neighbours` samples within a `radius`) and
run with the GIL released from Python. See the `01_geostat_tour` notebook for the
full experimental-variogram → fit → krige → simulate walk-through.

## The curated front-doors: units, stats, sampling

These modules are deliberately *thin* — they curate a mature crate behind a small,
named surface rather than reinvent it.

- **`units`** — a domain-agnostic SI/metric reporting layer: `km2 ↔ m2`,
  `m3 ↔ mcm / msm3 / bcm`, `scf ↔ Sm³`, `stb ↔ Sm³`, and `format_volume` for
  human-readable output. (`Sm³` is a scale label, not PVT.)
- **`stats`** — descriptive statistics with an Excel-parity `percentile`
  (type-7): `mean` / `variance` / `std` / `median` / `percentile`, plus the full
  weighted family (`weighted_mean`, `weighted_percentile`, …). Realization-set
  helpers `reservoir_summary` (the P90 = low exceedance digest, `p90 ≤ p50 ≤ p10`)
  and `aggregate` (per-segment sum under a correlation assumption) sit here too.
- **`sampling`** — validated distribution samplers (`uniform` / `normal` /
  `lognormal` / `triangular` / `truncated_normal`) drawn through a seeded `Rng`
  for bit-for-bit reproducibility, plus a `.clamped(lo, hi)` hard-limiter
  combinator. Same seed + params reproduces the identical stream every time.

## Synthetic generators

A family of **seeded, believable synthetic-data** generators — for tests,
demos, tutorials, and benchmarking without any real dataset. All are
bit-reproducible from their seed, and fractions live in `[0, 1]`.

- **Surfaces & maps** — `synth_dome_surface` (an elliptical four-way closure with
  tilt and correlated noise), `synth_isochore` (a thickness map), `synth_trend_map`
  (a `[0, 1]` depositional trend, optionally correlated with another field).
- **Wells & outlines** — `place_wells` / `place_wells_in_polygon` (seeded well
  heads), `closure_outline` (the largest closed contour of a surface at a spill
  level), `study_area_outline` (a rounded-rectangle extent), `tops_from_surface`
  (pick a top per well with a residual draw).
- **Trajectories** — `synth_trajectory` (vertical) and `synth_trajectory_profile`
  (`build_hold` / `build_hold_drop` directional wells by the minimum-curvature
  relation), with `max_dogleg_severity` as a believability yardstick.
- **Petrophysics** — `synth_facies_series` (binary sand/shale), `synth_log_series`
  (a zoned, depth-autocorrelated log over a `ZoneSpec` stack), and
  `synth_por_with_facies` (porosity coupled onto a facies series).
- **`Georef`** — a fictional world-frame origin that builds a world-placed
  `Lattice` and translates locally-built points into the same frame.

The `02_synthetic_data_tour` notebook builds a whole synthetic asset — structure,
outline, wells, trajectories, and coupled petrophysical curves — from these.

## The viewer unit (brief)

petekTools also ships the **viewer** — a packaged, domain-agnostic inspection
viewer (`petektools.viewer`, wheel-only; excluded from the crates.io Rust crate so
the kernel stays lean). Any library that maps its data onto the
[generic render schema](../python/petektools/viewer/SCHEMA.md) can drive it:
build a typed JSON payload of map raster layers, section columns, and/or a
corner-point mesh, then `serve()` it (a live local server) or `save_view()` it
(one self-contained HTML file, all JS + data inlined, zero external network
fetches). It is **strictly bundle-driven** — it renders exactly what the payload
declares and computes nothing itself; new cross-sections come from a consumer's
`section_provider` callback (live) or are pre-computed into the payload (file).
The viewer is horizontal capability: it serves every layer of the ecosystem, so
it lives here. The full guide is in `VIEWER.md`.

For lightweight map QC, `petektools.view2d([...])` accepts point-like objects,
geometry-like objects, and triangulated meshes. Stable `kind` metadata separates
point sets (`point_set`), geometry-only shells (`grid_geometry`,
`structured_shell`, `mesh_shell`), and value surfaces (`surface`,
`structured_mesh`, `tri_surface`). Point sets render as points only.
Geometry-like objects render grid lines, and when they expose an `edge`
polygon the grid-line overlay is clipped to that edge so inferred grids,
structured surfaces, and point clouds line up in the same view. Mesh-like
objects (`triangles()` over `xyz()`/`points()` vertices) render their unique
triangle edges as grid lines with the mesh `edge` rings as the outline; a mesh
that also offers `wireframe_edges()` index pairs draws exactly those instead —
quad-dominant, with interior cell diagonals removed.

Three kwargs add value rendering. `color=` colours **points**
by their z value (and selects the colormap for whatever is value-coloured) —
it never triggers fills, and it defaults ON (pass `color=False` for
monochrome points). When `fill` is omitted, only a value-surface role offering
callable `attr_names()` and `value_layer()` contributes its primary layer
followed by every named attribute to the Fill selector; geometry shells remain
wireframes. Explicit `fill=False` disables fills, `fill=True` requests primary
only, and `fill="name"` requests that one attribute from any producer offering
`value_layer()`. Each per-node value layer paints as a value-coloured
fill *under* the grid lines (each triangle flat-filled with the colormap
colour of its mean node value; a triangle touching a NaN node is left
unfilled). `contours=25.0` asks each item offering `iso_lines()` for contour
polylines at a 25-unit interval (`iso_lines(interval=25.0)`), while
`contours=[1500, 1550]` requests exact levels (`iso_lines(levels=...)`).

`color=` and `fill=` accept `True` or a string spec parsed by registry match:
`"[<attr>_]<cmap>[_<min>_<max>]"` with `<cmap>` one of `viridis` / `magma` /
`grays` / `inferno` — so `color="inferno"` picks the colormap,
`color="inferno_-2700_-2500"` adds an explicit clamp range (out-of-range
values clamp to the ramp ends), `color="porosity"` stays an attribute name
(forwarded as `attr=` to `iso_lines`; `fill="porosity"` asks
`value_layer(attr="porosity")`), and `"porosity_inferno_0_0.3"` combines all
three. A malformed spec (e.g. one trailing float) raises `ValueError`. The
viewer panel gets a fill selector (when several items contribute fills),
"Fill"/"Contours" toggles, and a per-layer legend — type icon + the item's
duck-typed `name` and active lane (e.g. `"Top Dome · thickness"`) + the colour
ramp and clamped range on value-coloured layers. Items without these methods are
silently unaffected:

```python
petektools.view2d([surface, well_points], color="inferno_-2700_-2500",
                  fill=True, contours=25.0)
```

Colour can also be set **per object** (view2d and view3d): pass a dict item
`{"object": obj, "color": ..., "fill": ..., "name": ...}` anywhere a bare
object is accepted. Per-object settings win over the call-level
`color=`/`fill=` (including omitted-fill attribute discovery for a dict item
without its own `fill`), `name` overrides the legend display name, and each
layer then carries — and the legend shows — its own colormap ramp and clamp
range:

```python
petektools.view2d([
    {"object": top_points, "color": "inferno_-2700_-2500"},
    {"object": base_points, "color": "viridis", "name": "Base Dome"},
    grid_geometry,
])
```

Two more `view2d` kwargs tune the wire and the feel, not the picture.
`encoding="blocks"` (the default) ships the map's bulk arrays as compact
typed binary blocks — roughly 3× smaller than JSON floats on a large payload,
decoded off the main thread. Automatic attributes share their mesh, and only
the active attribute's values decode initially; selecting another attribute
decodes it once. The complete table is still inside a saved HTML view, so this
works offline. Pass `encoding="json"` for a plain-JSON payload
(small payloads are unaffected either way). `lod=True` (the default) adds a
coarse display-only ring beside each fill / mesh grid / contour set from
producers that support striding; the viewer switches to it when zoomed far
out (a small "LOD" chip shows while coarse is on) and back to full resolution
as you zoom in — **the data itself is never decimated**. `lod=(stride,)` /
`lod=(stride, simplify)` tune it; `lod=False` turns it off. See the schema
doc's MapBundle notes for the exact payload shapes.

Wheel and drag frames are composition-only: the viewer affine-transforms the
last valid point/fill and structural/contact-overlay bitmaps at most once per animation frame, even after the
view leaves their original bake margin or zoom band. One trailing settle then
selects the LOD ring and rebuilds invalid bitmaps. A bounded four-entry fill LRU
keeps two selectable fields at both full and coarse LOD, so switching
A→B→A normally returns to A without re-triangulating it.

`petektools.view3d([...])` renders the same items in **one Three.js scene**
(the viewer's "3D" tab) at full view2d parity: the same duck-typed item
handling plus wells (`trajectory()` of `[x, y, z]` rows, z elevation —
negative down), the same `color=` / `fill=` / `contours=` semantics and spec
grammar, and the same per-layer legend. Points render as a colour-coded 3-D
cloud (compact binary blocks, smooth at the 200k default cap). **Solid
surface layers are for value surfaces only**: `surface`, `structured_mesh`,
and `tri_surface` roles passed bare render neutral elevation meshes
(value-coloured under `fill=`); every geometry-only item passed bare —
a bare trimesh, a grid-geometry lattice, a `.geometry`-bearing value item —
renders as a flat wireframe grid at the shallowest point of its own nodes
(z is elevation, negative down; a z-less geometry uses the scene's
shallowest point), edge rings at the same level. Contours draw at their
level. A `z_exaggeration=` kwarg seeds
the tab's z-exaggeration slider (display-only, default 5x — the volume tab's
control). Inspection on both the Map and 3D tabs is **click-driven**: hover
shows nothing; a still click on/near an object anchors a readout (dataset
name, x, y, z/value) at the clicked location until the next click — and in
the 3-D scene the click also re-targets the orbit rotation pivot to the
picked point (camera position unchanged), so orbiting rotates around what
you clicked:

```python
petektools.view3d([pts, geom], color="inferno_-2700_-2500")
```

## Where to go next

- **`API.md`** — the locked public contract (the *what*).
- **`SPEC.md`** — the design constitution (the *why* and *how*).
- **`examples/notebooks/01_geostat_tour.ipynb`** — variogram → kriging → SGS.
- **`examples/notebooks/02_synthetic_data_tour.ipynb`** — a full synthetic asset.
- **`VIEWER.md`** — the viewer unit in full.
