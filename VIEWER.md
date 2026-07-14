# The petek viewer unit

A packaged, **domain-agnostic** inspection viewer that ships as petekTools wheel
package data (`petektools.viewer`). Any library that maps its data onto the
[generic render schema](python/petektools/viewer/SCHEMA.md) can drive it: build a
payload, then `serve()` it (a live local server) or `save_view()` it (one
self-contained HTML file). No build step, no CDN, **zero external network
fetches** — three.js is vendored as a classic global and everything (data + JS)
is inlined for the file export. Confidential data never leaves the machine.

The viewer is **strictly bundle-driven**: every tab renders whatever typed layers
/ columns / mesh the JSON payload declares (names, units and value ranges
included). It **never computes** anything — new cross-sections come from the
consumer's `section_provider` callback (live) or are pre-computed into the payload
(file). This is the *viewer unit* half of petekTools' SPEC carve-out.

Home ruling: `decision_viewer_home_petektools` (2026-07-04) — the viewer serves
all layers (petekStatic, petekIO, peteksim), so it is horizontal capability and
lives here, not in any one product.

## The Python surface

```python
from petektools import viewer

# Multi-view workspace: normalization is metadata-only. Workspace-v2 Map
# resources carry all attribute blocks once and share them across 2-D/3-D modes;
# workspace-v1 lane resources keep their selector-backed compatibility cache.
session = viewer.view({
    "Interpretation": {
        "Synthetic Top Alpha": {"object": synthetic_top_alpha, "visible": True},
        "Synthetic Base Alpha": {"object": synthetic_base_alpha, "visible": False},
    }
}, title="Synthetic Alpha workspace")
session.tree()                 # detached normalized catalog
session.diagnostics           # resource failures, if any
session.save("visible.html")   # initially visible resources only
session.save("all.html", include="selected")

# Live: a background local server; returns the URL. `section_provider` is the
# pluggable /section endpoint by which a DOMAIN package answers fence/well
# requests — the viewer unit itself computes nothing.
viewer.serve(payload, port=0, block=False, open_browser=True, section_provider=None)

# Static: ONE self-contained HTML file (all JS + data inlined; opens via file://).
# `precomputed_sections` bakes consumer-computed sections into the frozen export.
viewer.save_view(payload, path, precomputed_sections=None)

# Lower-level: build (don't start) the server — returns (httpd, url).
viewer.build_server(payload, port=0, section_provider=None)
```

`payload` is a dict **or** a pre-serialized JSON string. A consumer typically
wraps these: e.g. peteksim's `model.view()` calls `serve(payload,
section_provider=lambda **kw: model._section_json(**kw))`.

### Workspace input and lifecycle

`view(tree_or_source, ...)` is additive and returns a `WorkspaceSession`.
Pass `serve=False` for notebook construction/inspection without opening a local
server; `.serve()` can start it later.
`tree_or_source` is either an insertion-ordered nested mapping/list or an object
with the domain-free provider duck `view_catalog()` plus
`view_resource(*, item_id, view, detail=None)`. Workspace-v1 providers may keep
the legacy `lane=None` argument; transitional selector-backed v2 providers use
`attribute=None, color_by=None`, while shared v2 Map providers receive neither
selector. Mapping keys define ordered groups
and canonical escaped path IDs; list leaves require an explicit `id`. Explicit
leaves use `{"object": obj, "id"?, "label"?, "visible"?, "views"?}`.
Duplicate IDs, cycles, ambiguous list leaves, unknown views, and unsupported
generic adapter options fail before a server opens.
An omitted leaf `visible` selects all of that leaf's enabled views; use
`visible=False` on leaves or `view(..., visible={})` for a catalog-only opening
that materializes nothing until the user enables an item. Provider/project
catalogs should always emit their intended initial visibility explicitly.

A project-backed v2 provider wraps the ordered records as
`{"schema_version": 2, "project": {"title": ..., "crs": ..., "unit": ...},
"tree": [...]}`. The title is the persisted
project display name. CRS is optional free text printed verbatim, and the project
unit is only the fallback for the primary/depth attribute; neither value is
guessed. Producers persist these values and per-attribute metadata at their own
domain seam so a save/reload does not silently lose the HUD or legend meaning.
Older projects load them as absent. petekTools only validates and renders these
generic strings.

A v2 provider declares ordered, metadata-preserving attributes on one shared Map
resource:

```python
{
    "id": "surface:synthetic-top-alpha",
    "label": "Synthetic Top Alpha",
    "views": {"map": {
        "attributes": [
            {"id": "depth", "label": "Depth", "kind": "continuous",
             "units": "m", "codes": None},
            {"id": "thickness", "label": "Thickness", "kind": "continuous",
             "units": "m", "codes": None},
            {"id": "facies", "label": "Facies", "kind": "categorical",
             "units": None,
             "codes": {"1": {"label": "Sand", "color": "#EDA100"}}},
        ],
        "active_attribute": "depth",
        "active_color_by": "depth",
        "transport": "shared",
        "modes": ["2d", "3d"],
    }},
    "visible": {"map": True},
}
```

The tree owns the geometry `attribute`; the Inspector owns `color_by`. Changing
the attribute resets colour-by to the same ID, while a later colour-only change
explicitly decouples them. Every descriptor is available in both selectors.
Opening calls `view_resource(item_id="surface:synthetic-top-alpha", view="map")`
once and receives all attribute value blocks in one `map.surface_grid`; selector
changes and 2-D/3-D mode changes are client-local and cause no request or second
decode of geometry. Metadata survives catalog normalization, manifest JSON,
live responses, and saved HTML unchanged except for canonical defaults described
in `SCHEMA.md`.

Workspace v1 remains accepted. Its `{lanes,active_lane}` catalog, `lane=` request,
and envelope echo map one lane to both v2 selectors with continuous/unknown-unit
metadata. `default_lane` remains a v1 provider input alias. A provider/request
must not mix `lane` with `attribute` or `color_by`.

A provider may advertise progressive 3-D detail with ordered
`tiers=[preview, full]` and `active_detail="preview"`. Live mode renders
`detail=preview` first, then requests `detail=full` in the background. Full
completion replaces the compact regular mesh without moving the camera or
returning the workspace to global Loading. No-tier providers retain the original
call shape. Static workspace export embeds the advertised full tier directly.

Providers can also retain unsupported assets as disabled searchable leaves:
`{"id": ..., "label": ..., "views": {}, "disabled": True,
"reason": "Unsupported project asset", "diagnostic": {...}}`. Zero views
infer `disabled=True`; these records have no resource links and never fetch.

The live `model.json` contains workspace manifest v1 or v2 and any
caller-supplied typed payload. A v2 shared Map request is
`./workspace-resource?item=…&view=map[&detail=…]`; its single-flight/cache/retry
identity excludes both selectors. The v2 response has one envelope-level block
table and a `map.surface_grid` whose attribute data order exactly matches the
catalog. A legacy request remains
`./workspace-resource?item=…&view=…&lane=…`. Transitional non-shared v2 requests
use both `attribute=…&color_by=…` and responses echo both, but they are not a
multi-attribute static-export format. Unknown selectors fail before the producer
is called, mismatched echoes are never cached, and failures remain item-local and
retryable.

`WorkspaceSession.save(include="visible")` embeds only initially visible
resources; `include="selected"` embeds every catalogued resource. For shared v2
Map data, either mode writes one resource envelope per included item (the `full`
tier when advertised) with each attribute block once—never one envelope per
attribute/colour pair. Snapshot
state records `active_attribute`, `active_color_by`, mode, and detail separately
from resource identity, so the chosen selectors remain fully offline. Workspace
v1 exports retain their historical visible-active-lane/selected-all-lanes
behavior. Both use the same zero-network, self-contained HTML export.
`refresh()` is the explicit boundary for
producer/tree mutation; it clears the resource snapshot without allowing an
older in-flight completion to repopulate the refreshed cache.

Workspace payloads use a three-region application shell: the searchable Project
navigator owns the left side, the active viewport stays central, and a
contextual Inspector owns view controls on the right. Only views backed by a
typed payload or catalog capability appear. The app bar carries the title,
available-view tabs, live/offline/loading state, theme, help, and panel toggles;
the status bar reports the active view and selected/cached resource state.
Both side panels are collapsible, pointer/keyboard resizable, and become overlays
at narrow notebook widths. Bounded browser preferences retain only theme,
selected tab, and panel layout—not catalog, visibility, lane, or project data.

The navigator's group checkboxes show checked/unchecked/indeterminate state and
counts; leaf checkboxes affect only the active Map, 3-D, or Wells tab, so
selections remain independent across views. `/` focuses Project search, `1`–`3`
switch the available views, `F` fits the active viewport, and `?` opens the
in-app shortcut reference. Large catalogs use a virtual scroll window (the
ordered manifest remains complete) to keep search and group-toggle work bounded.
A failed live resource stays local to its leaf and offers retry; a resource
omitted from a visible-only static snapshot is marked offline with the snapshot
explanation. Map surface fills retain the normal attribute selector and lazy
block decoding after composition. Non-workspace payloads keep their historic
two-region chrome and rendering behavior.

Initial disclosure is deterministic: the selected path is revealed, otherwise
only branches with one or two actionable leaves auto-expand. Larger branches
start folded; user expansion/collapse survives panel and tab rebuilds and never
fetches a resource. Safe singleton folder chains render as one breadcrumb row.
Folders are compact, object rows carry their generic role and loading/error/
selection state, and hierarchy guides remain visible through deep catalogs.
Every button uses the same delayed pointer/immediate keyboard-focus tooltip with
`role="tooltip"`; native button `title` bubbles are removed. These control hints
are independent of the click-to-toggle data readouts in Map and 3-D.

The workspace never traverses a project or interprets domain roles. Generic
objects use the existing `view2d_payload` / `view3d_payload` ducks. Sections,
volume, charts, and other producer-computed bundles enter through `payload=` or
the provider resource duck.

## The two modes — capability split

|  | `serve()` (server / **live**) | `save_view()` (single file / **static**) |
|---|---|---|
| Map / Intersection / Volume tabs | ✅ | ✅ |
| Pan · zoom · click-to-inspect readout · toggles · colormaps · dark mode | ✅ | ✅ |
| Pre-computed sections (payload `sections`) | ✅ | ✅ |
| **Draw-a-fence** on the map → new section | ✅ (calls `section_provider`) | ⛔ disabled, with a tooltip |
| **Click a well** → new along-bore section | ✅ (live) | ↩ switches to the well's *pre-computed* section if present |

The file export is a frozen snapshot: it ships only what was computed at save
time (the renderer cannot cut a new section without a provider). Everything else
is identical between the two modes.

## The tabs

### Map (canvas 2-D)
Areal plan view. A **Layer** picker chooses which georeferenced `ScalarLayer` to
raster (any horizon or property zone-average / k-slice the bundle carries), drawn
with a perceptually-uniform colormap; it **defaults to the top-horizon depth map**
(structure first, properties by choice). The raster is **clipped to the outline
polygon** by default (an *Unclipped raster* toggle disables it for QC). Overlays:
the **outline** ring(s), per-`kind` **contact subcrop masks** (translucent fill +
45°/135° hatch + 2px identity outline), and **well markers** — co-located
sidetracks collapse to one shared wellhead marker with a **bore-count badge** and
radially fanned, leader-lined labels. The canvas fits and centres the full drawn
content, never a generated frame/empty-resource rectangle, and the first fit
shows at least 10 km horizontally. After that first fit, resize, deferred decode,
LOD and idle paints preserve the camera; pan/wheel owns it until an explicit `F`
refit. Filled surfaces start with grid/lattice lines off; a standalone geometry
starts with them on, and either manual choice persists.

In a workspace, a Map resource may carry producer-declared `well_overlays` for
its stable surface/item identity. The active fill selects that context
atomically, so switching surfaces changes projected well paths in the same
paint; attribute fills belonging to one surface keep the same paths. The
selected overlay—not the base full trajectory—participates in fit. Wellhead,
label and style remain from the base well, and well visibility stays an
independent toggle. Missing/legacy records fall back to the base trajectory;
ambiguous/error/malformed records remain localized diagnostics. The additive
`intersections` list carries every producer-computed pick in MD order; across
visible surface contexts, the greatest finite MD is the anchor, shallower picks
remain cycleable, and visibility changes cause no fetch. Singular
`intersection` is still the fallback for old payloads and retains its old
first-hit meaning. The viewer does not calculate clipping, intersections,
measured depth or depth conversion.

Workspace-v2 shared surfaces use one `map.surface_grid`: an affine `Frame`, a
mask, ordered rich descriptors, and one typed value block per attribute in the
resource envelope's single digest table. The selected attribute supplies 3-D
geometry and `color_by` supplies paint; 2-D and 3-D camera modes read the same
blocks. `Frame.rotation_deg` is counter-clockwise from east to I, `yflip`
reverses J, and optional free-text `crs`/`units` support an honest HUD. Missing
fields preserve the axis-aligned v1 frame (`0`, `false`, unknown, unknown).
Intrinsic frame orientation and the user's camera rotation are separate exact
transforms.

The raster is
**windowed + resolution-capped** — only the grid cells in
the current viewport are sampled, and never more than one sample per screen pixel
(subsampled beyond that) — so a repaint costs a screenful regardless of ncol×nrow
(a 2000×2000 field repaints in ~2 ms), while the click-to-inspect readout still
reads the full-resolution value array. The **point-cloud overlay is batched + baked** the same way: points
draw in ≤256 colormap-bin `Path2D`s (one fill per bin) into a viewport-windowed,
memory-capped offscreen canvas that pan/zoom re-blit in one `drawImage`;
wheel/drag repaints coalesce to at most one per animation frame, and every
gesture frame affine-transforms the last valid bitmap even outside its baked
window/zoom band (re-baking only once when the gesture pauses); click-to-inspect hit-tests a coarse
world-space grid bucket — so a **200k-point coloured cloud pans/zooms/inspects
at frame rate**
(the browser acceptance budget is p95 <8 ms and max <16.7 ms; previously ~145 ms per event).
The active **value fill bakes the same way**: it rasterizes once into an
offscreen bitmap that every hot pan/zoom frame affine-blits, re-baking only on
zoom-settle, so a ~78k-triangle fill never re-triangulates per gesture frame.
The four-entry fill-bitmap LRU holds the two most recent fill fields at both
full and coarse LOD, so an A→B→A switch reuses A without rebuilding. Hot frames
also leave canvas backing size, legend DOM, and theme-style reads untouched; a
hidden tab cancels the settle timer (`visibilitychange`) and only the visible
tab ever repaints.
Grid, contour and outline paint is baked into a second bitmap below points;
contact masks bake into a third bitmap above points. This split preserves exact
layer order while making a hot gesture composition-only even for a full
wireframe or a 1M-cell contact mask. The outline's world `Path2D` is compiled
once and is reused for raster clipping.

The `view2d` map's bulk arrays (points, fill nodes/triangles/values, grid
lines, contour polylines, and contact crossing masks) travel as
**content-addressed typed binary blocks**
by default (`encoding="blocks"`; ~3× smaller than JSON floats at 200k points,
identical arrays ship once) and are decoded off the main thread in the shared
decode worker, cached by digest. Shared automatic fill topology packs once;
startup decodes every geometry/overlay block but only the active fill's values,
then lazily decodes an inactive lane on first selection. `encoding="json"` opts
out and a JSON-shaped map renders identically. The full block table stays in a
saved HTML file, so lazy selection remains offline. With `lod=` on (the default), producers that accept
striding contribute one coarse **display-only LOD ring** per fill / mesh grid
/ contour set; the viewer switches rings on zoom-settle (never per frame) when
a full-resolution cell falls below ~4 px, shows a small "LOD" chip while
coarse is up, and swaps back at full detail — geometry truth is never
decimated. Payload shapes for both are in `SCHEMA.md` (MapBundle →
**Binary blocks** / **Stride-ladder LOD**).

An exact affine structured value layer uses the compact Map fill form:
dimensions, origin, two world-coordinate step vectors, and row-major typed
values/mask, with no expanded mesh nodes or triangles. Rotation and a flipped J
axis are preserved by the vectors; NaN holes remain transparent and
uninspectable. The browser rasterizes in grid index space and applies the affine
once. Non-affine surfaces and existing ScalarLayer/TriFill JSON or block
payloads keep their established renderer paths.

For the `view2d` QA path, `color=` and `fill=` are **separate semantics**
(owner rulings 2026-07-10 / 2026-07-13): `color=` colours **points** (and picks
the colormap for whatever is value-coloured) — it never triggers fills, and it
defaults ON (`color=False` for monochrome points). Stable producer `kind`
metadata separates points (`point_set`), geometry-only shells (`grid_geometry`,
`structured_shell`, `mesh_shell`), and value surfaces (`surface`,
`structured_mesh`, `tri_surface`) before overlapping method ducks. When `fill`
is omitted, only a value-surface role offering callable `attr_names()` **and**
`value_layer()` contributes its primary layer followed by every named attribute
in producer order; the Fill picker switches among them and labels each
`source · layer` (for example, `Synthetic Top Alpha · values` /
`Synthetic Top Alpha · thickness`).
Point sets stay points, and geometry shells stay wireframes even if they expose
overlapping helper methods. Explicit `fill=False` disables all fills,
`fill=True` requests the primary only, and a string requests exactly that named
lane from any producer offering `value_layer()`; per-object dict overrides still
win. Contour lines remain opt-in through `contours=`. Both
`color=` and `fill=` accept `True` or a string spec parsed by **registry
match**: `"[<attr>_]<cmap>[_<min>_<max>]"`, where `<cmap>` is one of
`viridis` / `magma` / `grays` / `inferno` and the two trailing floats are an
explicit clamp range (negatives fine — `"inferno_-2700_-2500"`); a string with
no colormap token stays an attribute name (`value_layer(attr=...)` /
`iso_lines(attr=...)` back-compat), and `"porosity_inferno_0_0.3"` combines
all three. Values outside an explicit range **clamp to the ramp ends**, the
parsed colormap initializes the panel selector (`map.colormap`), and a
malformed spec raises `ValueError`. So `view2d([pts, geom], color=True)` shows
exactly coloured points + geometry lines — no surprise trimesh fill. A
value-bearing item passed bare without callable `attr_names()` (for example a
single-layer producer exposing only `value_layer()` + a 2-D `.geometry`) renders
its STRUCTURE — the geometry lattice lines (or, geometry-less, its primary value
layer's triangle edges). A value-surface producer that participates in the
two-duck attribute handshake gets the selectable omitted-fill behaviour above.

**Per-object colour — the dict item form (owner ruling 2026-07-11, view2d AND
view3d).** A scene item may be a dict `{"object": obj, "color": bool|spec,
"fill": bool|spec, "name": str}` — per-object settings take **precedence**
over the call-level `color=`/`fill=` (including omitted-fill auto mode for a
dict item without its own `fill`; `color=True` default unchanged), and `name`
overrides the duck-typed display name. Colour/ramp/range travel **per layer**:
each points layer /
point cloud carries its own resolved clamp range (and a pinned colormap for a
per-object spec — the panel selector doesn't override a pin), each fill/mesh
its own colormap, and the legend shows each entry's own ramp + range. The
global `map.colormap`/`point_color` (and their `scene3d.*` twins) stay
emitted as a fallback for older payload consumers; the renderer reads the
per-layer fields first. The spec grammar is unchanged.

The map **legend renders one entry per visible layer** — a small type icon
(dot cluster = points, lattice = grid lines, filled ramp swatch = fill/raster,
squiggle = contours, marker = wells) + the layer's display name, duck-typed
from the source object's `name` (e.g. a petekIO dataset name like
`"Top Dome"`; fallback: the layer kind), with the colormap ramp + the clamped
range wherever the layer is value-coloured. Pan (drag), zoom (wheel);
**inspection is click-driven** (owner ruling 2026-07-11): hover shows nothing —
a still **click** on/near a point (or a raster cell) anchors a readout at the
clicked location (dataset/layer name, x, y, z/value) that persists until the
next click; clicking empty space, or the same target again, dismisses it, and
a moved press is a pan, never an inspect. A well marker keeps its click
semantics (section along the bore); its per-horizon surface-tie residuals live
in the layer panel, and a well with ties wears a small **tie-quality glyph**
(3 pips filled by the mean-|residual| tier: ≤2 m good, ≤5 m fair, else poor;
text tokens, never a series hue). **Section tools**: *Draw fence line* (live)
— click points, double-click to cut; click a well marker to section along its
bore.

### Intersection (canvas 2-D)
A vertical cross-section. A **Trace** picker selects among the sections. Each
column is filled per layer by the property colormap — or, when the section carries
zone bands (`zones` + per-column `zone_ids`), a **Color by: property | zone**
select swaps the fill to the fixed **categorical zone identity** (a user-declared
`color` hex wins; otherwise the same identity slot the volume/wells zone legend
uses for that zone name — identity follows the entity across views). In zone mode
the legend swaps to zone chips and hover reads the zone name + the property value;
a payload without `zone_ids` never shows the select (graceful — stays on the
property colormap). **Cells follow the zone
edges by default** (the sugar-cube ruling, v4-additive): when the payload
carries the per-column edge arrays (`layer_tops_l/r`, `layer_bases_l/r`) and
does not declare `sugar_cube: true`, each cell draws as a **trapezoid** whose
top/base dip across the column — flat-box "sugar cube" rects only for
`sugar_cube: true` or older payloads without the edge arrays (graceful, no
error). The **top/base horizon traces** follow the same dip in trapezoid mode;
any **interior-horizon traces** (v4 `horizon_traces` — one polyline per
zone-bounding interior horizon, NaN-gapped where a column doesn't reach it,
labelled once at the right, labels **staggered** when horizons end at close
depths — and on a long (~16 km) fence the right-edge cluster is decluttered by a
horizontal stagger + leader line + a fade for a heavily-displaced label) and flat
**contact** lines overlay it — **same-depth contact pairs
combine into one label** ("GOC + OWC 2,100 m") and edge-clamped labels stack
instead of overprinting — plus the **bore path** `z` for an along-bore section.
The depth axis frames the **reservoir envelope** (layers + contacts + margin,
including the dipping edge extremes), not the whole surface→TD trajectory — the
bore path is clamped into that window with an **off-scale arrow** where it
exits. A **vertical-exaggeration** slider (default 5×, unchanged) and a hover
readout (distance, cell `i,j,k`, layer depth range, value — hover reads the
**centroid** intervals). The active cell-render path is exposed for tests as
`window.__PETEK_SECTION_MODE` (`"trapezoid"` | `"rect"`).

### Volume (three.js)
The corner-point cell **exterior shell**, flat-shaded per cell by the property
(v3 binary-block payload, decoded off the UI thread in a Web Worker; a legacy v2
JSON soup still renders as a fallback). A **threshold** slider hides shell
triangles below a `cell_values` cutoff (client-side, exterior only; a served
"true interior" re-cut exposes revealed interior faces); a **z-exaggeration**
slider (1–20) **defaults to 5×** — a **fit z ×N** button beside it applies the
aspect-derived suggestion (a thin, wide reservoir reads with relief, not a
pancake) — applied as a display-only depth scale, with a `z ×N` corner badge and
true depths in the readout; **zone** toggles show/hide zones; orbit to rotate;
*Reset view* to re-frame. Beyond a declared **triangle budget** (5M, overridable)
the viewer **auto-degrades** — the worker decimates the shell to a 1-in-*stride*
preview so the render buffer and JS heap stay bounded — and says so in a **loud
banner** (what/why + the remedy) and a `1:stride` badge; a truly undecodable
inline payload (past the memory cap) refuses gracefully and points at sidecar
mode. It **never crashes, OOMs, or blanks silently** — the ledger's death mode is
the enemy. It also **never hangs on a bad mesh**: a decode that completes with
**zero triangles** (an upstream producer bug — cells declared, no geometry) shows
a loud in-tab message ("Mesh is empty — N cells declared, 0 triangles; this is a
producer bug.") instead of an endless spinner, and a **decode watchdog**
(30 s default, overridable via `window.PETEK_DECODE_WATCHDOG_MS`) surfaces a
visible failure with diagnostics if the worker never reports back or errors. The
volume-tab outcome is exposed for tests as `window.__PETEK_VOLUME_STATUS`
(`{state: "ok"|"empty"|"stalled"|"error", …}`). A **Grid** panel group shows the
cell dims (i×j×k) and mean cell size on every tab.

### 3D (three.js — the `view3d` scene)
The generic 3-D companion to the `view2d` QA path: `petektools.view3d([...])`
accepts the SAME duck-typed items (points, geometries, trimeshes,
`value_layer()` surfaces, `iso_lines()` contours, outlines) plus first-class
`wells=` (a bare well, a project-wells collection, or explicit dictionaries;
`well_labels=False|True|"auto"`; shared serializable `WellStyle`) and item wells
(`trajectory()` of `[x, y, z]` rows, z **elevation** — negative down, the
family convention) and renders them in **one Three.js scene** (payload
`scene3d`; the "3D" tab appears only when present). `color=` / `fill=` /
`contours=` keep their exact view2d semantics and registry-match spec grammar:
points render as a **single-draw-call colour-coded cloud** (compact base64 f32
blocks on the wire, decoded on the volume tab's kernel; smooth at the 200k
cap), and **solid surface layers are for surfaces only**: all three value-surface
roles (`surface`, `structured_mesh`, `tri_surface`) passed bare render a neutral
elevation mesh from their primary value layer (value-coloured under `fill=`;
triangles touching a z-less node are holes, never guessed).
Exact affine structured surfaces use compact `regular_surface` meshes:
dimensions/origin/I+J steps plus typed row-major elevation, mask, and optional
value blocks, with no expanded nodes or triangles. The shared volume/Map worker
builds transferable position/index/colour buffers. A preview stays interactive
while a separately fetched full tier builds; the final swap is atomic and
camera-stable. Non-affine and legacy Mesh3D payloads keep their established path.
Their geometry-only
counterparts (`grid_geometry`, `structured_shell`, `mesh_shell`) render as a
**flat wireframe grid** placed at the **shallowest point** of their own nodes
(z is elevation, negative down → max finite node z; a z-less geometry falls
back to the scene's shallowest point), with edge rings at that same level.
Unclassified legacy geometry/value ducks retain the flat fallback; `fill=` still
opts any value-bearing producer into the value-coloured mesh. Contour polylines
draw at their level, and wells
draw identity-coloured with a screen-sized wellhead marker and crisp labels
projected only on render/orbit/resize (no permanent loop). The panel carries
the colormap selector and the volume tab's **z-exaggeration** control (slider +
"fit z ×N", display-only scale with a `z ×N` badge and true depths in the
readout); the legend is the Map tab's per-layer machinery (type icons +
duck-typed names like "Top Dome · z", ramp + clamped range on value-coloured
layers). The volume tab's render discipline carries over: past the primitive
budget the scene **auto-degrades** to a 1-in-stride decimated preview with a
loud banner + `1:stride` badge, a malformed bundle surfaces a banner instead of
a blank canvas, and the build outcome is exposed for tests as
`window.__PETEK_SCENE3D_STATUS`. Lazy workspace tabs distinguish loading, empty,
malformed resource, runtime-load, WebGL-context, and scene-build failure states.
A solid surface starts without its lattice overlay; geometry-only scenes keep
the lattice visible, and a manual toggle persists. **Inspection is click-driven** here too
(owner ruling 2026-07-11): hover shows nothing — a still **click** on/near an
object (`THREE.Raycaster` picking over points/meshes/lines, the pick radius
sized to the on-screen marker) anchors a readout at the clicked location
(dataset/layer name + true x, y, z/value) **and re-targets the orbit rotation
pivot to the picked point** without moving the camera (the controls re-orient
only — no jump), so subsequent orbiting rotates around what you clicked.
Clicking empty space (or the same target again) dismisses the readout while
the pivot keeps its last picked point; a moved press is an orbit drag, never a
pick. The pick outcome is exposed for tests as `window.__PETEK_SCENE3D_PICK`.

### Wells (canvas 2-D)
Multi-well **log correlation** (the `wells_logs` bundle, schema v4). N wells
side-by-side on a **shared inverted depth axis** (depth down); each well carries a
set of tracks — a **flag strip** (net/facies), **PHIE** with a cutoff reference
line + reservoir fill, a derived **NTG** curve, **SW** — with **boxed per-track
headers** (name + hi–lo scale) instead of legend boxes. **Tops** draw as
cross-track lines labelled once (the logsuite idiom); **zones** shade the band
between tops in the zone's identity colour. Two **hanging modes**: *TVD* (absolute
depth) and *flatten-on-pick* (choose a horizon; every well shifts so that pick
aligns at Δ = 0 — the transform is viewer-side). A well with no top for the chosen
pick is **parked** (drawn at absolute TVD, dashed frame + a tag). **Curve identity
is by track** (mnemonic) — PHIE is one colour across every well, never per-well.
Wells can be shown/hidden and reordered in the panel; hover reads depth (TVD, plus
Δ-vs-pick when flattened) + every curve's value. The log lanes are the same f32
binary blocks the volume decodes (tiny → inline, no worker). Both themes.

An additive `CorrelationTemplate` replaces the inferred one-track-per-curve
layout with an explicit ordered layout: weighted/grouped tracks, curve/flag
overlays, fixed/linear/log/reversed scales, styles and fills, tops/labels,
zone shading, padding/gaps and the default TVD/flatten hang. The renderer draws
same-horizon connectors between adjacent visible wells using the current order;
missing picks and parked wells keep their existing semantics. A missing curve in
one well is a blank lane, while Python application rejects a mnemonic absent
from every well. With no template, the historic layout is unchanged.

### Charts (canvas 2-D)
Analytics marks driven by the payload's `charts` list (a picker chooses one). All
three are **strictly render-only** — pivots, bins, exceedance points and
regression coefficients are pre-computed by the consumer:
- **Tornado** — ranked sensitivity: nested bars (inner P90→P10, faint outer
  min→max) around a base line, symmetric axis in absolute output units, the
  diverging pair for below-/above-base swings. Rows fold into "N others" past
  `fold_count` **and** when their swing is negligible (`< fold_threshold · |base|`,
  default 0.5%). Bars carry a `display_name` (e.g. `"PORO level shift"` vs
  `"porosity (draw)"`). Hover a bar for its low/high pivot inputs + output range.
- **Scatter** (crossplot) — x/y with optional per-axis log scale (perm on log by
  convention), colour-by-third (continuous → ramp + colorbar; categorical →
  identity palette + legend), optional per-group trend lines (equation + R²).
- **Distribution** — histogram + exceedance-CDF as **two stacked panels sharing
  the x-axis** (never a dual-y overlay), P90/P50/P10 markers in the reservoir
  convention (P90 = low), multi-series overlay for structure-vs-field.

## Try it (the standalone demo — the second-consumer proof)

```
python -m petektools.viewer.demo            # write a self-contained HTML, print its path
python -m petektools.viewer.demo --serve    # open a live server instead
```

The demo hand-builds a tiny synthetic payload (a raster + a section + a mesh) and
renders it through the unit with **no peteksim / petekStatic anywhere** — proof
the renderer is horizontal capability.

## Design system (dataviz method)

- **Two colour jobs, never conflated.** Continuous **fields** use a
  scientific colormap (viridis default; viridis, inferno, magma, plasma,
  cividis, turbo, coolwarm, and greys; legacy `grays` remains accepted). A
  payload may pin `colormap` and its independent boolean
  `colormap_reversed`; reversal defaults false and is part of render-cache
  identity, never a suffix/prefix encoded into the name. **Categorical identity**
  (wells, horizons,
  contacts, zones) uses the fixed token slots (`--c1..--c8`), assigned **by
  entity** and never recoloured when a toggle changes the visible count or the
  theme flips — an entity keeps its slot across all three tabs and across sessions
  of the same bundle.
- **Legends are always present** for ≥2 identities; **SI-labelled** with the value
  range read from the bundle. Thin marks, recessive hairline axes/grid.
- **A readout is always available**; hit targets are larger than the marks. The
  Map and 3D tabs are **click-to-inspect** (hover shows nothing; a still click
  anchors a persistent readout at the clicked location); the Intersection /
  Wells / Charts tabs keep their hover readouts.
- **Dark mode is selected, not auto-flipped** — a `☾`/`☀` toggle swaps a second,
  separately-chosen set of token steps validated for CVD + contrast.

## How the viewer JS is organized (concat parts, zero-CDN)

`viewer.js` is **one shared-closure IIFE**, maintained as ordered fragments
under `assets/viewer/` (`NN-name.js` — `00-app` core/state/palette, `10-chrome`
lanes+tabs+shared UI, `20-map`, `30-section`, `40-volume`, `45-scene3d`,
`50-wells`, `60-charts`, `70-overlays` legends/readout/section-requests,
`80-panel-boot`).
The parts are *not* standalone scripts or ES modules — the zero-external-fetch
constraint rules out runtime imports — so the packaging layer
(`viewer/_bundle.py`) concatenates them byte-for-byte in numeric filename order
at build time: `serve()` writes the assembled `viewer.js` beside `index.html`;
`save_view()` inlines the assembled source. Editing rule: a part must begin
exactly where the previous one ended (the assembled bundle is what the browser
sees); `test_viewer_bundle_assembles_one_iife` pins the single-IIFE shape.

## Regenerating the vendored three.js global

The unit ships `three.global.js` + `orbitcontrols.global.js` — the vendored
three.js **r160** ES modules converted to classic globals (so they load over
`file://` and inline cleanly). If three.js is re-vendored, re-run the conversion
(strip the ESM `export`/`import`, wrap in an IIFE that publishes `window.THREE` /
`THREE.OrbitControls`) and neutralise the two functional string URLs (the XHTML
namespace + the deprecation warning) so the file carries no literal `http(s)://`
in code.
