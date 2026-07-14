# Changelog

All notable changes to petekTools are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/); this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Oriented lattice and Map transforms.** Rust and Python `Lattice` now expose
  finite normalized intrinsic rotation/y-flip, exact step vectors and forward /
  inverse intrinsic-world transforms; `Georef` can construct/place the same
  frame, and grid resampling maps arbitrary oriented source and target lattices
  through world coordinates. The Map camera is independently rotatable with a
  north-up reset/HUD, centre-preserving control, exact inverse inspection, and
  full Frame+camera cache identities.
- **Viewer workspace schema v2 runtime.** Provider catalogs now normalize project
  identity and metadata-rich attributes per item/view; shared Map resources use
  selector-free live/cache/retry identity, one envelope-level block table, and
  local geometry/paint selectors across the same affine surface grid. Static
  visible/selected exports embed one full-tier shared envelope with separate UI
  snapshot state, while transitional selector-backed v2, legacy workspace v1,
  singular well picks, and separate scene3d resources remain isolated
  compatibility lanes. Malformed descriptors, echoes, blocks, ranges,
  categorical values, and all-hit overlays fail locally and remain retryable.
- **Inspector-owned Map and Intersection legends.** Continuous ramps, units, and
  exact editable ranges now live beside their layer visibility; categorical
  fills use class keys instead of false gradients. The rendered picker exposes
  all eight canonical colormaps plus an independent reverse modifier, with
  per-layer paint pins and renderer cache identities kept in sync. Entity keys
  cap at six rows, duplicate plot legends and the invalid generic Grid
  statistics block are removed, while Volume and Charts retain legacy legends.
- **Refined project-tree design.** The viewer now uses a complete SVG role-icon
  registry, true hierarchy rails and elbows, fixed 28 px row geometry, explicit
  multi-bore disclosure, and a canonical-ID-preserving single-bore collapse.
  CSS-driven selected/loading/error/unavailable states, a wider attribute lane,
  independent paint metadata, per-row isolate actions, and a per-view visibility
  footer keep dense projects readable without changing lazy expansion or fetch
  semantics. Workspace project titles also receive the subdued `.pproj` suffix.
- **Viewer workspace schema v2 contract.** The frozen additive contract preserves
  `{id,label,kind,units,codes}` attribute metadata, separates geometry
  `attribute` from paint `color_by`, adds optional rotated/georeferenced Frame
  metadata, all-hit well overlays, `colormap_reversed`, and project identity.
  One shared Map resource/block table feeds both 2-D/3-D modes and every
  attribute without Cartesian static-export growth. Workspace v1, legacy
  `lane`, singular `intersection`, and separate `scene3d` payloads remain
  explicit compatibility paths.

### Fixed
- **Rotated Map frame parity.** ScalarLayer, shared affine fills, contacts,
  linework, points, wells, contextual overlays, clipping, fit, and hit testing
  now use one frame→world→camera composition. Compact affine fills paint the
  exact `ncol×nrow` node samples over the same half-cell footprint as direct
  rasters—no four-node averaging or categorical synthesis. Executable 0°/30°
  fixtures cover flipped J, several camera rotations, edge fit, cursor indices,
  overlay co-location, north orientation, and cache invalidation.
- **Inspector state and asynchronous paint alignment.** Scalar paint omission
  now remains inheritance rather than a false pin; point segments retain their
  own range, paint, and visibility; aggregate section keys mirror aggregate
  renderer state; and categorical availability uses the renderer's exact data
  predicate. Blank exact-range endpoints are rejected, undeclared section units
  stay absent, and request-keyed Volume/3-D completions cannot attach stale
  colours under a newer material or cache identity. Point-segment visibility now
  governs drawing, fit extents, and picking through one slice plan, and discarded
  recolours clear their pending identity before a later request is considered.
- **Truthful workspace visibility controls.** Project rows, groups, isolate
  actions, and the visibility footer are interactive only in Map, 3-D, and Wells,
  the views with complete composition paths. Intersection, Volume, and Charts
  retain their catalog labels without controls that could change state but not
  the rendered view.
- **Project-tree interaction completeness.** Formal tree semantics now include a
  roving focus target, Arrow/Home/End navigation, disclosure traversal, and
  Enter/Space activation across both ordinary and virtualized catalogs. Focus
  and scroll position survive disclosure rebuilds. Isolate and bulk-clear
  actions appear only for views with complete composition paths, while `.pproj`
  styling is limited to the persisted project title and never an application
  title override.
- **Workspace tree virtualization.** Project rows now share one 28 px CSS/JS
  geometry token, and the virtual window derives its row count from the rendered
  tree height instead of fixed 25 px/13-row assumptions. Large catalogs reach
  their final row without spacer drift or blank tails across viewport heights.

## [0.2.14] - 2026-07-14

### Added
- **Contextual Map well overlays.** Workspace Map resources may carry
  producer-declared trajectories keyed by stable surface/fill and base-well
  item identities. Surface switches select draw/fit paths atomically without
  moving the camera; attribute fills retain their surface context, base
  wellhead/style/visibility remain unchanged, and legacy or malformed records
  fall back locally without any new provider request or depth/MD computation.
- **Progressive compact 3-D surfaces.** Workspace scene resources may advertise
  preview/full detail tiers. Preview becomes usable first; full affine-surface
  elevation/mask/value blocks build transferable render buffers in the shared
  worker and swap without camera movement or a global Loading reset. Static
  exports embed full detail directly, while no-tier and legacy Mesh3D resources
  remain unchanged.
- **Compact affine Map grids.** Exact structured surface layers now travel as
  dimensions, origin, affine I/J step vectors, and typed row-major values/mask,
  with no expanded mesh nodes or triangles. Direct Canvas rasterization and
  inverse-affine click inspection preserve rotated grids, flipped J axes, and
  NaN holes; legacy ScalarLayer/TriFill JSON and block payloads remain valid.
- **Parallel workspace materialization.** Lazy workspace resources now use
  per-item/view/lane single-flight caching: duplicate concurrent requests share
  one producer call while distinct resources materialize in parallel. Failures
  remain isolated and retryable, and refresh cannot publish stale in-flight
  results into the new snapshot.
- **Workspace application shell.** Workspace payloads now render as a deliberate
  three-region application: a persistent, resizable Project navigator on the
  left, the active viewport in the centre, and a collapsible contextual
  Inspector on the right. Tabs are derived from real payload/catalog
  capabilities; the app bar and status bar expose live/offline, loading, empty,
  ready, and resource-failure states. Pointer and keyboard controls include
  panel toggles/resizers, `/` search, `1`–`3` view switching, `F` fit, and a
  focus-trapped `?` shortcut reference. Bounded browser preferences retain only
  theme/layout/selected-tab UI state—never project data. Narrow notebook widths
  use overlay panels. Non-workspace payload chrome remains unchanged.
- **Lazy multi-view project workspaces.** New top-level `petektools.view()` and
  `petektools.viewer.view()` entry points return an inspectable
  `WorkspaceSession` over either an ordered nested Python tree or the generic
  `view_catalog()` / `view_resource()` provider duck. Workspace manifest v1
  carries stable item IDs, independent per-view visibility, deferred resource
  links, and additive Map/3-D item bindings. Live resources materialize once on
  first request; `.save(..., include="visible"|"selected")` freezes the same
  resources into the existing self-contained HTML contract. Its virtualized,
  searchable project tree has tri-state groups and independent Map/3-D/Wells
  visibility; composed surface resources preserve their attribute selector and
  lazy content-addressed decoding. Existing single-view payloads and `view2d` /
  `view3d` / `serve` / `save_view` are unchanged.
- **Provider workspace lanes and disabled assets.** Workspace-v1 provider
  catalogs can retain ordered unavailable leaves with a visible reason and
  JSON diagnostic metadata, and can declare ordered `{id, label}` lanes with an
  active lane per view. The project tree switches lanes lazily, caches each
  item/view/lane once, and keeps Map/3-D/Wells lane state independent. Visible
  static exports freeze active lanes only; selected exports freeze every lane
  for zero-network switching. Old unlaned manifests remain unchanged.
- **Correlation view templates.** Public frozen `CorrelationTemplate` and
  `CorrelationTrack` values provide chainable curve/flag overlays, ordered and
  grouped weighted tracks, linear/log/reversed scales, styles/fills, layout,
  tops/connectors/zones, and a default TVD/flatten hang. They round-trip through
  versioned JSON, validate curve references when applied to a `WellLogBundle`,
  leave a missing per-well curve blank, and reject curves absent from every
  well. The additive `wells_logs.template` renderer draws actual same-horizon
  connectors between adjacent visible/reordered wells and exposes stable layout
  instrumentation; no-template payloads retain the existing layout exactly.
- **First-class polished wells in `view2d` and `view3d`.** Both adapters accept
  `wells=` as a bare well, project-wells collection, or explicit dictionary,
  with `well_labels=False|True|"auto"`. Shared frozen `WellStyle` /
  `WellPathStyle` / `WellMarkerStyle` / `WellLabelStyle` values round-trip
  through JSON dictionaries. The map draws projected XY trajectories, polished
  co-located wellheads, and bounded collision-led labels; 3-D draws the same
  styled trajectories and updates crisp screen-space labels only on render,
  orbit, or resize. Existing item-detected 3-D wells and payloads with omitted
  well arguments retain their exact wire shape and click-only inspection.

### Fixed
- **Viewer application correctness and interaction state.** Map fit now derives
  from visible drawable content (no synthetic extent outlines), never zooms
  closer than a 10 km horizontal span, and survives deferred decode, LOD, idle,
  and resize paints after the user takes control; `F` is the explicit refit.
  Filled surfaces default their 2-D grid and 3-D lattice off while geometry-only
  views default on, with manual choices retained. Lazy 3-D/Wells views distinguish
  loading, empty, malformed, runtime, WebGL, and build failures. The Project
  navigator uses bounded auto-disclosure, singleton breadcrumbs, hierarchy/type/
  selection states and fetch-free persistent manual expansion. All buttons use
  one accessible hover/focus tooltip channel; Map and 3-D data remain
  click-to-toggle inspection. Late renderer success callbacks are guarded from
  overwriting a newer workspace loading/empty/malformed state. Dense 198²/500²
  gesture gates additionally pin the settled camera, >12 wheel ticks, >1
  viewport pan, and cached A→B→A return.
- **Large multi-attribute surfaces now share and load lazily.** Automatic
  primary/attribute fills retain one normalized full+LOD mesh, pack/hash that
  geometry once, and reference one content-addressed block. The browser decodes
  only the active fill values at startup and lazily caches later selections;
  rapid choices are latest-request-wins and saved HTML remains offline. Plain
  JSON keeps its legacy array shape. A reproduced default-LOD 198²/8-lane build
  drops peak retention from 175.8 MB to 51.1 MB and build time from 3175 to
  1785 ms (71% less peak, 44% faster).
- **Dense map overlays are composition-only during navigation.** Grid/contour/
  outline paint is cached below points and contact paint above them; the outline
  path is precompiled and 1M-cell contact masks travel as additive `u8` blocks.
  Hot-frame overlay rebuild counters remain zero and the dense acceptance
  198² fixture records p95 0.3 ms / max 0.4 ms; the separate 500² acceptance
  records p95 0.5 ms / max 0.6 ms (40 frames each).
- **Surface gesture frames are composition-only.** Wheel/drag now always
  affine-transform the last valid point and active-fill bitmaps, including
  outside their original bake band/margin; no point-path/fill reconstruction,
  canvas backing resize, legend DOM mutation, or live theme-style read occurs
  until one trailing settle. Repaints remain coalesced to at most one per rAF.
  Fill bitmaps use a bounded four-entry LRU keyed by field/ring + ramp/range,
  preserving A/B at full+LOD so A→B→A reuses A without re-triangulation.
- The v3 volume panel now uses declared metadata while its asynchronous mesh
  decode is in flight, avoiding transient triangle-count/depth-range console
  errors before the decoded render fields become available.
- **Surface-role navigation across petekIO's six-level seam.** Viewer dispatch
  now trusts stable `kind` metadata before overlapping method ducks: point sets
  render as points, `grid_geometry` / `structured_shell` / `mesh_shell` render
  as wireframes without omitted auto-fill, and `surface` / `structured_mesh` /
  `tri_surface` auto-enumerate primary + named attributes. Explicit `fill=`
  remains exact for any `value_layer()` producer, `MeshShell.nodes()` is an
  accepted vertex source, and `view3d` uses the same geometry-shell versus
  value-surface distinction.

## [0.2.13] - 2026-07-13

### Added
- **Bare `view2d(surface)` attribute switching.** When `fill` is omitted, an
  object exposing callable `attr_names()` + `value_layer()` now contributes its
  primary value layer followed by every named attribute in producer order; the
  existing Fill picker switches among ordinary `TriFill` entries labelled
  `source · layer`, with shared mesh geometry deduplicated by the existing block
  wire. Explicit behavior remains exact and unchanged: `fill=False` disables
  fills, `fill=True` requests primary only, `fill="name"` requests that one lane,
  per-object dict overrides win, and `color=` never triggers a fill. Producers
  without the two-duck handshake retain their omitted-fill behavior. Malformed,
  empty, or duplicate attribute metadata fails loudly and deterministically.
- **Per-object colour — the dict item form** (owner ruling; `view2d` AND
  `view3d`). A scene item may now be a dict `{"object": obj, "color":
  bool|spec, "fill": bool|spec, "name": str}`: per-object settings take
  precedence over the call-level `color=`/`fill=` (which remain the defaults
  for bare items — back-compat, `color=True` default unchanged) and `name`
  overrides the duck-typed legend display name; the spec grammar is unchanged
  (`_parse_spec`, shared by both builders). Colour/ramp/range now travel PER
  LAYER: a 2-D points layer carries its slice of the shared points array
  (`start`/`n`) plus its own resolved `range` (+ a pinned `colormap` for a
  per-object spec; `colored: false` for an explicit `color=False`), a 3-D
  point cloud carries the same fields, and fills/meshes carry their own
  `colormap` — the renderer and the per-layer legend read these FIRST (each
  legend entry shows its own ramp/range), and the global
  `map.colormap`/`point_color` (+ `scene3d.*`) stay emitted as a fallback for
  older payload consumers. Note: with several bare point items, each layer
  now normalizes over its OWN data range (previously one merged range).

### Changed
- **view3d: geometry renders flat — solid layers are for surfaces only**
  (owner ruling). Only a TRUE regular surface (`kind == "surface"`, the
  petekio `Surface` duck) passed bare renders a SOLID surface layer (the
  neutral elevation mesh; value-coloured under `fill=`). Every other
  geometry-ish item passed bare — a trimesh (e.g. the petekio
  `infer_geometry` TriSurface fallback), a GridGeometry lattice, a
  `.geometry`-bearing value item — now renders as a FLAT WIREFRAME GRID
  placed at the SHALLOWEST point of its own nodes (z is elevation, negative
  down → max finite node z; a z-less geometry falls back to the scene's
  shallowest point), with its edge rings at that same level. `fill=` on a
  value-bearing item still yields the value-coloured mesh (explicit opt-in
  unchanged). Payload: `Lattice3D` gains `z: float | null` (`null` → `ref_z`)
  and `scene3d.outlines` accepts object-form `{points, z}` rings — both
  additive; `view3d`/`view3d_payload` gain `max_mesh_edges` (wireframe edge
  budget, view2d parity). The rendered flat level is exposed for tests as
  `__PETEK_SCENE3D_STATUS.latticeZ`. The 2-D map already renders these items
  flat — no view2d change.
- **Click-to-inspect replaces hover tooltips** on the viewer's Map and 3D tabs
  (owner ruling). Hover shows nothing; a still click on/near an object (2-D:
  the grid-bucket point hit-test, then a raster cell; 3-D: `THREE.Raycaster`
  picking over points/meshes/lines with the pick radius sized to the on-screen
  marker) anchors a readout at the clicked location — dataset/layer name, x,
  y, z/value — that persists until the next click. Clicking empty space, or
  the same target again, dismisses it; a press that moved more than a few px
  between down/up is a pan/orbit drag, never an inspect. Pan/zoom and the
  well-marker click (section along the bore; ties stay in the layer panel) are
  unchanged. In the 3-D scene the click **also re-targets the orbit rotation
  pivot** (`controls.target`) to the picked point without moving the camera —
  orbiting then rotates around the clicked location; an empty-space dismiss
  keeps the last pivot. Exposed for tests as `window.__PETEK_SCENE3D_PICK`.
  The Intersection / Wells / Charts tabs keep their hover readouts.

## [0.2.12] - 2026-07-10

### Changed
- Documentation, examples, and test fixtures now use synthetic dataset names
  throughout.

## [0.2.11] - 2026-07-10

### Added
- `view2d` / `view2d_payload` gain `lod: bool | tuple = True` — an additive
  **stride-ladder LOD** for the map. When on, every item whose producer duck
  accepts the striding kwargs emits ONE coarse display ring beside its full
  ring: `value_layer(stride=…)` → `fills[i].lod`
  (`{stride, nodes, triangles, values, range}` — the range is the
  full-resolution range, so colours stay stable across rings),
  `wireframe_edges(stride=…)` → `map.grid_lines_lod`, and
  `iso_lines(…, simplify=…)` → `contours[i].lines_lod`. `lod=True` uses
  `stride=4` and derives the contour `simplify` tolerance from the data extent
  (`extent / 512`); `lod=(stride,)` / `lod=(stride, simplify)` override;
  `lod=False` is byte-identical to the pre-LOD payload. A producer that does not
  accept the striding kwarg is feature-detected (`TypeError`) and simply
  contributes no coarse ring — **geometry truth is never decimated; the coarse
  ring is display-only**. Every LOD ring is block-encoded like its full ring and
  shares the one `map.blocks` table. The viewer picks the ring on **zoom-settle**
  (a ~150 ms debounce, never per frame) when a full-resolution data cell falls
  below ~4 px on screen — fills, mesh grid lines and contours switch together
  (points keep their baked path), with a small "LOD" chip while coarse is showing.
  See `SCHEMA.md` (MapBundle → **Stride-ladder LOD**).
- Map **fill baking + visibility-driven rendering** (viewer perf). The active
  value-fill now rasterizes once into an offscreen bitmap that pan blits (one
  `drawImage`) and an in-band zoom blits scaled, re-baking only on zoom-settle —
  the same baked-blit path (shared caps/band/margin and the one settle debounce)
  the 200k point cloud uses, so a 78k-triangle fill never re-triangulates per pan
  frame. Rendering stays on-demand and now pauses cleanly when unseen: a hidden
  document cancels the settle timer (`visibilitychange`), and only the active tab
  ever repaints (no background animation loop). A stride-4 coarse LOD fill ring
  is ~16× fewer triangles / ~16× smaller than its full ring
  (`viewer_perf/README.md` §5).
- `view2d` / `view2d_payload` gain `encoding="blocks"|"json"` (default
  `"blocks"`): the 2-D map's bulk arrays (`points`, each fill's
  `nodes`/`triangles`/`values`, `grid_lines`, `contours[i].lines`) now ship as
  **content-addressed typed binary blocks** — the v3 wire format (little-endian
  `f32`/`u32`, base64, canonical NaN) in a per-payload `map.blocks` digest table
  — instead of JSON floats. A synthetic 200k-point + 78k-triangle-fill payload
  is **~3× smaller on the wire** (15.5 → 5.1 MB) and its blocks decode in ~5 ms
  under Node (`viewer_perf/map_decode_bench.js`). Identical arrays (e.g. two
  fills over one mesh) share a **sha-256 digest and ship once**; the viewer
  decodes them off the main thread (the shared decode worker) into typed arrays,
  cached by digest across views, and the renderer's accessors read typed or
  plain arrays transparently. Fully additive and opt-out: a JSON-shaped map (and
  any payload under ~64 KB of floats) renders identically. See `SCHEMA.md`
  (MapBundle → **Binary blocks**).
- `view3d` / `view3d_payload`: a generic 3-D scene entrypoint at **full view2d
  parity** — the same duck-typed items (points, geometries, trimeshes,
  `value_layer()` surfaces, `iso_lines()` contours, outlines) plus wells
  (`trajectory()` of `[x, y, z]` rows, z elevation — negative down), the same
  `color=`/`fill=`/`contours=` semantics and registry-match spec grammar, and
  the same per-layer legend (type icons + duck-typed names + ramp/clamped
  range). Emits an additive `scene3d` payload bundle (viewer `SCHEMA.md`)
  rendered by a new **3D** tab: one Three.js scene with orbit controls and a
  theme-aware background; point clouds travel as compact base64 f32 blocks
  (one draw call, smooth at the 200k cap), surfaces render value-coloured
  (`fill=`) or neutral with a wireframe toggle, lattice/outline/contour lines
  batch as segments, wells draw identity-coloured with wellhead markers. The
  panel carries the volume tab's z-exaggeration control (slider + "fit z ×N",
  display-only), the primitive budget auto-degrades to a decimated preview
  with a loud banner (never a blank), and the build outcome is exposed as
  `window.__PETEK_SCENE3D_STATUS` for the harness.
- `view2d` / `view2d_payload` gain `fill=` (bool | spec string): value-coloured
  trimesh fills are now an explicit opt-in, no longer a `color=` side effect.
- `color=` / `fill=` string specs parse by registry match:
  `"[<attr>_]<cmap>[_<min>_<max>]"` with `<cmap>` in
  `viridis|magma|grays|inferno` and up to two trailing floats (negatives fine,
  e.g. `"inferno_-2700_-2500"`) as an explicit clamp range — values outside it
  clamp to the ramp ends. A non-colormap string stays an attribute name
  (back-compat, e.g. `color="porosity"`); a malformed spec raises `ValueError`.
- The **inferno** colormap (renderer ramp anchors + panel selector), and an
  additive `map.colormap` payload field that pins the initial colormap from
  the parsed spec.
- Per-layer legend entries on the Map tab: a small canvas type icon (points /
  lines / fill / contours / wells) + a display name duck-typed from each
  source object's `name` (additive `map.layers` + fill `display_name`;
  fallback: the layer kind), with the ramp + clamped range on value-coloured
  layers.

### Changed
- **Behaviour change (owner-approved, pre-1.0):** `view2d(..., color=True)` no
  longer fills items offering `value_layer()` — it colours points and selects
  the colormap only. `view2d([pts, geom], color=True)` now shows coloured
  points + geometry lines with no trimesh fill. **Migration:** a call that
  relied on `color=True` (or `color="<spec>"`) to produce a value-coloured
  trimesh fill must now ask for it explicitly — `view2d(items, fill=True)` or
  `fill="<spec>"` (the spec grammar is shared with `color=`).
- `color=` now defaults **on** in `view2d` / `view2d_payload`: points with a
  finite z are depth-coded out of the box; pass `color=False` for monochrome
  points. Fills (`fill=`) and contours (`contours=`) remain explicit opt-ins.
- Map point clouds render at frame rate at 200k+ points (previously ~145 ms per
  repaint, re-run synchronously per wheel/drag event). Points batch into <=256
  colormap-bin `Path2D`s (squares at small radii) baked to a viewport-windowed,
  memory-capped offscreen canvas re-blitted while panning/zooming; a gesture
  frame that leaves the baked window / zoom band draws the batched immediate
  path and re-bakes only when the gesture pauses (trailing timer), so no
  pan/zoom frame pays the bake or its GPU upload;
  wheel/drag repaints coalesce to at most one per animation frame; the hover
  hit-test queries a coarse world-space grid bucket instead of scanning every
  point. Render-path only - no payload schema change.

### Fixed
- A value-bearing item passed **bare** (the petekio regular-`Surface` duck:
  `value_layer()`/`iso_lines()` + a 2-D `.geometry`, no top-level
  geometry/trimesh/points conventions) no longer raises `TypeError` in
  `view2d_payload` / `view3d_payload`. It now renders its STRUCTURE — in 2-D
  the `.geometry` lattice lines (or, geometry-less, the primary value layer's
  triangle edges); in 3-D a neutral elevation mesh from the primary value
  layer (`values`/`range` null → neutral shading + wireframe toggle). Values
  still colour nothing without an explicit `fill=` (owner semantics
  preserved), and the `TypeError` for genuinely unrenderable items now points
  at `fill=`.

## [0.2.10] - 2026-07-10

### Added
- Contour sets carry an additive `major` flag: with `contours=<interval>`,
  index levels at the round step nearest 4–5× the interval (e.g. 25 m → 100 m)
  render as a second, bolder batched stroke — classic index-contour styling.
- With `color=` on, `view2d` also colour-codes plain points by their z value
  through the active colormap (additive `map.point_color` field); non-finite z
  keeps the accent colour, and a points-only coloured view gets the ramp
  legend.
- `view2d(...)` / `view2d_payload(...)` gain `color=` and `contours=` kwargs:
  `color=True` (or `color="<attr>"`) collects each item's duck-typed
  `value_layer()` into a value-coloured trimesh fill drawn under the grid
  lines, and `contours=<interval>` / `contours=[levels]` collects
  `iso_lines()` polylines as contour overlays. The map bundle carries the new
  additive `fills` + `contours` fields (documented in `SCHEMA.md`; both `[]`
  when absent, no schema bump), and the summary reports `fills` /
  `contour_levels` counts.
- The map viewer renders the fills batched into ~64 colormap bins (one canvas
  fill per bin; a triangle touching a NaN node stays unfilled), strokes all
  contour levels as one batched path slightly stronger than the grid lines,
  and grows a fill selector, "Fill"/"Contours" layer toggles, and a
  name + min/max colour-ramp legend for the active fill.
- Trimesh inputs to `view2d(...)` / `view2d_payload(...)` may expose
  `wireframe_edges()` (vertex-index pairs); when present those edges are drawn
  instead of the derived unique triangle edges, so a producer that classifies
  cell diagonals (petekio `TriSurface`) renders Petrel-style quad cells.

## [0.2.9] - 2026-07-10

### Added
- `petektools.view2d(...)` / `view2d_payload(...)` accept triangulated meshes:
  an object offering `triangles()` index triples over `xyz()`/`points()`
  vertices (optionally with an `edge` polygon) now draws its unique triangle
  edges as grid lines and its `edge` rings as the outline, instead of being
  swallowed by the point-cloud fallback with a default rectangular outline.
  A new `max_mesh_edges` budget (default 150 000) strides edges over budget
  and reports `mesh_edge_stride` in the summary.

### Fixed
- The map view strokes all grid lines as one batched canvas path, keeping
  pan/zoom responsive on dense trimesh overlays (~100k+ edges).

## [0.2.8] - 2026-07-10

### Changed
- CI now builds the shared ABI3 wheel once and tests those same wheel bits
  across every supported CPython version, while superseded branch runs are
  cancelled. This removes duplicate compilation without reducing interpreter
  coverage or Rust/Python gates.
- Release artifacts now build alongside the unchanged release gates. PyPI
  publishing retries bounded transient failures safely, and the workflow
  reports trigger-to-installable-registry time.
- Library operations, actionable todos, GitHub Actions control, and publishing
  are now coordinated centrally by petekSuite. This is an operational change;
  the petekTools runtime and public API are unchanged.

## [0.2.7] - 2026-07-08

### Changed
- `petektools.view2d(...)` / `view2d_payload(...)` now render point-like inputs
  as points only. Topology-bearing point sets no longer implicitly draw grid
  lines; pass an explicit geometry or structured surface when the grid should be
  visible.
- Geometry grid-line overlays are clipped to `geometry.edge` when an edge polygon
  is available, so inferred grids and structured surfaces display inside their
  selected modelling outline.

## [0.2.6] - 2026-07-08

### Changed
- `petektools.view2d(...)` / `view2d_payload(...)` now extract grid lines
  directly from point-set `column`/`row` topology when present. This lets the
  2-D QA viewer show Petrel/EarthVision shifted surface grids using the actual
  point XY positions instead of only an affine inferred `GridGeometry`.

## [0.2.5] - 2026-07-08

### Added
- Added shared 1-D interpolation/resampling kernels: Rust `interp1d`,
  `Interp1dMethod`, and `CubicSpline1d`, plus Python
  `petektools.interp1d(...)`. Supported methods are nearest/closest,
  previous/ffill, next/bfill, linear, and natural cubic spline.
- Added `petektools.view2d(...)` and `view2d_payload(...)` for lightweight
  browser-based 2-D QA of point clouds and grid geometries, with viewer schema
  support for `points` and `grid_lines` map overlays.

### Changed
- Documented that the cubic interpolation method is an independently implemented
  natural cubic spline (`S'' = 0` endpoints), not SciPy's default not-a-knot spline.

## [0.2.4] - 2026-07-07

### Changed
- Updated CI and release workflows to current action versions.
- Release publishing now uses the Actions-owned flow: the release workflow
  accepts a release ref and expected version, runs gates, creates or reuses the
  matching `v<version>` tag on the same commit, then publishes crates.io, PyPI,
  and the GitHub Release.
- Aligned the internal Python binding crate's self-dependency floor with the
  workspace release version.

## [0.2.3] - 2026-07-07

### Added — domain-free formula expressions
- Added `formula::{Assignment, FormulaBlock, evaluate_formulas}` for parsing
  assignment strings, separating `$params` from bare property variables,
  topologically ordering intra-block dependencies, and evaluating vectorized
  scalar/property expressions over equal-length arrays. Supported operators:
  `+ - * / **`, comparisons, and `sqrt`/`pow`/`log`/`log10`/`exp`/`min`/`max`/
  `clip`/`abs`/vectorized `if`.
- Exposed Python helpers `petektools.formula_info(...)` and
  `petektools.evaluate_formula(...)`. The module is domain-free and does not
  encode static-model/grid semantics.

## [0.2.2] - 2026-07-06

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
  retire onto it). Source and target may independently carry arbitrary finite
  intrinsic rotation and `yflip`: every target node maps to world XY and through
  the exact inverse source frame before the unchanged interpolation kernel. No
  new georef type is required. **Null / extent policy** (fixed + documented):
  outside the source extent → `NaN` (never extrapolate); `Nearest` snaps to the
  closest node; `Bilinear` returns `NaN` if the *nearest* corner is `NaN`, else the
  weighted mean over the **finite** corners with weights renormalized (a `NaN`
  corner is dropped). Tested: bit-equal identity, bilinear exact on an affine field
  under 2× refinement, nearest snap, null-hole propagation, outside-extent `NaN`,
  offset-origin world coordinates, and analytic rotated source/target fixtures.
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
