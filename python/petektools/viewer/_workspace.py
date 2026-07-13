"""Generic project-workspace contract and normalization.

The workspace is deliberately a renderer concern, not a project model.  It
accepts either an insertion-ordered Python tree or a provider implementing the
small ``view_catalog()`` / ``view_resource()`` duck.  No managed-library type is
imported and normalization never calls a heavy render method.
"""

from __future__ import annotations

import copy
import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence
from urllib.parse import quote


_VIEW_NAMES = frozenset({"map", "scene3d", "wells", "sections", "volume", "charts"})
_DEFERRED_VIEWS = frozenset({"map", "scene3d", "wells"})
_MAP_OPTIONS = frozenset(
    {
        "color",
        "fill",
        "contours",
        "max_grid_lines",
        "max_line_points",
        "point_limit",
        "max_mesh_edges",
        "lod",
        "encoding",
        "block_threshold_bytes",
    }
)
_SCENE3D_OPTIONS = frozenset(
    {
        "color",
        "fill",
        "contours",
        "max_grid_lines",
        "max_line_points",
        "point_limit",
        "max_mesh_edges",
        "z_exaggeration",
    }
)
_ITEM_KEYS = frozenset({"object", "id", "label", "visible", "views", "role"})
_PROVIDER_ITEM_KEYS = _ITEM_KEYS | frozenset({"disabled", "reason", "diagnostic"})
_LANE_KEYS = frozenset({"id", "label"})


@dataclass(frozen=True, slots=True)
class WorkspaceGroup:
    """One immutable group in a normalized workspace tree."""

    id: str
    label: str
    children: tuple["WorkspaceNode", ...]
    # None delegates the initial expansion policy to the viewer (selected path
    # plus small, actionable branches). A bool is an explicit author override.
    expanded: bool | None = None

    def to_dict(self) -> dict[str, Any]:
        value = {
            "id": self.id,
            "label": self.label,
            "children": [child.to_dict() for child in self.children],
        }
        if self.expanded is not None:
            value["expanded"] = self.expanded
        return value


@dataclass(frozen=True, slots=True)
class WorkspaceItem:
    """One immutable leaf in a normalized workspace tree."""

    id: str
    label: str
    views: tuple[tuple[str, tuple[tuple[str, Any], ...]], ...]
    visible: tuple[tuple[str, bool], ...]
    role: str | None = None
    lanes: tuple[tuple[str, tuple[tuple[str, str], ...]], ...] = ()
    active_lanes: tuple[tuple[str, str], ...] = ()
    disabled: bool = False
    reason: str | None = None
    diagnostic: Any = None

    def view_options(self, view: str) -> dict[str, Any]:
        for name, options in self.views:
            if name == view:
                return dict(options)
        raise KeyError(view)

    def visible_in(self, view: str) -> bool:
        return dict(self.visible).get(view, False)

    def lanes_for(self, view: str) -> tuple[tuple[str, str], ...]:
        return dict(self.lanes).get(view, ())

    def active_lane(self, view: str) -> str | None:
        return dict(self.active_lanes).get(view)

    def to_dict(self) -> dict[str, Any]:
        resources = {}
        for name, _ in self.views:
            spec: dict[str, Any] = {
                "href": "./workspace-resource?item=" + quote(self.id, safe="")
                + "&view="
                + quote(name, safe=""),
                "deferred": name in _DEFERRED_VIEWS,
            }
            lanes = self.lanes_for(name)
            if lanes:
                spec["lanes"] = [
                    {"id": lane_id, "label": label} for lane_id, label in lanes
                ]
                spec["active_lane"] = self.active_lane(name)
            resources[name] = spec
        value = {
            "id": self.id,
            "label": self.label,
            "role": self.role,
            "views": [name for name, _ in self.views],
            "visible": dict(self.visible),
            "resources": resources,
            "disabled": self.disabled,
        }
        if self.reason is not None:
            value["reason"] = self.reason
        if self.diagnostic is not None:
            value["diagnostic"] = copy.deepcopy(self.diagnostic)
        return value


WorkspaceNode = WorkspaceGroup | WorkspaceItem


def _empty_payload(title: str) -> dict[str, Any]:
    return {
        "schema_version": 4,
        "kind": "workspace",
        "property": title,
        "properties": [],
        "summary": None,
        "map": None,
        "volume": None,
        "scene3d": None,
        "sections": [],
        "section_labels": [],
        "wells": [],
        "wells_logs": None,
        "charts": [],
    }


def _payload_object(payload: str | Mapping[str, Any] | None, title: str) -> dict[str, Any]:
    if payload is None:
        return _empty_payload(title)
    value = json.loads(payload) if isinstance(payload, str) else copy.deepcopy(dict(payload))
    if not isinstance(value, dict):
        raise TypeError("payload must decode to a JSON object")
    return value


def _segment(value: Any) -> str:
    text = str(value)
    if not text or text != text.strip():
        raise ValueError("workspace mapping keys must be non-empty, trimmed strings")
    return quote(text, safe="-._~")


def _stable_path(kind: str, path: tuple[str, ...]) -> str:
    return kind + ":" + "/".join(_segment(part) for part in path)


def _plain_label(obj: Any) -> str | None:
    for key in ("display_name", "name", "id"):
        value = getattr(obj, key, None)
        if value is not None and not callable(value):
            text = str(value)
            if text:
                return text
    return None


def _normalise_lanes(
    value: Any, *, view: str
) -> tuple[tuple[str, str], ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise TypeError(f"workspace {view} lanes must be an ordered list")
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for index, lane in enumerate(value):
        if not isinstance(lane, Mapping):
            raise TypeError(f"workspace {view} lane {index} must be a mapping")
        unknown = set(lane) - _LANE_KEYS
        if unknown:
            raise ValueError(f"unknown workspace lane key(s) {sorted(unknown)}")
        lane_id = lane.get("id")
        if not isinstance(lane_id, str) or not lane_id or lane_id != lane_id.strip():
            raise ValueError("workspace lane IDs must be non-empty, trimmed strings")
        if lane_id in seen:
            raise ValueError(f"duplicate workspace {view} lane ID {lane_id!r}")
        label = lane.get("label")
        if not isinstance(label, str) or not label or label != label.strip():
            raise ValueError("workspace lane labels must be non-empty, trimmed strings")
        seen.add(lane_id)
        out.append((lane_id, label))
    if not out:
        raise ValueError(f"workspace {view} lanes must not be empty")
    return tuple(out)


def _normalise_views(
    value: Any, *, provider: bool
) -> tuple[
    tuple[tuple[str, tuple[tuple[str, Any], ...]], ...],
    tuple[tuple[str, tuple[tuple[str, str], ...]], ...],
    tuple[tuple[str, str], ...],
]:
    if value is None:
        names: Mapping[str, Any] = {"map": {}, "scene3d": {}}
    elif isinstance(value, Mapping):
        names = value
    elif isinstance(value, (str, bytes)):
        names = {str(value): {}}
    elif isinstance(value, Iterable):
        names = {str(name): {} for name in value}
    else:
        raise TypeError("workspace item views must be a mapping or iterable of view names")

    out: list[tuple[str, tuple[tuple[str, Any], ...]]] = []
    lanes_out: list[tuple[str, tuple[tuple[str, str], ...]]] = []
    active_out: list[tuple[str, str]] = []
    for raw_name, raw_options in names.items():
        name = str(raw_name)
        if name not in _VIEW_NAMES:
            raise ValueError(f"unknown workspace view {name!r}; expected one of {sorted(_VIEW_NAMES)}")
        if raw_options is False or raw_options is None:
            if raw_options is False:
                continue
            options: dict[str, Any] = {}
        elif raw_options is True:
            options = {}
        elif isinstance(raw_options, Mapping):
            options = dict(raw_options)
        else:
            raise TypeError(f"workspace view {name!r} options must be a mapping or bool")
        raw_lanes = options.pop("lanes", None)
        active_lane = options.pop("active_lane", None)
        default_lane = options.pop("default_lane", None)
        if active_lane is not None and default_lane is not None and active_lane != default_lane:
            raise ValueError(
                f"workspace {name} active_lane and default_lane must match when both are set"
            )
        active_lane = active_lane if active_lane is not None else default_lane
        if (raw_lanes is not None or active_lane is not None) and not provider:
            raise ValueError("workspace lanes are available only on provider catalog items")
        lanes = _normalise_lanes(raw_lanes, view=name) if raw_lanes is not None else ()
        if active_lane is not None and not lanes:
            raise ValueError(f"workspace {name} active_lane requires declared lanes")
        if lanes:
            lane_ids = {lane_id for lane_id, _ in lanes}
            if active_lane is None:
                active_lane = lanes[0][0]
            if not isinstance(active_lane, str) or active_lane not in lane_ids:
                raise ValueError(
                    f"workspace {name} active_lane {active_lane!r} is not a declared lane"
                )
            lanes_out.append((name, lanes))
            active_out.append((name, active_lane))
        allowed = _MAP_OPTIONS if name == "map" else _SCENE3D_OPTIONS if name == "scene3d" else frozenset()
        unknown = set(options) - allowed
        if unknown and not provider:
            raise ValueError(
                f"unsupported {name} workspace option(s) {sorted(unknown)}; "
                f"expected a subset of {sorted(allowed)}"
            )
        out.append((name, tuple(options.items())))
    if not out and not provider:
        raise ValueError("workspace item must enable at least one view")
    return tuple(out), tuple(lanes_out), tuple(active_out)


def _normalise_visible(value: Any, views: tuple[tuple[str, Any], ...]) -> tuple[tuple[str, bool], ...]:
    names = [name for name, _ in views]
    if value is None:
        return tuple((name, True) for name in names)
    if isinstance(value, bool):
        return tuple((name, value) for name in names)
    if not isinstance(value, Mapping):
        raise TypeError("workspace item visible must be bool or a per-view mapping")
    unknown = set(value) - set(names)
    if unknown:
        raise ValueError(f"visible names views not enabled by this item: {sorted(unknown)}")
    return tuple((name, bool(value.get(name, False))) for name in names)


class _Normalizer:
    def __init__(self, *, provider: bool) -> None:
        self.provider = provider
        self.ids: set[str] = set()
        self.objects: dict[str, Any] = {}
        self._containers: set[int] = set()

    def _claim(self, item_id: str) -> str:
        if not isinstance(item_id, str) or not item_id or item_id != item_id.strip():
            raise ValueError("workspace IDs must be non-empty, trimmed strings")
        if item_id in self.ids:
            raise ValueError(f"duplicate workspace ID {item_id!r}")
        self.ids.add(item_id)
        return item_id

    def roots(self, value: Any) -> tuple[WorkspaceNode, ...]:
        if isinstance(value, Mapping) and not ("object" in value or "children" in value):
            return self._mapping(value, ())
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            return self._sequence(value, ())
        raise TypeError("workspace root must be an ordered mapping or list of explicit nodes")

    def _enter(self, value: Any) -> None:
        marker = id(value)
        if marker in self._containers:
            raise ValueError("workspace tree contains a cycle")
        self._containers.add(marker)

    def _leave(self, value: Any) -> None:
        self._containers.remove(id(value))

    def _mapping(self, value: Mapping[Any, Any], path: tuple[str, ...]) -> tuple[WorkspaceNode, ...]:
        self._enter(value)
        try:
            out = []
            for raw_label, child in value.items():
                label = str(raw_label)
                child_path = (*path, label)
                provider_leaf = self.provider and isinstance(child, Mapping) and bool(
                    set(child) & (_PROVIDER_ITEM_KEYS - {"label"})
                )
                if (
                    isinstance(child, Mapping)
                    and "object" not in child
                    and "children" not in child
                    and not provider_leaf
                ):
                    children = self._mapping(child, child_path)
                    out.append(
                        WorkspaceGroup(
                            self._claim(_stable_path("group", child_path)), label, children
                        )
                    )
                elif isinstance(child, Sequence) and not isinstance(child, (str, bytes)):
                    children = self._sequence(child, child_path)
                    out.append(
                        WorkspaceGroup(
                            self._claim(_stable_path("group", child_path)), label, children
                        )
                    )
                else:
                    out.append(self._leaf(child, child_path, label))
            return tuple(out)
        finally:
            self._leave(value)

    def _sequence(self, value: Sequence[Any], path: tuple[str, ...]) -> tuple[WorkspaceNode, ...]:
        self._enter(value)
        try:
            out = []
            for child in value:
                if not isinstance(child, Mapping):
                    raise TypeError("list workspace children must be explicit node mappings with an id")
                if "children" in child:
                    node_id = self._claim(str(child.get("id", "")))
                    label = str(child.get("label") or node_id)
                    children_value = child["children"]
                    if isinstance(children_value, Mapping):
                        children = self._mapping(children_value, (*path, node_id))
                    elif isinstance(children_value, Sequence) and not isinstance(children_value, (str, bytes)):
                        children = self._sequence(children_value, (*path, node_id))
                    else:
                        raise TypeError("workspace group children must be a mapping or list")
                    expanded = child.get("expanded")
                    if expanded is not None and not isinstance(expanded, bool):
                        raise TypeError("workspace group expanded must be a bool")
                    out.append(WorkspaceGroup(node_id, label, children, expanded))
                else:
                    if "id" not in child:
                        raise ValueError("list workspace leaves require an explicit stable id")
                    out.append(self._leaf(child, path, str(child.get("label") or child["id"])))
            return tuple(out)
        finally:
            self._leave(value)

    def _leaf(self, value: Any, path: tuple[str, ...], fallback_label: str) -> WorkspaceItem:
        if isinstance(value, Mapping):
            allowed_keys = _PROVIDER_ITEM_KEYS if self.provider else _ITEM_KEYS
            unknown = set(value) - allowed_keys
            if unknown:
                raise ValueError(f"unknown workspace item key(s) {sorted(unknown)}")
            obj = value.get("object")
            if obj is None and not self.provider:
                raise TypeError("an explicit workspace leaf must carry a non-null 'object'")
            explicit_id = value.get("id")
            label = str(value.get("label") or fallback_label)
            raw_views = value.get("views")
            raw_visible = value.get("visible")
            role = value.get("role")
            raw_disabled = value.get("disabled")
            reason = value.get("reason")
            diagnostic = value.get("diagnostic")
        else:
            if self.provider:
                raise TypeError("provider catalog leaves must be explicit mappings")
            obj = value
            explicit_id = None
            label = fallback_label or _plain_label(obj) or ""
            raw_views = None
            raw_visible = None
            role = None
            raw_disabled = None
            reason = None
            diagnostic = None
        if not label:
            raise ValueError("workspace leaves require a non-empty label")
        item_id = self._claim(str(explicit_id) if explicit_id is not None else _stable_path("item", path))
        views, lanes, active_lanes = _normalise_views(
            raw_views, provider=self.provider
        )
        disabled = not views
        if raw_disabled is not None:
            if not isinstance(raw_disabled, bool):
                raise TypeError("workspace disabled must be bool")
            if raw_disabled and views:
                raise ValueError("disabled workspace items must declare zero views")
            if not raw_disabled and disabled:
                raise ValueError("workspace items with zero views are disabled")
            disabled = raw_disabled
        if reason is not None:
            if not isinstance(reason, str) or not reason or reason != reason.strip():
                raise ValueError("workspace disabled reason must be a non-empty, trimmed string")
        if diagnostic is not None:
            try:
                json.dumps(diagnostic)
            except (TypeError, ValueError) as exc:
                raise TypeError("workspace diagnostic must be JSON-serializable") from exc
            diagnostic = copy.deepcopy(diagnostic)
        visible = _normalise_visible(raw_visible, views)
        if not self.provider:
            self.objects[item_id] = obj
        return WorkspaceItem(
            id=item_id,
            label=label,
            views=views,
            visible=visible,
            role=str(role) if role is not None else None,
            lanes=lanes,
            active_lanes=active_lanes,
            disabled=disabled,
            reason=reason,
            diagnostic=diagnostic,
        )


def _walk_items(nodes: Iterable[WorkspaceNode]) -> Iterable[WorkspaceItem]:
    for node in nodes:
        if isinstance(node, WorkspaceItem):
            yield node
        else:
            yield from _walk_items(node.children)


def _apply_visible_override(
    nodes: tuple[WorkspaceNode, ...], visible: Any
) -> tuple[WorkspaceNode, ...]:
    if visible is None:
        return nodes
    items = tuple(_walk_items(nodes))
    by_id = {item.id: item for item in items}
    by_label: dict[str, list[str]] = {}
    for item in items:
        by_label.setdefault(item.label, []).append(item.id)

    def resolve(selector: Any) -> str:
        key = str(selector)
        if key in by_id:
            return key
        matches = by_label.get(key, [])
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise ValueError(f"ambiguous visible selector {key!r}; use a canonical workspace ID")
        raise KeyError(f"unknown visible selector {key!r}")

    selected: dict[str, set[str]] = {}
    if isinstance(visible, Mapping):
        for view, selectors in visible.items():
            if view not in _VIEW_NAMES:
                raise ValueError(f"unknown visible view {view!r}")
            values = [selectors] if isinstance(selectors, (str, bytes)) else list(selectors)
            selected[str(view)] = {resolve(value) for value in values}
    else:
        values = [visible] if isinstance(visible, (str, bytes)) else list(visible)
        ids = {resolve(value) for value in values}
        for view in _VIEW_NAMES:
            selected[view] = set(ids)

    def replace(node: WorkspaceNode) -> WorkspaceNode:
        if isinstance(node, WorkspaceGroup):
            return WorkspaceGroup(node.id, node.label, tuple(replace(ch) for ch in node.children), node.expanded)
        vis = tuple((view, node.id in selected.get(view, set())) for view, _ in node.visible)
        return WorkspaceItem(
            id=node.id,
            label=node.label,
            views=node.views,
            visible=vis,
            role=node.role,
            lanes=node.lanes,
            active_lanes=node.active_lanes,
            disabled=node.disabled,
            reason=node.reason,
            diagnostic=copy.deepcopy(node.diagnostic),
        )

    return tuple(replace(node) for node in nodes)


class WorkspaceSession:
    """Inspectable workspace session returned by :func:`view`.

    The catalog is immutable for the lifetime of one snapshot.  ``refresh()``
    explicitly rebuilds it from the original tree/provider.  Resource values are
    constructed on first request and cached once per ``(item_id, view, lane)``.
    """

    def __init__(
        self,
        source: Any,
        *,
        title: str = "Project workspace",
        visible: Any = None,
        tab: str = "auto",
        payload: str | Mapping[str, Any] | None = None,
    ) -> None:
        if tab != "auto" and tab not in _VIEW_NAMES:
            raise ValueError(f"unknown initial tab {tab!r}")
        self._source = source
        self._title = str(title)
        self._visible_override = visible
        self._tab = tab
        self._base_payload = _payload_object(payload, self._title)
        self._lock = threading.RLock()
        self._cache: dict[tuple[str, str, str | None], dict[str, Any]] = {}
        self._diagnostics: list[dict[str, Any]] = []
        self._url: str | None = None
        self._server: Any = None
        self._provider = callable(getattr(source, "view_catalog", None)) and callable(
            getattr(source, "view_resource", None)
        )
        self._nodes: tuple[WorkspaceNode, ...] = ()
        self._items: dict[str, WorkspaceItem] = {}
        self._objects: dict[str, Any] = {}
        self._snapshot()

    def _snapshot(self) -> None:
        catalog = self._source.view_catalog() if self._provider else self._source
        normalizer = _Normalizer(provider=self._provider)
        nodes = _apply_visible_override(normalizer.roots(catalog), self._visible_override)
        items = {item.id: item for item in _walk_items(nodes)}
        if not items:
            raise ValueError("workspace catalog contains no leaves")
        self._nodes = nodes
        self._items = items
        self._objects = normalizer.objects

    @property
    def url(self) -> str | None:
        return self._url

    @property
    def diagnostics(self) -> tuple[dict[str, Any], ...]:
        return tuple(copy.deepcopy(self._diagnostics))

    def tree(self) -> list[dict[str, Any]]:
        """Return a detached JSON-shaped copy of the normalized ordered tree."""
        return [node.to_dict() for node in self._nodes]

    def manifest(self) -> dict[str, Any]:
        """Return the additive workspace-v1 top-level render envelope."""
        payload = copy.deepcopy(self._base_payload)
        available = []
        for item in self._items.values():
            for view, _ in item.views:
                if view not in available:
                    available.append(view)
        payload["workspace"] = {
            "schema_version": 1,
            "title": self._title,
            "tree": self.tree(),
            "available_views": available,
            "initial_tab": self._tab,
            "mode": "live",
        }
        return payload

    def refresh(self) -> "WorkspaceSession":
        """Replace the catalog snapshot and clear all materialized resources."""
        with self._lock:
            self._snapshot()
            self._cache.clear()
            self._diagnostics.clear()
        return self

    def _materializer(
        self, item: WorkspaceItem, view: str, lane: str | None
    ) -> Callable[[], Any]:
        if self._provider:
            return lambda: self._source.view_resource(
                item_id=item.id, view=view, lane=lane
            )
        obj = self._objects[item.id]
        options = item.view_options(view)
        if lane is not None:
            options["fill"] = lane
        if view == "map":
            from ._view2d import view2d_payload

            return lambda: view2d_payload(
                [{"object": obj, "id": item.id, "name": item.label}],
                title=self._title,
                **options,
            )
        if view == "scene3d":
            from ._view3d import view3d_payload

            return lambda: view3d_payload(
                [{"object": obj, "id": item.id, "name": item.label}],
                title=self._title,
                **options,
            )
        raise TypeError(
            f"generic object item {item.id!r} cannot materialize {view!r}; "
            "supply that typed bundle through payload= or a view provider"
        )

    def resource(self, item_id: str, view: str, lane: str | None = None) -> dict[str, Any]:
        """Materialize and cache one typed leaf/view resource."""
        if item_id not in self._items:
            raise KeyError(f"unknown workspace item {item_id!r}")
        item = self._items[item_id]
        if item.disabled or view not in dict(item.views):
            raise KeyError(f"workspace item {item_id!r} has no {view!r} resource")
        lanes = item.lanes_for(view)
        if lanes:
            lane = item.active_lane(view) if lane is None else lane
            declared = {lane_id for lane_id, _ in lanes}
            if lane not in declared:
                raise KeyError(
                    f"workspace item {item_id!r} view {view!r} has no lane {lane!r}"
                )
        key = (item_id, view, lane)
        with self._lock:
            cached = self._cache.get(key)
            if cached is not None:
                return copy.deepcopy(cached)
            try:
                value = self._materializer(item, view, lane)()
                if isinstance(value, str):
                    value = json.loads(value)
                if not isinstance(value, Mapping):
                    raise TypeError("workspace resource provider must return a mapping or JSON object")
                result = {
                    "schema_version": 1,
                    "kind": "workspace_resource",
                    "item_id": item_id,
                    "view": view,
                    "lane": lane,
                    "payload": copy.deepcopy(dict(value)),
                }
                self._cache[key] = result
                return copy.deepcopy(result)
            except Exception as exc:
                self._diagnostics.append(
                    {
                        "item_id": item_id,
                        "view": view,
                        "lane": lane,
                        "error": type(exc).__name__,
                        "message": str(exc),
                    }
                )
                raise

    # The live/static methods are completed by the delivery layer below; keeping
    # them here makes the session contract inspectable from its first release.
    def serve(self, **kwargs: Any) -> "WorkspaceSession":
        from ._server import serve_workspace

        self._server, self._url = serve_workspace(self, **kwargs)
        return self

    def save(self, path: str | Path, *, include: str = "visible") -> "WorkspaceSession":
        from ._save import save_workspace

        save_workspace(self, path, include=include)
        return self


def view(
    tree_or_source: Any,
    *,
    title: str = "Project workspace",
    visible: Any = None,
    tab: str = "auto",
    payload: str | Mapping[str, Any] | None = None,
    save: str | Path | None = None,
    serve: bool = True,
    port: int = 0,
    block: bool = False,
    open_browser: bool = True,
) -> WorkspaceSession:
    """Open a lazy multi-view workspace over a generic tree or provider duck."""
    session = WorkspaceSession(
        tree_or_source, title=title, visible=visible, tab=tab, payload=payload
    )
    if save is not None:
        return session.save(save)
    if not serve:
        return session
    return session.serve(port=port, block=block, open_browser=open_browser)


__all__ = ["WorkspaceGroup", "WorkspaceItem", "WorkspaceSession", "view"]
