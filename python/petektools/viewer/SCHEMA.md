# The generic render schema — the petekTools viewer contract

The viewer unit (`petektools.viewer`) renders **one typed JSON payload**. This is
the contract between it and every consumer: petekStatic `StaticModel` views,
petekIO logs/crossplots, peteksim MC charts — each maps its domain bundle onto
these shapes and hands the result to `serve()` / `save_view()`. The renderer
carries no domain knowledge; it draws exactly what the payload declares (names,
units, value ranges included).

This document **codifies what the JS reads today** — it is extracted from the
renderer, not a redesign. Fields the renderer ignores are not part of the
contract. Additive fields are non-breaking; renaming or removing one is a
breaking change to this contract.

Coordinates are a consumer-chosen world frame (all layers of one payload must
share it). Depths are positive-down. A `range` is `{"min": float, "max": float}`.

**Display names (additive, everywhere).** Any named entity — a `ScalarLayer`, a
`Contact`, a `WellTrack`, a tornado bar, a distribution series — may carry an
optional `display_name: str`. The viewer renders `display_name` when present, and
otherwise beautifies the raw internal `name`: a scoped `"A::B"` name reads as
`"A (B)"`. The **identity key** (the categorical colour slot) always uses the raw
`name`, so adding a `display_name` never re-colours an entity. Consumers set
`display_name` to disambiguate internal names (e.g. a property level shift
`"PORO level shift"` vs a box draw `"porosity (draw)"`).

## Top-level payload

| field | type | rendered as |
|---|---|---|
| `schema_version` | int | metadata (bump on a breaking change; **4** adds the `wells_logs` bundle + section `horizon_traces` + `WellTrack.ties`; **3** the v3 volume — exterior shell + binary blocks; **2** the `charts` bundle) |
| `kind` | str | title prefix (`"<kind> · <property> viewer"`) |
| `property` | str | the active render property (volume colour, title) |
| `properties` | list[str] | metadata (the set of populated properties) |
| `summary` | object \| null | a free-form `key → value` panel (numbers formatted) |
| `map` | MapBundle \| null | the **Map** tab (areal raster) |
| `volume` | VolumeBundle \| null | the **Volume** tab (3-D mesh) |
| `scene3d` | Scene3dBundle \| null | **additive:** the **3D** tab (the `view3d` scene; the tab button only appears when present) |
| `sections` | list[SectionBundle] | the **Intersection** tab (pre-computed sections) |
| `section_labels` | list[str] | one display label per `sections` entry |
| `wells` | list[WellTrack] | map markers + click-to-section targets |
| `wells_logs` | WellLogBundle \| null | the **Wells** tab (multi-well log correlation; v4) |
| `charts` | list[ChartBundle] | the **Charts** tab (analytics marks; see below) |
| `workspace` | WorkspaceManifest \| absent | **additive:** lazy multi-view catalog and item/resource bindings; absent preserves the historic single-payload behavior |

A tab renders only if its bundle is present; an empty payload shows an empty
state. `sections` may be empty (live mode adds them via `/section`).

## WorkspaceManifest — ordered multi-view catalog (v1 compatibility; v2 frozen)

`workspace` is optional. An old payload without it follows the exact historic
single-payload boot/state/render path. Workspace schema **v2 is additive over
v1** and is the authoring target for metadata-rich surface providers:

`{schema_version: 2, title, project?, tree, available_views, initial_tab, mode,
resources?, snapshot?}`.

`title` remains the application-bar title. `project`, when present, is
`{title: str, crs: str|null, unit: str|null}`. Strings must be non-empty after
trimming; absent source values normalize to `null`, never to an invented
CRS/unit. A project-backed producer MUST emit its persisted display name as
`project.title` and SHOULD use it for `title` unless the caller explicitly
overrides the application title. `crs` is free text rendered verbatim; it is
never parsed or guessed as an EPSG identifier. `unit` is the primary project
length/depth unit, not a blanket unit for every attribute. Workspace v1 has no
`project` record. A surface producer copies known project CRS/world unit into
`Frame.crs`/`Frame.units` only when that frame actually uses them.

`tree` is an ordered list of groups and items. A group is
`{id, label, expanded?, children}`. Omitted `expanded` delegates initial
disclosure to the renderer (selected path, else at most two actionable leaves);
an explicit bool is authoritative until the user changes it. An item is `{id,
label, role?, views, visible, resources, disabled?, reason?, diagnostic?}` where
`views` is a list of compatible view names and `visible` is an independent
`view → bool` initial state. IDs are globally unique immutable identity keys.

A normal resource spec is `{href, deferred}`. Workspace v2 surface views use
`{href, deferred, attributes:[AttributeDescriptor,...], active_attribute,
active_color_by, transport:"shared", modes?:["2d","3d"]}`. Every descriptor
appears in both selectors. Both active selectors default to the first descriptor
and must name declared descriptors. Changing `active_attribute` resets
`active_color_by` to the same ID; changing only `active_color_by` is the explicit
decoupling operation. `modes:["2d","3d"]` makes 3-D a camera mode of this Map
resource, not another resource identity.

**AttributeDescriptor (canonical normalized shape):** `{id: str, label: str,
kind: "continuous"|"categorical", units: str|null, codes:
dict[str,CodeRecord]|null}`. `id` and `label` are non-empty strings and IDs are
unique in declaration order. Omitted `kind`, `units`, and `codes` normalize to
`"continuous"`, `null`, and `null`. `units`, when present, is the unit of that
attribute. A producer may fall back to `project.unit` only for its primary/depth
attribute; other missing attribute units stay `null`. `CodeRecord` normalizes to
`{label: str|null, color: str|null}`. Code keys are canonical base-10 integer
strings and colours are `#RRGGBB` hex or `null`. Continuous descriptors MUST
have `codes:null`; categorical descriptors may use `codes:null` when no table is
known. An uncovered categorical value displays its integer as the label and a
stable categorical identity colour; it never falls back to a continuous ramp.

Workspace v1's selector-backed form remains accepted unchanged:
`{href, deferred, lanes:[{id,label},...], active_lane}`. On v1 input each lane
maps to one canonical descriptor with `kind:"continuous"`, `units:null`, and
`codes:null`; `active_lane` maps to both active selectors. The legacy request
and envelope field `lane` likewise means `attribute == color_by == lane`. No
metadata is inferred during this mapping, and v1 serialization remains v1.

Legacy `scene3d` may advertise progressive detail as `tiers:[{id:"preview",
label:"Preview"},{id:"full",label:"Full detail"}]` plus
`active_detail:"preview"`. Live resource identity then includes `detail`; the
envelope echoes it. A v2 shared Map may advertise the same tiers on its one Map
resource. Detail remains the only allowed payload-multiplication axis.

A provider may preserve an unavailable/unknown catalog leaf with `views: []`,
`resources: {}`, `visible: {}`, and `disabled: true`; `reason` is a short user
explanation and `diagnostic` is arbitrary JSON-shaped producer metadata. Such a
leaf remains ordered, searchable, and visible in the tree but can never issue a
resource request. Fields are additive; old item records remain valid.

**Resource and static-export identity.** A v2 `transport:"shared"` Map is keyed
by `(item_id, view="map", detail?)` only. `attribute` and `color_by` are
UI/snapshot state and MUST NOT appear in its URL, provider-call identity,
single-flight key, retry key, or cache key. One fetch returns every declared
attribute block and supports both camera modes. Both `visible` and `selected`
static exports embed exactly one envelope per included shared Map: the declared
`full` tier when tiers exist, otherwise the untiered resource. They differ only
in which item/view resources are included. An item with `N`
attributes therefore emits `N` value blocks, not `N²` selector envelopes. A
selected export MUST NOT enumerate `(attribute,color_by)` pairs.

A shared response is `{schema_version:2, kind:"workspace_resource", item_id,
view:"map", detail?, blocks?, payload}`. `blocks` is the one content-addressed
table for the response; every block marker in `payload` resolves against it. A
shared response MUST NOT repeat those blocks under `payload.map.blocks` or a
sibling `scene3d` bundle. `payload` is otherwise an ordinary typed render
envelope and carries the `SharedSurfaceGrid` below.

Selector-backed compatibility resources retain v1 identity
`(item_id,view,lane,detail?)`, query `lane=<id>`, and v1 response echo. During a
transition a non-shared v2 provider may use explicit query/envelope fields
`attribute=<id>` and `color_by=<id>`; its identity is
`(item_id,view,attribute,color_by,detail?)` and both echoes are required. This
form is live-compatible but MUST NOT be used for multi-attribute selected static
export because it is Cartesian. `lane` and either v2 selector in the same
request/envelope is invalid rather than precedence-ordered.

**Validation and failures.** Duplicate descriptor IDs, an unknown active
selector, an invalid kind/code record, or an unsupported transport invalidates
only that provider item/view, records a diagnostic, and prevents its request;
explicit caller-authored catalog records raise `ValueError` before a server
opens. An unknown live selector returns HTTP 400 without calling the producer.
An envelope whose `item_id`, `view`, requested selectors, or `detail` does not
match its request is rejected, not cached, and remains locally retryable. Bad
blocks, non-integral categorical values, and missing declared attribute data are
resource-local malformed-data errors. Missing optional units/CRS/code labels
are honest display omissions/fallbacks, not errors.

**SharedSurfaceGrid (workspace v2):** `payload.map.surface_grid` is
`{schema_version:1, item_id:str, frame:Frame, positive:"down"|"up",
mask:BlockRef|null, attributes:[SurfaceAttributeData,...], triangle_count:int}`.
Here `BlockRef` is exactly `{"__block__":"<sha-256 digest>"}` into the shared
workspace-resource envelope's `blocks` table, never an inline duplicate.
`positive` declares the sign of every attribute when used as 3-D geometry and
defaults to `"down"`; it is not a CRS transform. `mask` is row-major `u8
[ncol*nrow]`, where zero is a hole; `null` means finite-value validity alone.
`SurfaceAttributeData` is the canonical `AttributeDescriptor` plus
`values:BlockRef`, `range:[min,max]|null`, and optional per-attribute
`colormap`/`colormap_reversed`. Values are row-major `f32 [ncol*nrow]` using
canonical NaN for missing cells. Continuous data has a finite ordered range or
`null` when no finite values exist. Categorical data has `range:null` and finite
values must be integers. Descriptor order and IDs MUST exactly equal the
resource spec; `item_id` MUST equal the envelope item and `triangle_count` is a
non-negative producer estimate after masking (used only for the rendering
budget). The Map renderer consumes XY/value data; the 3-D camera consumes
the selected attribute as geometry and the selected `color_by` values as paint
from these same blocks. There is no duplicate `regular_surface` for this grid.

**Dual-mode runtime semantics.** The native Map 2-D/3-D control changes only
`snapshot.state[item_id].map.mode`; it is not resource identity. A switch MUST
retain item selection/visibility, geometry attribute, colour-by, clamp/range,
colormap/reversal, current extent, independent Map and orbit cameras, and the
current well-intersection cycle. The 3-D descriptor holds exact references to
the decoded `elevations`, paint `values`, and `mask`. It MUST NOT clone or
transfer those sources. Derived position/index/colour and GPU buffers are
allowed and are cached once per `(item,detail,geometry identity,mask identity)`;
paint identity/range/style is a separate key, so paint-only changes reuse
topology and a mask replacement cannot. Shared building yields at bounded
chunks and discards a superseded completion before it enters the cache. A
preview and full tier each have one geometry cache; full completion cannot
create separate 2-D and 3-D copies. Without Three.js/WebGL, requested `mode:"3d"`
is retained while the viewport reports `requested:"3d", rendered:"2d"` and
renders the 2-D fallback. This is a usable fallback, not a resource error.
Legacy separate Map + `scene3d` catalogs and schema-v1 bundles retain their
existing resource, worker, tab, and rendering behavior.

**Item bindings (additive).** Workspace-produced primitives may carry
`item_id`. `MapBundle.items` compactly binds one item to ranges in the existing
shared arrays: `{id, point_range?, grid_line_range?, grid_line_lod_range?,
outline_range?, fill_range?, contour_range?, layer_range?}`, with every range
`[start, count]`. Scene3d point clouds, meshes, lattices, contours, wells and
flat outlines carry `item_id` directly. `LogWell` and section entities may also
carry it. Payloads without bindings retain category-level visibility.

## MapBundle — the areal raster (Map tab)

| field | type | notes |
|---|---|---|
| `frame` | Frame | the georeferenced lattice (below) |
| `outline` | list[Ring] | boundary rings; `Ring` = list of `[x, y]` |
| `grid_lines` | list[Line] | optional 2-D QA overlay; `Line` = list of `[x, y]` |
| `points` | list[Point] | optional 2-D QA overlay; `Point` = `[x, y, z?]` |
| `fills` | list[TriFill \| AffineGridFill] | **additive:** selectable value-coloured fills, drawn UNDER `grid_lines`/`outline`/`points`; omitted-fill `view2d` auto mode emits primary + named attributes as ordinary entries for value-surface roles only. Exact affine structured layers use the compact form below; legacy/non-affine layers retain TriFill |
| `contours` | list[ContourSet] | **additive:** iso-lines; all levels stroke as one batched path, stronger than grid lines |
| `grid_lines_lod` | list[Line] \| absent | **additive (LOD):** the coarse (strided) `grid_lines` ring — present only when a mesh producer supplied one; see **Stride-ladder LOD** |
| `point_color` | PointColor \| null | **additive:** `{by: "z", range: [min, max]}` — the GLOBAL fallback for point colouring (per-layer fields on `layers` win; see below). Present when at least one points layer colours: the user's explicit call-level `color=` clamp range, else the union of the coloured layers' data. Points with a finite third component colour through the colormap (non-finite z falls back to the accent); values outside the range clamp to the ramp ends |
| `colormap` | str \| null | **additive:** the initial colormap for this payload (`viridis`\|`inferno`\|`magma`\|`plasma`\|`cividis`\|`turbo`\|`coolwarm`\|`greys`; legacy `grays` accepted) — the parsed `<cmap>` of a `view2d` `color=`/`fill=` spec (`color`'s wins over `fill`'s; falling back to the first per-object dict-item pin). The panel selector can still change it for layers without a per-layer pin; an unknown/absent name keeps the viridis default |
| `colormap_reversed` | bool \| absent | **additive:** reverses the selected `colormap` lookup without changing its name; defaults to `false`. It is part of paint/bitmap-cache identity. Every per-layer `colormap` pin may carry a sibling `colormap_reversed`; absent also defaults to `false` |
| `surface_grid` | SharedSurfaceGrid \| absent | **workspace v2:** the single attribute/block source used by both Map camera modes; defined above. Legacy fills and `scene3d` resources remain valid |
| `layers` | list[LayerName] | **additive:** per-emitted-layer legend names, in emission order — `{kind: "points"\|"lines"\|"contours", name: str \| null}` with `name` duck-typed from the producer object (e.g. a dataset name like `"Top Dome"`); the legend falls back to the layer kind when `null`. A line layer carries `standalone: bool`: explicit geometry/wireframe is `true`, a value surface's structural fallback is `false`; this initializes grid visibility without interpreting a domain role. Fills self-describe via their own `display_name`. **Per-layer colour (additive, the per-object color ruling):** a points layer additionally carries its slice of the shared `points` array (`start`, `n`) plus its OWN resolved `range` (`[min, max]` — the explicit spec range, else the layer's finite-z data range), an optional pinned `colormap` (a per-object dict-item spec; the panel selector does not override a pin), and `colored: false` for an explicit per-object `color=False`. The renderer and the legend read these per-layer fields FIRST and fall back to the global `point_color`/`colormap`; an older payload without them renders exactly as before through one legacy segment |
| `horizons` | list[ScalarLayer] | selectable depth/field layers |
| `zone_averages` | list[ScalarLayer] | selectable property layers |
| `k_slices` | list[ScalarLayer] | optional per-k property slices |
| `contacts` | list[Contact] | translucent subcrop-mask overlays |
| `well_overlays` | list[WellOverlay] \| absent | **additive workspace context:** producer-declared display trajectories selected by the active fill's stable `item_id`; absent keeps base top-level wells unchanged |
| `blocks` | dict[digest → Block] | **additive:** the content-addressed typed-block table when `points`/fill arrays/`grid_lines`/`contours[i].lines` ship as binary blocks (see **Binary blocks** below); absent for a plain-JSON map |
| `items` | list[ItemBinding] \| absent | **additive workspace binding:** compact item-to-range metadata described above; no geometry duplication |

**Frame:** `{origin_x, origin_y, spacing_x, spacing_y, ncol, nrow,
rotation_deg?, yflip?, crs?, units?}`. The additive fields normalize as
`rotation_deg:0.0`, `yflip:false`, `crs:null`, and `units:null`.
`rotation_deg` is finite degrees counter-clockwise from world +X/east to the
positive I axis; `yflip` reverses the positive J direction. With
`θ = rotation_deg·π/180`, node `(i,j)` is
`origin + i·spacing_x·(cosθ,sinθ) + j·s·spacing_y·(-sinθ,cosθ)`, where
`s = -1` when `yflip` else `+1`. Workspace-v2 authoring uses finite positive
spacing and positive integer dimensions; v1 payloads retain their historical
acceptance rules. `crs` is a non-empty free-text coordinate-system label
rendered verbatim and `units` is the world-XY distance unit. Neither is inferred.
The absent-field defaults reproduce the historic axis-aligned frame exactly.
Intrinsic frame rotation/y-flip is data geometry; user camera rotation is a
separate view transform and never mutates this frame. For camera rotation `φ`,
world `(x,y)` projects before pan/scale as
`(u,v)=(cosφ·x+sinφ·y, sinφ·x-cosφ·y)`. Thus `φ=0` is east-right/north-up and
positive `φ` rotates north clockwise on screen; this orthogonal reflection is
its own exact inverse. The north HUD depends only on `φ`, while labels and HUD
controls remain in screen space. Fit projects all four half-cell footprint
corners, and every geometry cache identity includes normalized `φ` plus the
complete Frame signature.

The 2-D HUD uses that same exact inverse for cursor world coordinates and then
the selected affine/direct layer inverse for optional i/j/value. It shows zoom
relative to the latest fit and a nice-number constant scale bar. `crs`, XY
`units`, and attribute value units render only when non-null; unknown metadata
has no invented suffix. A perspective/3-D view has no constant scale bar. HUD
text and accessible marker controls are screen-space and never participate in
geometry/cache identity.

**ScalarLayer:** `{name: str, units: str, values: float[ncol·nrow], range,
display_name?: str}`. `values` are **row-major** (`values[j·ncol + i]`);
`null`/non-finite cells render transparent. Continuous fields use a
perceptually-uniform colormap. Samples are node-centred: node `(i,j)` occupies
the intrinsic half-cell around that node, and the full raster footprint is
`[-.5,ncol-.5] × [-.5,nrow-.5]` mapped through the Frame.

**TriFill (additive; the `view2d` value-fill output — fills are never a
`color=` side effect):** `{name: str, display_name?: str | null, nodes:
[[x, y], …], triangles: [[a, b, c], …], values: float[len(nodes)], range:
[min, max], colormap?: str, colormap_reversed?: bool}`. `colormap` (additive) is a per-fill ramp pin
from a per-object dict-item `fill=` spec — it wins over the panel selection
for this fill's paint, legend ramp and its coarse LOD ring; absent for
call-level specs (selector-governed). Per-**node** values on a world-coordinate triangulation; each
triangle flat-fills with the continuous-colormap colour of the **mean of its
three node values** against `range`. A triangle with any `null`/non-finite node
value is **skipped** (renders as a hole — never colour-guessed). The renderer
quantizes to ~64 colormap bins and fills one batched path per bin, so triangle
count is unbounded in practice. `range` here is the **two-float `[min, max]`
list** the producer seam emits (an exception to the `{min, max}` object
convention above) — the user's explicit `fill=` clamp range when one was
specified (out-of-range values clamp to the ramp ends). `display_name` is the
duck-typed source-object name (e.g. `"Top Dome"`; `name` stays the attribute
identity, e.g. `"z"`). The selector/legend combines them as `source · layer`,
so equal attribute names across multiple sources remain unambiguous. When
`view2d`'s `fill` argument is omitted, a value-surface role (`kind` is
`surface`, `structured_mesh`, or `tri_surface`) exposing callable
`attr_names()` + `value_layer()` emits its primary `value_layer()` first and
then one TriFill per advertised name in producer order. Point roles
(`point_set`, with `points` accepted as an alias) emit points only; geometry
roles (`grid_geometry`, `structured_shell`, `mesh_shell`) emit wireframes only.
Explicit `fill=False` emits none, `fill=True` emits only primary, and
`fill="name"` emits exactly that lane from any producer offering
`value_layer()`.

**AffineGridFill (additive compact regular-grid alternative):** `{name,
display_name?, range:[min,max], colormap?, colormap_reversed?, regular_grid:{dimensions:[ncol,nrow],
origin:[x,y], step_i:[dx,dy], step_j:[dx,dy], values, mask}}`. `values` and
`mask` are row-major (`j*ncol+i`) typed arrays or block markers: `f32
[ncol*nrow]` with canonical NaN for missing values and `u8 [ncol*nrow]` with
zero marking a hole. The world-coordinate step vectors preserve rotation and a
flipped J axis exactly. This form intentionally has no `nodes` or `triangles`.
The renderer paints exactly `ncol×nrow` node-centred pixels and applies the
affine from intrinsic footprint `[-.5,ncol-.5] × [-.5,nrow-.5]` directly.
Continuous and categorical pixels use the one source node at `j*ncol+i`; they
never average four nodes or synthesize a categorical code. Click inspection
inverts the same affine and rounds to that node. This is deliberately identical
to ScalarLayer geometry, sample colour, fit, and cursor semantics. Only a
producer layer whose nodes exactly cover its affine `node_xy/ncol/nrow`
geometry qualifies. Non-affine and legacy payloads remain ordinary TriFill.

One fill is active at a time (a panel selector when
several are present); a "Fill" toggle controls visibility, and the active fill
drives a legend entry (type icon + display name + ramp + min/max). Both
`fills` and `contours` are `[]` when absent; a payload without them renders
exactly as before (no `schema_version` bump — additive fields are
non-breaking). A fill may additionally carry a coarse **`lod`** ring
(`{stride, nodes, triangles, values, range}` — see **Stride-ladder LOD**).

**Per-layer legend entries (additive).** On the Map tab the legend renders one
entry per **visible** layer: a small canvas **type icon** (dot cluster =
points, lattice = geometry/grid lines, filled ramp swatch = fill/raster,
squiggle = contours, marker-with-leader = wells) + the display name (`layers`
names / fill `display_name` / well ids; fallback: the layer kind), with the
colormap ramp + the clamped `[min, max]` range wherever the layer is
value-coloured (the active fill, `point_color`-coded points, the raster
`ScalarLayer`). Icons draw from the live theme tokens and active colormap, so
a theme flip or colormap change restyles them on the next repaint.

**ContourSet (additive; the `view2d` `contours=` output):** `{level: float,
major: bool, lines: [[[x, y], …], …]}` — the world-coordinate polylines of one
iso level. Minor levels stroke together as **one batched path** in a neutral
text token, slightly darker/stronger than the grid lines; `major` (index)
levels stroke as a second batched path, bolder (≈2.25 px at α 0.85). In
interval mode the payload builder flags majors at the round step nearest 4–5×
the interval (25 → 100, 20 → 100, 10 → 50); explicit level lists carry no
majors. No labels (yet); a "Contours" toggle controls visibility of both. A set
may additionally carry a coarse **`lines_lod`** ring (simplified polylines — see
**Stride-ladder LOD**).

**Stride-ladder LOD (additive; the `view2d` `lod=` output).** A payload may carry
ONE coarse display ring beside each full-resolution field, so the viewer can drop
to it when a data cell shrinks below a few screen pixels — **geometry truth is
never decimated; the coarse ring is display-only additive data**, and colours stay
stable across rings (the coarse fill ring keeps the FULL-resolution `range`). The
coarse rings, all optional and each block-encoded exactly like its full ring:

- `fills[i].lod` — `{stride: int, nodes, triangles, values, range}`, the same
  shape as its `TriFill` (a `value_layer(stride=…)`-decimated mesh; `range` is the
  full-resolution range).
- `map.grid_lines_lod` — a coarse `grid_lines` set (a `wireframe_edges(stride=…)`
  ring), the union across all mesh items that supplied one.
- `contours[i].lines_lod` — a coarse `lines` set (an `iso_lines(…, simplify=…)`
  Douglas–Peucker ring).

`lod=True` (the default) asks producers for a `stride=4` ring and derives the
contour `simplify` tolerance from the data extent (`extent / 512`); `lod=(stride,)`
/ `lod=(stride, simplify)` override; `lod=False` emits no rings (a payload
byte-identical to the pre-LOD shape). A producer that does not accept the striding
kwarg is feature-detected and simply contributes no coarse ring. **Renderer:** the
map picks the ring on **zoom-settle** (a ~150 ms debounce after the last wheel
event, never per frame — no flicker), switching when a full-resolution cell falls
below ~4 px on screen; fills, mesh grid lines and contours all switch together
(points keep their own baked path). A small "LOD" chip shows while the coarse ring
is active. During wheel/drag, point and active-fill bitmaps are strictly
composition-only: every hot frame affine-blits the last valid bitmap even after
leaving its bake margin/zoom band; it never rebuilds point paths, triangulates a
fill, reconstructs grid/contour/outline/contact paths, resizes the canvas backing,
mutates the legend, or reads live theme styles. Structural overlays are one
bitmap below points and contacts one bitmap above, preserving settled order.
One trailing settle selects the ring and rebuilds each invalid bitmap once. Fill
bitmaps live in an explicit four-entry LRU keyed by fill/ring object identity plus
colormap/range — enough for two fields at full+LOD, so A→B→A reuses A while memory
remains bounded.

**Binary blocks (additive; the `view2d` `encoding="blocks"` output — the
default).** The map's bulk arrays optionally travel as **content-addressed typed
binary blocks** — the same wire format the v3 `VolumeBundle` uses (little-endian,
tightly-packed `f32`/`u32`/`u8`, `base64` in `data`, NaN = the canonical `0x7FC00000`)
— instead of JSON floats. A single 78k-triangle fill is ~5–6 MB of JSON parsed on
the main thread; as blocks it is ~3× smaller on the wire and decodes off the main
thread into typed arrays. It is fully additive: a JSON-shaped (blockless) map
renders identically, and a payload whose bulk arrays total under ~64 KB of floats
stays JSON regardless (the block envelope is not worth it).

- `blocks` | dict[digest → Block] — the per-payload block table (present only
  when at least one field is block-encoded). Each **Block** is
  `{dtype: "f32"|"u32"|"u8", shape: [..], data: base64}`, keyed by the **sha-256 hex
  of its raw little-endian bytes**. Identical arrays (e.g. two fills over one
  mesh) hash to one digest and so ship **once**; the client caches decoded blocks
  by digest, deduping across views in a session.
- A field that would be a JSON array becomes a **marker** referencing the table:
  - `{"__block__": "<digest>"}` — a single block. Used for `points`
    (`f32 [n, 3]`, `[x, y, z]`, NaN z allowed), each fill's `nodes`
    (`f32 [n, 2]`), `triangles` (`u32 [n, 3]`), and `values` (`f32 [n]`, JSON
    `null` → NaN).
  - `{"__csr__": {"coords": "<digest>", "offsets": "<digest>"}}` — a
    **CSR-encoded set of variable-length polylines**: `coords` is an
    `f32 [total_points, 2]` block of every point concatenated, `offsets` a
    `u32 [n_lines + 1]` block where line `k` is `coords[offsets[k]:offsets[k+1]]`.
    Used for `grid_lines` and each `contours[i].lines`.
  - `contacts[i].crossing` uses `u8 [ncol*nrow]` (0/1), avoiding a million JSON
    booleans for a 1M-cell mask.
  - `fills[i].regular_grid.values` uses `f32 [ncol*nrow]` and `.mask` uses
    `u8 [ncol*nrow]`; its geometry is the small affine metadata and needs no
    expanded node or triangle blocks.
  - The additive LOD rings encode identically — `fills[i].lod` `nodes`/`triangles`/
    `values` as `__block__`, `grid_lines_lod` and each `contours[i].lines_lod` as
    `__csr__` — all sharing the one `blocks` table (a coarse ring identical to any
    other block ships once).

The viewer's decode kernel (`assets/decode.js`) reads both shapes; the renderer's
accessors index the typed arrays or the plain nested arrays transparently. At
startup it resolves shared geometry/overlays plus fill 0's full+LOD values only.
Inactive value markers resolve on selection and remain cached by digest; rapid
selection is latest-request-wins. The complete table stays embedded in
`save_view`, so this laziness does not require a network.

**Contact:** `{kind: str, depth_m: float, crossing: bool[ncol·nrow] | __block__,
display_name?: str}` — `crossing` marks the columns the contact plane cuts
(row-major). `kind` is a categorical identity (fixed colour slot). The map paints
the crossing region with a translucent identity fill, a diagonal hatch (45°/135°
alternating per contact) and a 2px identity outline.

The map reads **top-level** `wells` (not `map.wells`) for projected XY paths and
wellhead markers. A normalized entry is `{id, display_name, x, y, trajectory,
style, label, ties?}`; `trajectory` is `[[x, y, z | null], …]` and the map uses
only x/y. `label` is the resolved boolean form of
`well_labels=False|True|"auto"`. `style` is
`{spec:"WellStyle", schema_version:1, path, marker, label}`; path carries
`color?/width/opacity/dash`, marker carries
`size/fill?/stroke?/stroke_width/shape`, and label carries
`color?/font_size/halo/leader/max_displacement`. Missing additive style fields
use historical defaults. The raster is
**clipped to the outline polygon** by default (a panel toggle exposes the
unclipped raster for QC). Co-located wells that share a wellhead (sidetracks)
render as **one shared marker with a bore-count badge** and radially-offset,
leader-lined bore labels.

**WellOverlay (additive workspace context):**
`{context_item_id: str, well_item_id: str, trajectory: [[x, y, z | null], …],
intersection: {md: float, xyz: [x, y, z]} | null,
intersections?: [{md: float, xyz: [x, y, z]}, ...],
status: "hit" | "no_hit" | "ambiguous" | "error", message?: str}`.
`context_item_id` matches a fill's stable workspace `item_id`; all attribute
fills from that item therefore share the same context. `well_item_id` matches a
base top-level well `item_id`. The trajectory is authoritative producer display
geometry: petekTools neither clips it nor computes/interprets depth or MD.
`intersections`, when present, is authoritative, contains finite MD/XYZ records,
and is strictly non-decreasing by MD (duplicate MD is allowed for coincident
picks). `hit` has exactly one record; `ambiguous` has at least two; `no_hit` and
`error` have none. The singular `intersection` remains the compatibility
fallback when `intersections` is absent. A v2 producer SHOULD also echo the
greatest-MD record into `intersection` so an old consumer still shows the
chosen anchor; old singular records retain their historical first-hit meaning
and are never reinterpreted as an all-hit list.

Across all currently visible context items for one well, the viewer selects the
record with the greatest finite `md` as the solid marker. It shows other records
as secondary picks and may cycle them without a request. Equal-MD ties resolve
by workspace item order, then record order. Visibility changes are local because
all records are already present. With no visible hit, `no_hit` uses the wellhead
fallback; `error` also records its diagnostic. A `hit` trajectory is expected to
end at its selected intersection; `no_hit` carries the full trajectory.
`ambiguous`/`error` use a supplied non-empty trajectory or fall back to the base
path. Missing overlays and legacy bundles always use the base path. The selected
path participates in Map fit, while head, label and style remain those of the
base well. Malformed identity/status/order records are skipped locally and never
fail the Map renderer.

The candidate cycle order is workspace item order (stable item-ID fallback),
then MD and source record index. The initial candidate is the greatest finite MD
(the first stable item/record wins an equal-MD tie). Pointer click and keyboard
activation share one screen-space control; its position and label follow the
selected pick, and its index persists until the candidate signature changes.
Per-context `ambiguous`/`error` diagnostics are not erased by a hit elsewhere.

**Click-to-inspect (owner ruling 2026-07-11).** Hover opens no popup on the map;
the fixed HUD alone updates cursor state. A still **click** on/near a point (the grid-bucket hit-test) or a raster
cell anchors a readout at the clicked location (dataset/layer name, x, y,
z/value) that persists until the next click; clicking empty space — or the
same target again — dismisses it. A press that moved more than a few px
between down and up is a pan, never an inspect; pan/zoom are unchanged. A
well-marker click keeps its section semantics (never a tooltip).

## SectionBundle — a vertical cross-section (Intersection tab)

| field | type | notes |
|---|---|---|
| `property` | str | the coloured property (fill; `null` → plain fill) |
| `top_name` | str | identity label for the top-horizon trace |
| `base_name` | str | identity label for the base-horizon trace |
| `columns` | list[Column] | ordered by `distance_m` |
| `horizon_traces` | list[HorizonTrace] | **v4:** interior-horizon polylines (see below) |
| `contacts` | list[{kind, depth_m}] | flat depth lines |
| `sugar_cube` | bool? | **v4-additive:** `true` forces the flat-rect cell render (below) |
| `zones` | list[Zone]? | **additive:** zone identities for the **Color by: zone** fill mode (below) |

**Column:** `{distance_m, i, j, x, y, layer_tops: float[nk], layer_bases: float[nk],
values: float[nk], path_z: float | null, zone_ids?: (int | null)[nk]}`. Each layer
`k` is filled from `layer_tops[k]` to `layer_bases[k]`, coloured by `values[k]`
against the volume value range. `path_z` (when non-null) overlays an along-bore
depth trace; all `nk` must match across the bundle's columns. `zone_ids` (additive)
is the per-`k` zone index into the bundle's `zones`, **aligned / NaN-gapped exactly
like `values`** (a `null`/non-finite entry is a gapped cell — recessive fill).

**Color-by-zone (additive).** When the bundle carries `zones` and its columns
carry `zone_ids`, the Intersection tab shows a **Color by: property | zone** select
that swaps each cell's FILL source; the **trapezoid / sugar-cube geometry is
unchanged**. **Zone:** `{name: str, color?: str | null}` — `color` is an optional
consumer-declared hex. A declared hex **wins** over the automatic palette; a zone
without one takes the **fixed categorical identity slot for its `name`** — the same
slot the volume/wells zone legend uses (identity follows the entity across views).
In zone mode the legend swaps to zone chips and hover reads the zone name + the
property value. A payload without `zone_ids` hides the select and stays on the
property colormap (graceful). User-declared hexes are applied as-declared and are
**not** palette-validated (the owner's choice wins; the viewer logs a `console.info`).

**Cell-edge arrays (v4-additive; the sugar-cube ruling).** A column may also
carry `layer_tops_l`, `layer_tops_r`, `layer_bases_l`, `layer_bases_r` (each
`float[nk]`, NaN/`null`-gapped exactly like `layer_tops`): the cell interval at
the column's **left/right fence edges**. When all four are present and the
bundle does **not** declare `sugar_cube: true`, each cell renders as a
**trapezoid** `(d0, top_l)–(d1, top_r)–(d1, bot_r)–(d0, bot_l)` — fill and the
top/base traces follow the zone-edge dip *within* each column (the default).
`sugar_cube: true`, or a payload without the edge arrays, keeps the flat-rect
("sugar cube") render. The **centroid** `layer_tops`/`layer_bases` stay
authoritative for hover; a cell whose edge entries are non-finite falls back to
its centroid rect. The depth frame includes the edge extremes.

The section's depth axis frames the **reservoir envelope** — the `layer_tops` /
`layer_bases` / `contacts` extent plus a margin — not the full surface→TD bore
path (which would squash the reservoir to a sliver). The `path_z` trace is clamped
into that window; an off-scale arrow marks where the true bore exits it.

**HorizonTrace (v4):** `{name: str, depths: float[len(columns)]}`. One polyline per
*interior* framework horizon (every zone-bounding horizon strictly between the
structural top and base — `N − 2` for an `N`-horizon stack; the structural
top/base are drawn from `top_name`/`base_name`, not repeated here). `depths` runs
**parallel to `columns`** (`depths[c]` is that horizon's depth at `columns[c]`);
a non-finite / `null` entry is a **gap** — the line breaks where a column doesn't
reach the horizon. Each trace takes the horizon's categorical identity slot and is
labelled once at its right end (the section idiom). On a long (~16 km) fence the
right-edge labels are decluttered by the slot ledger — a vertical slot plus a
horizontal stagger (leader-lined) and a fade for a heavily-displaced label. A
single-zone model emits an empty `horizon_traces` (backward-compatible).

## VolumeBundle — the exterior-shell mesh (Volume tab)

Two wire generations, version-switched on the bundle's own `schema_version`:

**v3 (current) — exterior shell + binary blocks.** Only faces bordering an
inactive/absent neighbour or the grid boundary are emitted (O(surface), not
O(volume)); shared vertices are deduplicated, and the per-cell arrays are
compacted to the shell cells with a `tri_cell` index per triangle recovering cell
identity. The big arrays travel as raw **little-endian, tightly-packed** binary
blocks (a JSON envelope keeps names/units/ranges human-readable), so the viewer
reads them straight into typed arrays — no JS-array materialization, no V8 string
wall. **petekStatic's `API.md` "Binary-block payload spec" is the authoritative
wire contract; this is the viewer's decode view of it.**

| envelope field | type | notes |
|---|---|---|
| `schema_version` | int | `3` |
| `kind` | str | `"volume"` |
| `property` | str | the coloured property |
| `cell_count` | int | total grid cells `N` |
| `shell_cell_count` | int | compact shell cells `C` (= `cell_values.len`) |
| `vertex_count` | int | deduped shell verts `V` |
| `triangle_count` | int | shell triangles `T` |
| `zone_names` | list[str] | zone identities (toggles + legend) |
| `value_range` | range | colour + threshold domain (over the shell cells) |
| `encoding` | str | `"base64"` (self-contained) or `"sidecar"` (offset/length manifest + a companion `model.bin`) |
| `blocks` | object | the five binary blocks below |

**Blocks** (each `{dtype, shape, <payload>}`; `dtype` ∈ `f32`/`u32`/`u16`; a NaN
f32 is canonical `0x7FC00000`; block order = C-order flatten of `shape`; payload
is `"data": "<base64>"` for `base64`, or `"offset"/"length"` bytes into `model.bin`
for `sidecar`):

| block | dtype | shape | notes |
|---|---|---|---|
| `positions` | f32 | `[V, 3]` | deduped shell verts, grid-LOCAL `[x, y, z]` |
| `indices` | u32 | `[T, 3]` | 3/triangle into the vertex list |
| `tri_cell` | u32 | `[T]` | compact shell-cell index per triangle (→ `cell_values`/`zone_ids`) |
| `cell_values` | f32 | `[C]` | per shell cell — threshold filter + flat colour |
| `zone_ids` | u16 | `[C]` | per shell cell — index into `zone_names` |

The viewer decodes off the UI thread (an inline Web Worker), renders the shell as
a NON-indexed `BufferGeometry` (deduped verts re-expanded per triangle so each
face **flat-shades in its own `tri_cell` colour**, `DoubleSide` material), and
filters the threshold + zone toggles by rebuilding a visible-triangle index
(client-side, exterior only). z-exaggeration is a `mesh.scale.y`. Beyond a
declared **triangle budget** (5M; overridable via `window.PETEK_TRI_BUDGET`) the
viewer **auto-degrades**: the worker decimates the shell to a 1-in-*stride*
preview (bounded render buffer + heap) and a loud banner states what was
decimated and why — it never refuses-to-nothing, crashes, or blanks. A payload
whose inline blocks exceed the hard memory cap (can't even be read) refuses
gracefully and points at sidecar mode. True interior exposure at a cutoff is a **server re-cut** — the
pluggable `/volume` provider (peteksim implements it). The i/j/k clip of the v2
soup is not offered for the shell (`tri_cell` is a compact index with no linear
grid id).

**v2 (legacy fallback) — corner-point soup (JSON arrays).** Rendered unchanged
when the bundle carries `positions`/`indices`/`vertex_values`/`active` as JSON
arrays (`positions` float[N·8·3], `indices` int[N·36] into `cell·8 + corner`,
`vertex_values` float[N·8], `cell_values`/`zone_ids`/`active` length `N`). Cell
ordering `i` fastest then `j` then `k`; the viewer applies threshold / zone /
i-j-k clip over these arrays.

## Scene3dBundle — the generic 3-D scene (3D tab; the `view3d` output)

One Three.js scene with the `view2d` layer set in 3-D. The vertical axis is
**elevation** (family convention: z is negative down — a horizon at 2600 m
depth carries `z == -2600`); the renderer maps it onto three's y-up frame so
depth reads down-screen. Additive: a payload without `scene3d` renders exactly
as before (no `schema_version` bump), and the "3D" tab button stays hidden.
`color=` / `fill=` semantics and the registry-match spec grammar are exactly
view2d's; the same per-layer legend machinery (type icons + duck-typed display
names + ramp/clamped range) drives the 3D tab's legend.

| field | type | rendered as |
|---|---|---|
| `schema_version` | int | `1` |
| `points` | list[PointCloud3D] | one `THREE.Points` per cloud, per-vertex ramp colours |
| `meshes` | list[Mesh3D] | SOLID surface meshes — value-coloured (`fill=`) or neutral + a wireframe toggle. Emitted bare by all value-surface roles (`surface`, `structured_mesh`, `tri_surface`) — see the classification note below |
| `lattices` | list[Lattice3D] | flat lattice grids (`LineSegments`) — geometry grids AND bare-item flat wireframes, each at its own `z` level (`ref_z` fallback) |
| `contours` | list[ContourSet] | the SAME shape as `map.contours`; each polyline renders at `z = level` (major levels stroke stronger) |
| `wells` | list[Well3D] | identity-coloured bore paths + a screen-sized wellhead marker |
| `outlines` | list[Ring \| FlatRing] | edge rings — a plain `Ring` (`[[x, y], …]`) renders flat at `ref_z`; an object-form `FlatRing` `{points: Ring, z: float \| null}` renders at its flat item's level (additive) |
| `layers` | list[LayerName] | per-layer legend entries, emission order — `{kind: "points"\|"lines"\|"contours"\|"wells", name: str \| null}` (duck-typed producer names; fallback: the kind). Line layers carry the same additive `standalone` geometry flag as Map. Value meshes self-describe via `display_name`, like 2-D fills |
| `point_color` | PointColor \| null | as `map.point_color`: the GLOBAL fallback (per-cloud `range`/`colormap`/`colored` fields win) — the explicit call-level `color=` clamp range, else the union of the coloured clouds' data |
| `colormap` | str \| null | the payload-pinned initial colormap (the parsed `color=`/`fill=` `<cmap>`, falling back to the first per-object dict-item pin) |
| `colormap_reversed` | bool \| absent | reverses `colormap`; defaults to `false` and participates in material/cache identity |
| `z_exaggeration` | float | the z-exaggeration slider seed (display-only group scale, `z ×N` badge, true depths in the readout — the volume tab's control; default 5) |
| `ref_z` | float | the flat-element elevation: midpoint of the scene's finite z extent (0 for an all-flat scene). Lattices and outline rings carry no z of their own and render at this plane |

**PointCloud3D:** `{name: str | null, n: int, xyz: Block, range?: [min, max],
colormap?: str, colormap_reversed?: bool, colored?: bool}` — `xyz` is ONE compact v3-style binary block
(`{dtype: "f32", shape: [n, 3], data: "<base64>"}`, little-endian, NaN =
`0x7FC00000`) decoded on the same kernel as the volume blocks / well-log
lanes. A NaN z renders at `ref_z` in the neutral colour (never
colour-guessed). **Per-cloud colour (additive, the per-object color ruling):**
`range` is the cloud's OWN resolved clamp range (explicit spec range, else its
finite-z data range), `colormap` a per-object dict-item ramp pin (the panel
selector does not override it), `colored: false` an explicit per-object
`color=False` (monochrome) — the renderer and legend read these FIRST, then
the global `point_color`/`colormap`. The Python builder decimates each cloud
past `point_limit` (default 200k) by striding, recorded as
`summary.point_stride`.

**Mesh3D:** `{name: str, display_name: str | null, nodes: [[x, y, z | null],
…], triangles: [[a, b, c], …], values: float[len(nodes)] | null, range:
[min, max] | null, colormap?: str, colormap_reversed?: bool}`. `values`+`range` present → per-vertex
colormap colouring (the user's `fill=` clamp range when specified; a `null`
value renders the neutral colour); absent → the neutral material with a panel
wireframe toggle. `colormap` (additive) is a per-mesh ramp pin from a
per-object dict-item `fill=` spec — paint and legend ramp read it first.
A triangle touching a `null`-z node is **skipped** (a hole, never guessed).
`name` is the attribute identity (e.g. `"z"`); `display_name` the duck-typed
source-object name (e.g. `"Top Dome"`).

**CompactRegularSurface3D (additive Mesh3D alternative):** `{name,
display_name?, range, colormap?, colormap_reversed?, regular_surface:{dimensions:[ncol,nrow],
origin:[x,y], step_i:[dx,dy], step_j:[dx,dy], elevations:Block, mask:Block,
values:Block|null, elevation_range:[min,max], triangle_count}}`. Elevations and
optional colour values are row-major `f32`; mask is row-major `u8`. There are no
expanded nodes or triangles. The shared inline worker decodes these blocks and
constructs transferable position/index/colour buffers. `values:null` is the
neutral bare-surface form. Rotation, flipped J, and NaN holes follow the same
affine/mask rules as `AffineGridFill`.

**Bare-item classification — solid layers are for value surfaces only.** All
three value-surface roles (`surface`, `structured_mesh`, `tri_surface`) emit a
SOLID `Mesh3D` bare: their primary value layer becomes a NEUTRAL elevation mesh
(`values`/`range` null — never value-coloured without `fill=`). Geometry-only
roles (`grid_geometry`, `structured_shell`, `mesh_shell`; the last accepts
vertices from `nodes()` as well as `xyz()`/`points()`) emit a FLAT `Lattice3D`
wireframe placed at the SHALLOWEST point of their own nodes (z is elevation,
negative down → max finite node z; a z-less shell falls back to the SCENE's
shallowest point, null → `ref_z` for an all-flat scene), with edge rings emitted
as object-form `outlines` entries at that SAME level. Unclassified legacy
geometry/value ducks retain the flat fallback. `fill=` still opts any producer
offering `value_layer()` into the value-coloured mesh (explicit opt-in unchanged).

**Lattice3D:** `{name: str | null, lines: [[[x, y], …], …], z: float | null}`
— flat lattice polylines (geometry grids clipped to `edge` exactly as on the
Map tab, or a bare item's wireframe edges), rendered at elevation `z`
(`null`/absent → `ref_z`; additive — older payloads carry no `z`).

**Well3D:** `{id: str, trajectory: [[x, y, z | null], …], display_name?: str,
x?: float, y?: float, style?: WellStyle, label?: bool}` — z is ELEVATION
(negative down; note the 2-D `WellTrack.trajectory` carries positive-down
TVD). `id` takes the same `well:` categorical identity slot as top-level
wells. A `null`-z sample is dropped from the drawn path. Labels are crisp
screen-space text projected on initial render, orbit, explicit redraw, and
resize only; there is no permanent animation loop.

**Render discipline (the volume tab's idioms).** The scene build honours the
same primitive budget (`window.PETEK_TRI_BUDGET`, default 5M, points +
triangles): past it the build **auto-degrades** to a 1-in-stride decimated
preview with a loud "Decimated preview" banner and a `1:stride` badge — never
a refusal, crash, or silent blank. A malformed bundle surfaces a banner + an
`error` status instead of a blank canvas. A lazy workspace also exposes
`loading`, `empty`, and `malformed`; missing runtime and graphics-context paths
use `runtime` and `webgl`. The build outcome is exposed for tests as
`window.__PETEK_SCENE3D_STATUS` (`{state: "ok"|"loading"|"empty"|"malformed"|"runtime"|"webgl"|"error", points?,
triangles, meshes, wells, lattices, latticeZ, buildMs}` — `latticeZ` is the
per-lattice rendered flat level, read back from the built geometry). Compact
surfaces also report `detail`, `refining`, `workerBuildMs`, and `maxAttachMs`.
Full-detail refinement keeps the preview status/camera live while worker buffers
build, then swaps the regular mesh atomically on an animation frame.
z-exaggeration is a display-only group scale; the theme flip re-reads the
line/background tokens while identities keep their slots.

**Click-to-inspect + orbit pivot (owner rulings 2026-07-11).** Hover shows
nothing in the 3-D scene. A still **click** on/near an object
(`THREE.Raycaster` picking over points/meshes/lines; the points/line pick
threshold is sized to the on-screen marker at the pick distance) anchors a
readout at the clicked location (dataset/layer name + true x, y, z/value)
**and re-targets the orbit controls' rotation pivot** (`controls.target`) to
the picked point without moving the camera — subsequent orbiting rotates
around the clicked location. Clicking empty space (or the same target again)
dismisses the readout; the pivot keeps its last picked point. A press that
moved more than a few px between down/up is an orbit drag, never a pick. The
pick outcome is exposed for tests as `window.__PETEK_SCENE3D_PICK`.

## WellTrack

`{id: str, x: float, y: float, trajectory: [[x, y, tvd], …], display_name?: str,
ties?: [{horizon: str, residual_m: float}, …]}`. `id` is a categorical identity
(fixed colour slot across all tabs). The surface marker sits at `(x, y)`; a click
sections along the bore (live) or resolves to a pre-computed bore section by
matching `id` against `section_labels` (file mode). `ties` (optional) are the
per-horizon surface-tie residuals (`pick − surface`, m) shown in the layer
panel's per-bore entries.

**Tie-quality glyph (v4).** A well carrying `ties` gets a small 3-pip glyph beside
its marker: the pips fill by tie-quality tier binned on the **mean absolute
residual** — `≤ 2 m` good (3 pips), `≤ 5 m` fair (2), else poor (1). The glyph
wears **text tokens** (it reads a residual; it is not a categorical entity), never
a series identity hue. The panel's per-bore entry lists the per-horizon
residuals (the map is click-to-inspect; a marker click sections the bore).

## WellLogBundle — multi-well log correlation (Wells tab, v4)

`wells_logs` is a `WellLogBundle` (`kind: "wells_logs"`, `schema_version: 4`) — N
wells side-by-side on a **shared inverted depth axis** (depth increases downward),
each with a set of tracks (a flag strip + continuous curve tracks). Two hanging
modes: **TVD** (absolute depth) and **flatten-on-pick** (each well shifted so a
chosen horizon aligns at Δ = 0 — the transform is **viewer-side**; the payload
carries picks, not transforms). A well with no top for the chosen pick is *parked*
(shown at absolute TVD, dashed frame + tag). Curve colour is identity **by track**
(mnemonic), never by well — PHIE is one colour across every well.

| field | type | notes |
|---|---|---|
| `kind` | str | `"wells_logs"` |
| `schema_version` | int | `4` |
| `flatten_default` | str \| null | the pick pre-selected in flatten mode (else the first pick) |
| `template` | CorrelationTemplate \| null | additive named layout; absent preserves the exact historic inferred-track layout |
| `wells` | list[LogWell] | one per bore, in display order (reorderable in the panel) |

**CorrelationTemplate v1:** `{spec:"CorrelationTemplate", schema_version:1,
name, tracks:[CorrelationTrack], layout:{depth_axis,padding,gap},
tops:{show,labels,connectors}, zones:{show}, default_hang, flatten_pick}`.
Tracks are ordered; `width` is their relative width and `group` optionally names
a visual group. **CorrelationTrack:** `{spec:"CorrelationTrack",
schema_version:1, id, title?, width, group?, scale:"linear"|"log",
side:"left"|"right", minimum?, maximum?, reversed, layers:[Layer]}`. A layer is
`{id, kind:"curve"|"flag", mnemonic, style, fill?, cutoff?, overlay}`. Styles
carry optional CSS `color`, positive `width`/`dash`, and bounded opacity. A curve
missing from one well leaves that lane blank; a template applied through the
Python value rejects a curve absent from every well. Same-horizon connectors
join adjacent visible wells after current reorder/visibility and use each well's
TVD/flatten/parked transform. `window.__PETEK_CORRELATION_LAYOUT` exposes the
resolved template name, visible order, track ids, connector count and hang/pick
for stable browser assertions. Saved HTML embeds the same object and remains
fully offline.

The **numeric lanes** (`md_m`, `tvd_m`, curve `values`) are **v3-style f32 binary
blocks** — `{dtype:"f32", shape:[n], data:"<base64>"}`, little-endian,
`NaN`=`0x7FC00000` — decoded on the **same** kernel the volume blocks use
(`PETEK_DECODE`). They are tiny, so the viewer decodes them synchronously (no
worker); no special casing.

**LogWell:** `{id, display_name?: str, x, y: float, datum_m: float, md_m: lane,
tvd_m: lane, curves: [Curve], tops: [{horizon: str, tvd_m: float}], zones:
[{name: str, top_tvd_m, base_tvd_m: float}], ties?: [{horizon, residual_m}]}`.
`datum_m` is the KB/RT elevation (the header shows it; family z is negative-down).
`tvd_m` is TVD-SS (positive-down, the display axis); `md_m` is measured depth. `tops`
are top→down (a top drives a cross-track line, labelled once; also the flatten pick
menu). `zones` shade the band between their top/base in the zone's identity colour.

**Curve:** `{mnemonic: str, display_name?: str, unit: str, kind: "continuous"|
"flag", values: lane, range?: {min,max}, cutoff?: float, codes?: {"<int>": label}}`.
`values` is a lane sampled on `md_m` (`NaN` = null → the curve breaks). `range`
(optional) fixes the track's hi–lo header scale; else it is auto-ranged.
A **continuous** curve draws as a polyline; if it declares a `cutoff` (e.g. PHIE
net cutoff) the view draws the cutoff reference line + a reservoir fill where
`value ≥ cutoff`. A **flag** curve renders as a categorical **strip**: the zero /
"off" code reads recessive (grid), a non-zero code takes an identity slot (`codes`
supplies the labels — e.g. `{"0":"shale","1":"net sand"}`). Boxed per-track
headers (name + hi–lo scale) replace legend boxes; hover reads depth (TVD, and
Δ-vs-pick in flatten mode) + every curve's value at that sample.

## ChartBundle — an analytics mark (Charts tab)

`charts` is a list of typed mark bundles, each tagged by `mark`. The Charts tab
shows one at a time (a picker in the panel); the renderer is **strictly
render-only** — every number (tornado pivots, histogram bins, exceedance points,
regression coefficients) arrives in the payload. Nothing is fit or binned in the
viewer. Every mark is theme-aware, hover-default, and legended. Added in
`schema_version` 2 (additive: a payload with no `charts` key renders exactly as
before).

Common fields: `mark` (`"tornado"|"scatter"|"distribution"`), `title` (str).

### `mark: "tornado"` — ranked sensitivity, nested bars around a base line

| field | type | notes |
|---|---|---|
| `units` | str | output units of the swung metric (axis + labels) |
| `base` | float | the base value; bars anchor on it, axis is symmetric around it |
| `bars` | list[TornadoBar] | one row per input |
| `fold_count` | int \| null | rank by swing; bars beyond this fold into an "N others" row |
| `fold_threshold` | float \| null | fold bars whose swing is `< fold_threshold · \|base\|` into the "N others" row (default `0.005` = 0.5%); a flat pivot carries no information |

**TornadoBar:** `{param: str, out_lo, out_hi: float, in_lo, in_hi: float|null,
out_min, out_max: float|null, swing: float|null, display_name: str|null}`.
`display_name` disambiguates the input dimension (e.g. `"PORO level shift"` vs
`"porosity (draw)"`); the viewer falls back to `param`. `out_lo`/`out_hi` are the metric
with the input at its low/high pivot (absolute output units) — the **inner**
(P90→P10) band. `out_min`/`out_max`, when present, draw the **outer** (full min→max)
band at low opacity (the nested-bar signature); omit them for inner-only. `in_lo`/
`in_hi` are the pivot **input** values (hover). Rows rank by `swing` (else
`|out_hi−out_lo|`), largest on top. Below-base swing uses the diverging low hue,
above-base the high hue.

### `mark: "scatter"` — crossplot, optional log axes, color-by-third

| field | type | notes |
|---|---|---|
| `x`, `y` | Axis | `{name: str, units: str, log: bool, range?: range}` |
| `color_by` | ColorBy \| null | `{name: str, kind: "categorical"|"continuous", range?, units?}` |
| `groups` | list[str] | categorical identities present (fixed colour slots, in order) |
| `points` | list[Point] | `{x, y: float, c: float|str}` — `c` is the colour value |
| `trends` | list[Trend] | render-only regression lines (endpoints + coefficients) |

Continuous `color_by` → the sequential ramp + a colorbar (`c` a float in
`color_by.range`); categorical → the fixed identity palette + legend (`c` a group
name). Log axes are per-axis (`log: true`; toggleable in the panel). **Trend:**
`{group: str|null, kind: str, x0, y0, x1, y1: float, slope, intercept, r2: float,
equation: str}` — drawn as a dashed line from `(x0,y0)` to `(x1,y1)` in data space;
the coefficients are computed by the consumer (no fitting in the viewer).

### `mark: "distribution"` — histogram + exceedance CDF, two stacked panels

| field | type | notes |
|---|---|---|
| `units` | str | value-axis units (MSm³ oil / bcm gas) |
| `series` | list[Series] | one or more overlaid distributions (identity palette) |

Rendered as **two stacked panels sharing the x-axis** (the dual-axis twinx overlay
is intentionally *not* used): top = frequency histogram, bottom = exceedance curve.
**Series:** `{name: str, display_name?: str, bins: list[{lo, hi: float, count:
int}], cdf: list[{x: float, exceedance: float}], markers: {p90, p50, p10: float}}`.
`exceedance` is the fraction (0..1) of realizations ≥ `x`. The exceedance panel
carries 0/25/50/75/100 % y-ticks; a **single**-series distribution drops the
legend box (the title names it). Histogram bars are drawn with a 2px surface gap. Markers use the **reservoir convention**
(P90 = low / pessimistic, P10 = high) and are drawn across both panels. Bins are
pre-computed by the consumer (the deterministic binning rule lives in the plumbing,
not the viewer).

## Colour discipline (rendered, not declared)

Two colour jobs, never conflated: **continuous fields** (rasters, section fills,
the volume) use a scientific colormap (viridis default; viridis / inferno /
magma / plasma / cividis / turbo / coolwarm / greys selectable, or pinned by the
payload's `map.colormap`). `grays` remains an accepted legacy spelling for
`greys`. A colormap field's independent `colormap_reversed` companion defaults
to `false`; reversal walks the same LUT backwards and is never encoded in the
name (no `*_r` or `-name` convention). A per-layer pin overrides both global
fields as a pair; a missing per-layer reverse flag is `false`, not inherited;
**categorical identity** (wells, horizons, contacts, zones, scatter groups,
distribution series) uses the fixed token slots, assigned by entity and stable
across tabs/theme. The payload supplies names, units and ranges; the renderer owns
the palette. **Signed data** (tornado swings around the base line) uses the
validated **diverging pair** (blue↔red, gray midpoint) — below-base = low hue,
above-base = high hue. The chart marks reuse this one colour system; a consumer
never sends hex.
