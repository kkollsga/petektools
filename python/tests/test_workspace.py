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


class Points:
    kind = "point_set"

    def __init__(self, name="Picks"):
        self.name = name
        self.calls = 0

    def xyz(self):
        self.calls += 1
        return [[0.0, 0.0, -1.0], [1.0, 1.0, -2.0]]


def test_nested_tree_normalizes_without_materializing():
    top = Points("Top Agat")
    base = Points("Base Agat")
    session = WorkspaceSession(
        {
            "Interpretation": {
                "Surfaces": {
                    "Top Agat": {"object": top, "visible": True},
                    "Base Agat": {"object": base, "visible": False},
                }
            }
        }
    )

    assert top.calls == base.calls == 0
    tree = session.tree()
    leaves = tree[0]["children"][0]["children"]
    assert [leaf["id"] for leaf in leaves] == [
        "item:Interpretation/Surfaces/Top%20Agat",
        "item:Interpretation/Surfaces/Base%20Agat",
    ]
    assert leaves[0]["visible"] == {"map": True, "scene3d": True}
    assert leaves[1]["visible"] == {"map": False, "scene3d": False}
    manifest = session.manifest()["workspace"]
    assert manifest["schema_version"] == 1
    assert manifest["available_views"] == ["map", "scene3d"]


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
