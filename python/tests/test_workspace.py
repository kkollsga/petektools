"""Generic, domain-free workspace contract and delivery tests."""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import pytest

import petektools as pto
from petektools import WorkspaceSession
from petektools.viewer import ASSETS, _bundle


class Points:
    kind = "point_set"

    def __init__(self, name="Picks"):
        self.name = name
        self.calls = 0

    def xyz(self):
        self.calls += 1
        return [[0.0, 0.0, -1.0], [1.0, 1.0, -2.0]]


def test_nested_tree_normalizes_without_materializing():
    top = Points("Synthetic Top Alpha")
    base = Points("Synthetic Base Alpha")
    session = WorkspaceSession(
        {
            "Interpretation": {
                "Surfaces": {
                    "Synthetic Top Alpha": {"object": top, "visible": True},
                    "Synthetic Base Alpha": {"object": base, "visible": False},
                }
            }
        }
    )

    assert top.calls == base.calls == 0
    tree = session.tree()
    leaves = tree[0]["children"][0]["children"]
    assert [leaf["id"] for leaf in leaves] == [
        "item:Interpretation/Surfaces/Synthetic%20Top%20Alpha",
        "item:Interpretation/Surfaces/Synthetic%20Base%20Alpha",
    ]
    assert leaves[0]["visible"] == {"map": True, "scene3d": True}
    assert leaves[1]["visible"] == {"map": False, "scene3d": False}
    manifest = session.manifest()["workspace"]
    assert manifest["schema_version"] == 1
    assert manifest["available_views"] == ["map", "scene3d"]
    assert "expanded" not in manifest["tree"][0]
    assert "expanded" not in manifest["tree"][0]["children"][0]


def test_group_expansion_is_an_optional_explicit_override():
    tree = [
        {"id": "open", "label": "Open", "expanded": True, "children": [
            {"id": "a", "object": Points()},
        ]},
        {"id": "closed", "label": "Closed", "expanded": False, "children": [
            {"id": "b", "object": Points()},
        ]},
    ]
    normalized = WorkspaceSession(tree).tree()
    assert normalized[0]["expanded"] is True
    assert normalized[1]["expanded"] is False
    with pytest.raises(TypeError, match="expanded must be a bool"):
        WorkspaceSession([{"id": "bad", "expanded": "yes", "children": []}])


def test_explicit_nodes_ids_views_and_visible_override():
    session = WorkspaceSession(
        [
            {
                "id": "structure",
                "label": "Structure",
                "children": [
                    {
                        "id": "surface:top",
                        "label": "Top",
                        "object": Points(),
                        "views": {"map": {"color": False}, "scene3d": False},
                    }
                ],
            }
        ],
        visible={"map": ["surface:top"]},
    )
    leaf = session.tree()[0]["children"][0]
    assert leaf["views"] == ["map"]
    assert leaf["visible"] == {"map": True}


@pytest.mark.parametrize(
    "tree, message",
    [
        (
            [
                {"id": "same", "object": Points()},
                {"id": "same", "object": Points()},
            ],
            "duplicate workspace ID",
        ),
        ([{"object": Points()}], "require an explicit stable id"),
        ([{"id": "x", "object": Points(), "views": ["seismic"]}], "unknown workspace view"),
        (
            [{"id": "x", "object": Points(), "views": {"map": {"banana": 1}}}],
            "unsupported map workspace option",
        ),
    ],
)
def test_invalid_catalogs_fail_before_serve(tree, message):
    with pytest.raises((TypeError, ValueError), match=message):
        WorkspaceSession(tree)


def test_cycles_fail_loudly():
    tree = {}
    tree["loop"] = tree
    with pytest.raises(ValueError, match="cycle"):
        WorkspaceSession(tree)


def test_generic_resource_is_lazy_cached_and_bound():
    points = Points()
    session = WorkspaceSession({"Picks": points})
    item_id = "item:Picks"

    first = session.resource(item_id, "map")
    second = session.resource(item_id, "map")
    assert points.calls == 1
    assert first == second
    assert first["item_id"] == item_id
    map_bundle = first["payload"]["map"]
    assert map_bundle["layers"][0]["item_id"] == item_id
    assert map_bundle["items"] == [
        {"id": item_id, "point_range": [0, 2], "layer_range": [0, 1]}
    ]

    scene = session.resource(item_id, "scene3d")["payload"]["scene3d"]
    assert scene["points"][0]["item_id"] == item_id
    assert scene["layers"][0]["item_id"] == item_id


class Provider:
    def __init__(self):
        self.catalog_calls = 0
        self.resource_calls = 0
        self._lock = threading.Lock()

    def view_catalog(self):
        self.catalog_calls += 1
        return [
            {
                "id": "surface:top",
                "label": "Top",
                "views": {"map": {"producer_option": "kept"}},
                "visible": {"map": True},
            }
        ]

    def view_resource(self, *, item_id, view, lane=None):
        with self._lock:
            self.resource_calls += 1
        return {"map": {"item_id": item_id, "lane": lane}, "schema_version": 4}


class LaneProvider:
    def __init__(self):
        self.calls = []

    def view_catalog(self):
        return [
            {
                "id": "group:interpretation",
                "label": "Interpretation",
                "children": [
                    {
                        "id": "surface:top",
                        "label": "Synthetic Top Alpha",
                        "role": "surface",
                        "views": {
                            "map": {
                                "lanes": [
                                    {"id": "depth", "label": "Depth"},
                                    {"id": "thickness", "label": "Thickness"},
                                ],
                                "active_lane": "depth",
                            },
                            "scene3d": {
                                "lanes": [
                                    {"id": "depth", "label": "Depth"},
                                    {"id": "thickness", "label": "Thickness"},
                                ],
                                "active_lane": "thickness",
                            },
                        },
                        "visible": {"map": True, "scene3d": False},
                    },
                    {
                        "id": "unknown:legacy",
                        "label": "Legacy mystery",
                        "views": {},
                        "disabled": True,
                        "reason": "Unsupported project asset",
                        "diagnostic": {"kind": "legacy_blob", "code": "unsupported"},
                    },
                ],
            }
        ]

    def view_resource(self, *, item_id, view, lane=None):
        self.calls.append((item_id, view, lane))
        return {"schema_version": 4, "map": {"lane": lane}, "scene3d": None}


class DetailProvider:
    def __init__(self):
        self.calls = []

    def view_catalog(self):
        return [{
            "id": "surface:top",
            "label": "Top",
            "views": {"scene3d": {
                "tiers": [
                    {"id": "preview", "label": "Preview"},
                    {"id": "full", "label": "Full detail"},
                ],
                "active_detail": "preview",
            }},
            "visible": {"scene3d": True},
        }]

    def view_resource(self, *, item_id, view, lane=None, detail=None):
        self.calls.append((item_id, view, lane, detail))
        return {"schema_version": 4, "scene3d": {"detail": detail, "meshes": []}}


def _saved_workspace(path):
    text = path.read_text()
    prefix = "<script>window.PETEK_VIEWER_PAYLOAD="
    start = text.index(prefix) + len(prefix)
    end = text.index(';window.PETEK_VIEWER_MODE="file";', start)
    return json.loads(text[start:end])["workspace"]


def test_provider_disabled_leaf_and_ordered_lane_manifest_are_metadata_only():
    provider = LaneProvider()
    session = WorkspaceSession(provider)
    manifest = session.manifest()["workspace"]
    surface, disabled = manifest["tree"][0]["children"]

    assert provider.calls == []
    assert surface["resources"]["map"]["lanes"] == [
        {"id": "depth", "label": "Depth"},
        {"id": "thickness", "label": "Thickness"},
    ]
    assert surface["resources"]["map"]["active_lane"] == "depth"
    assert surface["resources"]["scene3d"]["active_lane"] == "thickness"
    assert disabled == {
        "id": "unknown:legacy",
        "label": "Legacy mystery",
        "role": None,
        "views": [],
        "visible": {},
        "resources": {},
        "disabled": True,
        "reason": "Unsupported project asset",
        "diagnostic": {"kind": "legacy_blob", "code": "unsupported"},
    }
    with pytest.raises(KeyError, match="has no 'map' resource"):
        session.resource("unknown:legacy", "map")


def test_provider_lane_resources_cache_once_and_static_freeze_semantics(tmp_path):
    provider = LaneProvider()
    session = WorkspaceSession(provider)

    first = session.resource("surface:top", "map")
    assert session.resource("surface:top", "map", "depth") == first
    assert session.resource("surface:top", "map", "thickness")["lane"] == "thickness"
    assert provider.calls == [
        ("surface:top", "map", "depth"),
        ("surface:top", "map", "thickness"),
    ]
    with pytest.raises(KeyError, match="has no lane 'missing'"):
        session.resource("surface:top", "map", "missing")

    provider = LaneProvider()
    session = WorkspaceSession(provider)
    visible = tmp_path / "lanes-visible.html"
    session.save(visible)
    frozen = _saved_workspace(visible)
    assert provider.calls == [("surface:top", "map", "depth")]
    assert [resource["lane"] for resource in frozen["resources"]["surface:top"]["map"]] == ["depth"]
    assert "unknown:legacy" not in frozen["resources"]

    selected = tmp_path / "lanes-selected.html"
    session.save(selected, include="selected")
    frozen = _saved_workspace(selected)
    assert provider.calls == [
        ("surface:top", "map", "depth"),
        ("surface:top", "map", "thickness"),
        ("surface:top", "scene3d", "depth"),
        ("surface:top", "scene3d", "thickness"),
    ]
    assert [resource["lane"] for resource in frozen["resources"]["surface:top"]["map"]] == [
        "depth",
        "thickness",
    ]
    assert [resource["lane"] for resource in frozen["resources"]["surface:top"]["scene3d"]] == [
        "depth",
        "thickness",
    ]


def test_scene3d_detail_tiers_cache_independently_and_static_freezes_full(tmp_path):
    provider = DetailProvider()
    session = WorkspaceSession(provider)
    spec = session.manifest()["workspace"]["tree"][0]["resources"]["scene3d"]
    assert spec["tiers"] == [
        {"id": "preview", "label": "Preview"},
        {"id": "full", "label": "Full detail"},
    ]
    assert spec["active_detail"] == "preview"

    preview = session.resource("surface:top", "scene3d")
    assert preview["detail"] == "preview"
    assert session.resource("surface:top", "scene3d", detail="preview") == preview
    full = session.resource("surface:top", "scene3d", detail="full")
    assert full["detail"] == "full"
    assert provider.calls == [
        ("surface:top", "scene3d", None, "preview"),
        ("surface:top", "scene3d", None, "full"),
    ]
    with pytest.raises(KeyError, match="has no detail 'medium'"):
        session.resource("surface:top", "scene3d", detail="medium")

    provider = DetailProvider()
    path = tmp_path / "full-detail.html"
    WorkspaceSession(provider).save(path)
    frozen = _saved_workspace(path)
    resources = frozen["resources"]["surface:top"]["scene3d"]
    assert [resource["detail"] for resource in resources] == ["full"]
    assert provider.calls == [("surface:top", "scene3d", None, "full")]


def test_static_block_map_preserves_contextual_well_overlay_records(tmp_path):
    from petektools.viewer import _blocks

    trajectory = [[1.125, 2.25, 3.5], [4.75, 5.875, -6.0]]
    intersection = {"md": 1234.56789, "xyz": [4.75, 5.875, -6.0]}
    overlay = {
        "context_item_id": "surface:top",
        "well_item_id": "well:one",
        "trajectory": trajectory,
        "intersection": intersection,
        "status": "hit",
    }

    class OverlayProvider:
        def view_catalog(self):
            return [{
                "id": "surface:top",
                "views": {"map": {}},
                "visible": {"map": True},
            }]

        def view_resource(self, *, item_id, view, lane=None):
            map_bundle = {
                "schema_version": 2,
                "frame": {"origin_x": 0.0, "origin_y": 0.0, "spacing_x": 1.0,
                          "spacing_y": 1.0, "ncol": 2, "nrow": 2},
                "outline": [], "grid_lines": [], "points": [], "point_color": None,
                "colormap": "viridis", "layers": [],
                "fills": [{"name": "z", "nodes": [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]],
                           "triangles": [[0, 1, 2]], "values": [1.0, 2.0, 3.0],
                           "range": [1.0, 3.0]}],
                "contours": [], "horizons": [], "zone_averages": [], "k_slices": [],
                "contacts": [], "well_overlays": [overlay],
            }
            assert _blocks.encode_map(map_bundle, threshold_bytes=0)
            return {
                "schema_version": 4,
                "map": map_bundle,
                "wells": [{"id": "One", "item_id": "well:one", "x": 1.125, "y": 2.25,
                           "trajectory": [[1.125, 2.25, 3.5], [9.0, 9.0, -900.0]]}],
            }

    path = tmp_path / "overlay-block-static.html"
    WorkspaceSession(OverlayProvider()).save(path)
    frozen = _saved_workspace(path)
    resource = frozen["resources"]["surface:top"]["map"]
    assert resource["payload"]["map"]["well_overlays"] == [overlay]
    assert resource["payload"]["map"]["well_overlays"][0]["trajectory"] == trajectory
    assert resource["payload"]["map"]["well_overlays"][0]["intersection"] == intersection
    assert resource["payload"]["map"]["blocks"]


def test_workspace_server_forwards_declared_lane_and_caches_it_once():
    provider = LaneProvider()
    session = WorkspaceSession(provider).serve(open_browser=False)
    try:
        manifest = session.manifest()["workspace"]
        href = manifest["tree"][0]["children"][0]["resources"]["map"]["href"]
        url = session.url + href[1:] + "&lane=thickness"
        with urllib.request.urlopen(url) as response:
            first = json.load(response)
        with urllib.request.urlopen(url) as response:
            second = json.load(response)
        assert first == second
        assert first["lane"] == "thickness"
        assert provider.calls == [("surface:top", "map", "thickness")]
    finally:
        session._server.shutdown()
        session._server.server_close()


def test_workspace_server_forwards_scene3d_detail_tier():
    provider = DetailProvider()
    session = WorkspaceSession(provider).serve(open_browser=False)
    try:
        href = session.manifest()["workspace"]["tree"][0]["resources"]["scene3d"]["href"]
        with urllib.request.urlopen(session.url + href[1:] + "&detail=full") as response:
            resource = json.load(response)
        assert resource["detail"] == "full"
        assert provider.calls == [("surface:top", "scene3d", None, "full")]
    finally:
        session._server.shutdown()
        session._server.server_close()


@pytest.mark.parametrize(
    "leaf, message",
    [
        ({"id": "x", "views": {"map": {}}, "disabled": True}, "zero views"),
        ({"id": "x", "views": {"map": {"lanes": []}}}, "must not be empty"),
        (
            {
                "id": "x",
                "views": {"map": {"lanes": [{"id": "z", "label": "Z"}, {"id": "z", "label": "Again"}]}},
            },
            "duplicate workspace map lane ID",
        ),
        (
            {
                "id": "x",
                "views": {"map": {"lanes": [{"id": "z", "label": "Z"}], "active_lane": "missing"}},
            },
            "is not a declared lane",
        ),
        (
            {
                "id": "x",
                "views": {"scene3d": {
                    "tiers": [
                        {"id": "preview", "label": "Preview"},
                        {"id": "full", "label": "Full detail"},
                    ],
                    "active_detail": "full",
                }},
            },
            "active_detail must be 'preview'",
        ),
    ],
)
def test_provider_invalid_disabled_and_lane_catalogs_fail(leaf, message):
    class Invalid(Provider):
        def view_catalog(self):
            return [leaf]

    with pytest.raises((TypeError, ValueError), match=message):
        WorkspaceSession(Invalid())


def test_provider_catalog_and_resource_duck_are_lazy_once_under_concurrency():
    provider = Provider()
    session = WorkspaceSession(provider)
    assert provider.catalog_calls == 1
    assert provider.resource_calls == 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        values = list(
            pool.map(lambda _: session.resource("surface:top", "map", "thickness"), range(16))
        )
    assert provider.resource_calls == 1
    assert all(value == values[0] for value in values)

    session.refresh()
    assert provider.catalog_calls == 2
    session.resource("surface:top", "map", "thickness")
    assert provider.resource_calls == 2


def test_distinct_workspace_resources_materialize_concurrently():
    class SlowProvider:
        def __init__(self):
            self.calls = []
            self.lock = threading.Lock()

        def view_catalog(self):
            return [
                {"id": f"surface:{index}", "views": {"map": {}}, "visible": False}
                for index in range(4)
            ]

        def view_resource(self, *, item_id, view, lane=None):
            with self.lock:
                self.calls.append((item_id, view, lane))
            time.sleep(0.2)
            return {"map": {"item_id": item_id}}

    provider = SlowProvider()
    session = WorkspaceSession(provider)
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=4) as pool:
        values = list(
            pool.map(lambda index: session.resource(f"surface:{index}", "map"), range(4))
        )
    elapsed = time.perf_counter() - started

    assert elapsed < 0.45
    assert len(provider.calls) == 4
    assert [value["item_id"] for value in values] == [
        f"surface:{index}" for index in range(4)
    ]


def test_workspace_resource_failure_isolated_and_retryable():
    class FailingProvider:
        def __init__(self):
            self.calls = {"surface:good": 0, "surface:bad": 0}
            self.fail = True
            self.lock = threading.Lock()

        def view_catalog(self):
            return [
                {"id": item_id, "views": {"map": {}}, "visible": False}
                for item_id in self.calls
            ]

        def view_resource(self, *, item_id, view, lane=None):
            with self.lock:
                self.calls[item_id] += 1
            time.sleep(0.1)
            if item_id == "surface:bad" and self.fail:
                raise RuntimeError("bad surface")
            return {"map": {"item_id": item_id}}

    provider = FailingProvider()
    session = WorkspaceSession(provider)
    with ThreadPoolExecutor(max_workers=2) as pool:
        good = pool.submit(session.resource, "surface:good", "map")
        bad = pool.submit(session.resource, "surface:bad", "map")
        assert good.result()["item_id"] == "surface:good"
        with pytest.raises(RuntimeError, match="bad surface"):
            bad.result()

    assert session.resource("surface:good", "map")["item_id"] == "surface:good"
    provider.fail = False
    assert session.resource("surface:bad", "map")["item_id"] == "surface:bad"
    assert provider.calls == {"surface:good": 1, "surface:bad": 2}


def test_workspace_refresh_does_not_publish_an_obsolete_inflight_resource():
    class RefreshProvider:
        def __init__(self):
            self.version = 1
            self.calls = []
            self.started = threading.Event()
            self.release_old = threading.Event()

        def view_catalog(self):
            return [{"id": "surface:top", "views": {"map": {}}, "visible": False}]

        def view_resource(self, *, item_id, view, lane=None):
            version = self.version
            self.calls.append(version)
            if version == 1:
                self.started.set()
                assert self.release_old.wait(timeout=2.0)
            return {"map": {"version": version}}

    provider = RefreshProvider()
    session = WorkspaceSession(provider)
    with ThreadPoolExecutor(max_workers=2) as pool:
        old = pool.submit(session.resource, "surface:top", "map")
        assert provider.started.wait(timeout=1.0)
        provider.version = 2
        session.refresh()
        new = pool.submit(session.resource, "surface:top", "map")
        assert new.result(timeout=1.0)["payload"]["map"]["version"] == 2
        provider.release_old.set()
        assert old.result(timeout=1.0)["payload"]["map"]["version"] == 1

    assert session.resource("surface:top", "map")["payload"]["map"]["version"] == 2
    assert provider.calls == [1, 2]


def test_resource_failure_is_diagnostic_and_retryable():
    class Flaky(Provider):
        def view_resource(self, **kwargs):
            self.resource_calls += 1
            if self.resource_calls == 1:
                raise RuntimeError("synthetic failure")
            return {"map": {}}

    provider = Flaky()
    session = WorkspaceSession(provider)
    with pytest.raises(RuntimeError, match="synthetic failure"):
        session.resource("surface:top", "map")
    assert session.diagnostics[-1]["error"] == "RuntimeError"
    assert session.resource("surface:top", "map")["payload"] == {"map": {}}
    assert provider.resource_calls == 2


def test_workspace_server_serves_manifest_resources_and_clear_errors():
    provider = Provider()
    session = WorkspaceSession(provider).serve(open_browser=False)
    assert session.url
    with urllib.request.urlopen(session.url + "/model.json") as response:
        manifest = json.load(response)
    assert manifest["workspace"]["schema_version"] == 1
    assert provider.resource_calls == 0

    href = manifest["workspace"]["tree"][0]["resources"]["map"]["href"]
    with urllib.request.urlopen(session.url + href[1:]) as response:
        resource = json.load(response)
    assert resource["item_id"] == "surface:top"
    assert provider.resource_calls == 1

    with pytest.raises(urllib.error.HTTPError) as error:
        urllib.request.urlopen(session.url + "/workspace-resource?item=missing&view=map")
    assert error.value.code == 404
    session._server.shutdown()
    session._server.server_close()


def test_static_visible_and_selected_freezes(tmp_path):
    provider = Provider()
    session = WorkspaceSession(provider)
    visible = tmp_path / "visible.html"
    session.save(visible)
    text = visible.read_text()
    assert '"mode": "static"' in text
    assert "workspace-resource?" in text  # manifest links remain inspectable
    assert "surface:top::map" in text
    assert provider.resource_calls == 1

    selected = tmp_path / "selected.html"
    session.save(selected, include="selected")
    assert selected.exists()
    assert provider.resource_calls == 1  # same once-only cached resource


def test_notebook_style_view_without_serve_and_visible_save(tmp_path):
    points = Points()
    session = pto.view(
        {"Interpretation": {"Picks": {"object": points, "visible": True}}},
        title="Notebook workspace",
        serve=False,
    )
    assert session.url is None
    assert session.tree()[0]["label"] == "Interpretation"
    assert session.manifest()["workspace"]["title"] == "Notebook workspace"
    assert points.calls == 0

    path = tmp_path / "notebook-visible.html"
    session.save(path)
    assert path.exists()
    assert points.calls == 2  # one Map + one 3-D visible resource


def test_2000_leaf_manifest_only_startup_budget():
    catalog = {
        "Interpretation": {
            f"Surface {i}": {"object": Points(f"Surface {i}"), "visible": False}
            for i in range(2000)
        }
    }
    started = time.perf_counter()
    session = pto.view(catalog, serve=False)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    assert len(session.tree()[0]["children"]) == 2000
    assert elapsed_ms < 500.0


def test_2000_leaf_provider_catalog_with_disabled_assets_stays_metadata_only():
    class CatalogProvider(Provider):
        def __init__(self):
            super().__init__()
            self.catalog = [
                {
                    "id": "group:assets",
                    "label": "Assets",
                    "children": [
                        {
                            "id": f"unknown:{i}",
                            "label": f"Unknown {i}",
                            "views": {},
                            "reason": "Unsupported asset",
                        }
                        for i in range(2000)
                    ],
                }
            ]

        def view_catalog(self):
            self.catalog_calls += 1
            return self.catalog

    provider = CatalogProvider()
    started = time.perf_counter()
    session = pto.view(provider, serve=False)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    leaves = session.tree()[0]["children"]
    assert len(leaves) == 2000
    assert all(leaf["disabled"] and leaf["resources"] == {} for leaf in leaves)
    assert provider.resource_calls == 0
    assert elapsed_ms < 500.0


def test_workspace_virtual_tree_uses_css_row_token_and_measured_viewport():
    html = (ASSETS / "index.html").read_text()
    source = _bundle.viewer_js()

    assert "--row-h: 28px" in html
    assert "height: var(--row-h); min-height: var(--row-h)" in html
    assert 'getPropertyValue("--row-h")' in source
    assert "Math.ceil(tree.clientHeight / rowHeight)" in source
    assert "rowHeight = 25" not in source
    assert "viewportRows = 13" not in source


def test_workspace_project_tree_design_contract_is_explicit_and_identity_safe():
    html = (ASSETS / "index.html").read_text()
    source = _bundle.viewer_js()

    # Kind is represented by a stable 16 px SVG registry, never by a clipped
    # text-role badge. Every approved object role and the unknown fallback is
    # named explicitly so additions cannot silently inherit a misleading icon.
    for icon in (
        "surface", "points", "bore", "well", "folderClosed", "folderOpen",
        "tops", "grid", "polygon", "log", "zone", "chart", "unknown",
    ):
        assert f"    {icon}: '" in source
    for role in (
        'surface: "surface"', 'point_set: "points"', 'bore: "bore"',
        'well: "well"', 'well_top: "tops"', 'source_top: "tops"',
        'grid: "grid"', 'volume: "grid"', 'polygon: "polygon"',
        'log: "log"', 'curve: "log"', 'zone: "zone"', 'chart: "chart"',
    ):
        assert role in source
    assert '|| "unknown"' in source
    assert 'data-workspace-icon' in source
    assert "role.slice" not in source
    assert "workspace-role" not in html

    # The single-bore presentation aliases only the label. Its rendered row and
    # every state/action remain keyed by the canonical child leaf. A true
    # multibore group is retained and receives the dedicated well icon.
    assert "function workspaceSingleBore(node)" in source
    assert "node.children.length === 1" in source
    assert 'node.children[0].role === "bore"' in source
    assert "node: node.children[0], label: node.label" in source
    assert "collapsedBore: true" in source
    assert "row.dataset.workspaceId = node.id" in source
    assert "cb.dataset.workspaceItem = node.id" in source
    assert 'idColor("item:" + node.id)' in source
    assert "children.length > 1 && children.every" in source
    assert 'return "well"' in source
    assert "if (workspaceBoreGroup(child)) break" in source

    # Hierarchy, states, metadata, and view-scoped actions are CSS/DOM contracts
    # while the existing ARIA tree and virtual row geometry remain intact.
    for selector in (
        ".workspace-rail::before", ".workspace-rail-last::after",
        ".workspace-selected::before", ".workspace-loading .workspace-icon",
        ".workspace-error .workspace-label", ".workspace-unavailable",
        ".workspace-meta", ".workspace-count", ".workspace-paint",
        ".workspace-isolate", ".workspace-spinner", ".workspace-tree-footer",
        ".workspace-project-title::after",
    ):
        assert selector in html
    assert ".workspace-lane-select { width: 132px" in html
    assert 'tree.setAttribute("role", "tree")' in source
    assert 'row.setAttribute("role", "treeitem")' in source
    assert 'row.setAttribute("aria-level"' in source
    assert 'row.setAttribute("aria-expanded"' in source
    assert 'row.setAttribute("aria-selected"' in source
    assert 'row.tabIndex = W.focusedTreeId === node.id ? 0 : -1' in source
    for key in ("ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End", "Enter"):
        assert f'key === "{key}"' in source
    assert 'key === " "' in source
    assert "function focusFlatIndex(index)" in source
    assert "renderVirtualWindow();" in source
    assert '"Visibility applies to "' in source
    assert 'setWorkspaceViewSelection(view, [])' in source
    assert "function workspaceViewSupportsSelectionControls(view)" in source
    assert 'view === "map" || view === "scene3d" || view === "wells"' in source
    assert 'if (selectionSupported)' in source
    assert 'else cb = el("span", "workspace-checkbox-spacer")' in source
    assert 'else if (selectionSupported && workspaceItemHasView(node.id, view))' in source
    assert "activeColorBy" in source and "activeLane" in source
    assert "window.__PETEK_WORKSPACE_STATE" in source
    assert "var projectBacked = !!(W && W.manifest.project)" in source
    assert "var showsPersistedProject = !!(persistedProjectTitle && title === persistedProjectTitle)" in source
    assert 'titleEl.dataset.projectSuffix = showsPersistedProject ? ".pproj" : ""' in source


def test_workspace_shell_has_separate_semantic_regions_and_bounded_preferences():
    html = (ASSETS / "index.html").read_text()
    source = _bundle.viewer_js()

    assert html.index('id="navigator"') < html.index('id="view"') < html.index('id="panel"')
    assert 'aria-labelledby="navigator-heading"' in html
    assert 'aria-labelledby="inspector-heading"' in html
    assert 'id="statusbar"' in html and 'role="status"' in html
    assert 'id="shortcut-help"' in html and 'role="dialog"' in html
    assert 'role="separator"' in html

    # Workspace mode is additive: the class and capability pruning are applied
    # only after a workspace manifest exists; legacy typed payloads retain the
    # historic two-region shell and tabs.
    assert 'if (!W) return;\n    root.classList.add("workspace-shell")' in source
    assert 'button.hidden = !workspaceTabAvailable(tab)' in source
    assert 'buildWorkspaceNavigator();\n    buildPanel();' in source
    panel_boot = (ASSETS / "viewer" / "80-panel-boot.js").read_text()
    assert "buildWorkspaceTree(body)" not in panel_boot


def test_map_and_section_share_one_inspector_legend_truth():
    html = (ASSETS / "index.html").read_text()
    source = _bundle.viewer_js()
    panel = (ASSETS / "viewer" / "80-panel-boot.js").read_text()
    inspector = (ASSETS / "viewer" / "72-inspector-legend.js").read_text()

    assert 'group("Layers & legend")' in panel
    assert "buildMapInspectorLegend(t)" in panel
    assert "buildSectionInspectorLegend(t)" in panel
    assert "gridInfoGroup" not in panel
    assert "drawFieldLegend" not in source
    assert "clearInspectorOwnedPlotLegend()" in source
    assert 'if (!_mapHotFrame) clearInspectorOwnedPlotLegend()' in source
    assert "COLORMAP_NAMES.forEach" in inspector
    assert 'setAttribute("role", "listbox")' in inspector
    assert 'setAttribute("aria-selected"' in inspector
    assert "colormap_reversed" in inspector
    assert 'S.colormap + "|" + !!S.colormapReversed' in source
    assert "paintReversed(fill)" in source
    assert 'hasOwnProperty.call(l, "colormap")' in source
    assert 'hasOwnProperty.call(l, "colormap_reversed")' in source
    assert "colormap_reversed: !!l.colormap_reversed" not in source
    assert 'event.key === "Escape"' in inspector
    assert 'event.key === "Enter"' in inspector
    assert "if (a > b)" in inspector
    assert "!isFinite(a) || !isFinite(b) || a === b" in inspector
    assert 'lo.value.trim() === "" || hi.value.trim() === ""' in inspector
    assert "document.addEventListener(\"pointerdown\", outside, true)" in inspector
    assert "INSPECTOR_ENTITY_CAP = 6" in inspector
    assert 'dataset.legendKind = "categorical"' in inspector
    assert ".inspector-range-edit" in html
    assert "[hidden] { display: none !important; }" in html
    # The old word-only selector survives for legacy tabs but is removed from
    # Map/Intersection; their ramp is the rendered control.
    map_panel = panel[panel.index("function buildMapPanel"):panel.index("function buildSectionPanel")]
    section_panel = panel[panel.index("function buildSectionPanel"):panel.index("function buildVolumePanel")]
    assert "colormapRow()" not in map_panel
    assert "colormapRow()" not in section_panel
    assert "colormapRow()" in panel[panel.index("function buildVolumePanel"):]
    assert "function drawVolumeLegend()" in source
    assert "function drawChartLegend(ch)" in source
    assert "S.pointLayerVis" in source
    assert "pointLayers.forEach" in inspector
    assert "pointLayer._legacy ? null : pointLayer" in inspector
    assert "mapAggregateDescriptorLabel" in inspector
    assert 'label: "Horizons"' in inspector and 'label: "Contacts"' in inspector
    assert "sectionHasZoneData(b)" in inspector and "sectionHasZoneData(b)" in panel
    assert 'units: b.units' in inspector and 'b.units || "fraction"' not in inspector
    assert "(m.outline || []).length" in inspector


def test_async_viewer_paint_completions_are_request_keyed():
    source = _bundle.viewer_js()
    decode = (ASSETS / "decode.js").read_text()

    assert 'requestId: m.requestId, paintKey: m.paintKey' in decode
    assert '_volumeDecodeRequestId' in source and '_volumeRecolorRequestId' in source
    assert "function paintCompletionState(" in source
    assert 'completion === "stale-request"' in source
    assert 'completion === "stale-paint"' in source
    assert 'paintCompletionState(requestId, vol3._recolorRequestId' in source
    assert 'pending.paintKey, s3dMeshPaintKey(pending.m)' in source
    assert 'entry.paintKey !== s3dMeshPaintKey(entry.m)' in source
    assert 'built._colormapKey = S.colormap + "|" + !!S.colormapReversed' in source

    # Persistence is deliberately UI-only: no manifest, visibility, lane, or
    # producer data is serialized into browser storage.
    assert 'localStorage.setItem(UI_PREF_KEY, JSON.stringify(safe))' in source
    assert "navigatorWidth" in source and "inspectorWidth" in source
    pref_source = source[source.index("function saveUiPrefs") : source.index("function boundedPanelWidth")]
    assert all(token not in pref_source for token in ("manifest", "visible", "activeLane", "resources"))


def test_workspace_shell_declares_keyboard_and_accessibility_contract():
    html = (ASSETS / "index.html").read_text()
    source = _bundle.viewer_js()

    for shortcut in ('event.key === "/"', 'event.key === "?"', '/^[123]$/', 'toLowerCase() === "f"'):
        assert shortcut in source
    assert 'setAttribute("aria-controls"' in source
    assert 'setAttribute("aria-labelledby"' in source
    assert 'setAttribute("aria-expanded"' in source
    assert 'setAttribute("aria-label", "Search project")' in source
    assert ':focus-visible' in html
    assert 'id="shortcut-close"' in html
    assert 'id="navigator-toggle"' in html and 'aria-label="Toggle Project navigator"' in html
    assert 'id="inspector-toggle"' in html and 'aria-label="Toggle Inspector"' in html
    assert 'id="help-toggle"' in html and 'aria-label="Keyboard shortcuts"' in html
    assert 'narrowPanel:' in source
    assert 'if (open && isNarrowWorkspace())' in source
    assert 'applyResponsivePanelState()' in source
    assert 'id="button-tooltip"' in html and 'role="tooltip"' in html
    assert 'function wireButtonTooltips()' in source
    assert 'button.removeAttribute("title")' in source
    assert 'W.expansionManual[group.id] = true' in source
