"""Generic project-workspace contract and normalization.

The workspace is deliberately a renderer concern, not a project model.  It
accepts either an insertion-ordered Python tree or a provider implementing the
small ``view_catalog()`` / ``view_resource()`` duck.  No managed-library type is
imported and normalization never calls a heavy render method.
"""

from __future__ import annotations

import copy
import base64
import hashlib
import json
import math
import re
import struct
import threading
from dataclasses import dataclass, field
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
_TIER_KEYS = frozenset({"id", "label"})
_ATTRIBUTE_KEYS = frozenset({"id", "label", "kind", "units", "codes"})
_CODE_KEYS = frozenset({"label", "color"})
_PROJECT_KEYS = frozenset({"title", "crs", "unit"})
_SHARED_TRANSPORT = "shared"
_INTEGER_CODE = re.compile(r"(?:0|-?[1-9][0-9]*)\Z")
_COLORMAPS = frozenset(
    {
        "viridis",
        "inferno",
        "magma",
        "plasma",
        "cividis",
        "turbo",
        "coolwarm",
        "greys",
        "grays",
    }
)


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
    details: tuple[tuple[str, tuple[tuple[str, str], ...]], ...] = ()
    active_details: tuple[tuple[str, str], ...] = ()
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

    def details_for(self, view: str) -> tuple[tuple[str, str], ...]:
        return dict(self.details).get(view, ())

    def active_detail(self, view: str) -> str | None:
        return dict(self.active_details).get(view)

    def attributes_for(self, view: str) -> tuple[dict[str, Any], ...]:
        raw = self.view_options(view).get("attributes") or ()
        return tuple(copy.deepcopy(raw))

    def active_attribute(self, view: str) -> str | None:
        return self.view_options(view).get("active_attribute")

    def active_color_by(self, view: str) -> str | None:
        return self.view_options(view).get("active_color_by")

    def transport_for(self, view: str) -> str | None:
        return self.view_options(view).get("transport")

    def modes_for(self, view: str) -> tuple[str, ...]:
        return tuple(self.view_options(view).get("modes") or ())

    def shared_for(self, view: str) -> bool:
        return self.transport_for(view) == _SHARED_TRANSPORT

    def to_dict(self) -> dict[str, Any]:
        resources = {}
        for name, options_tuple in self.views:
            options = dict(options_tuple)
            spec: dict[str, Any] = {
                "href": "./workspace-resource?item="
                + quote(self.id, safe="")
                + "&view="
                + quote(name, safe=""),
                "deferred": name in _DEFERRED_VIEWS,
            }
            attributes = options.get("attributes")
            if attributes:
                spec["attributes"] = copy.deepcopy(attributes)
                spec["active_attribute"] = options["active_attribute"]
                spec["active_color_by"] = options["active_color_by"]
                if options.get("transport") is not None:
                    spec["transport"] = options["transport"]
                if options.get("modes"):
                    spec["modes"] = list(options["modes"])
            lanes = self.lanes_for(name)
            if lanes:
                spec["lanes"] = [
                    {"id": lane_id, "label": label} for lane_id, label in lanes
                ]
                spec["active_lane"] = self.active_lane(name)
            details = self.details_for(name)
            if details:
                spec["tiers"] = [
                    {"id": detail_id, "label": label} for detail_id, label in details
                ]
                spec["active_detail"] = self.active_detail(name)
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


@dataclass(slots=True)
class _ResourceFlight:
    """One generation-bound resource materialization shared by its waiters."""

    generation: int
    event: threading.Event = field(default_factory=threading.Event)
    result: dict[str, Any] | None = None
    error: BaseException | None = None


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


def _payload_object(
    payload: str | Mapping[str, Any] | None, title: str
) -> dict[str, Any]:
    if payload is None:
        return _empty_payload(title)
    value = (
        json.loads(payload)
        if isinstance(payload, str)
        else copy.deepcopy(dict(payload))
    )
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


def _normalise_lanes(value: Any, *, view: str) -> tuple[tuple[str, str], ...]:
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


def _normalise_tiers(
    value: Any, *, view: str, shared: bool = False
) -> tuple[tuple[str, str], ...]:
    if view != "scene3d" and not (view == "map" and shared):
        raise ValueError(
            "workspace detail tiers are available only for scene3d or shared maps"
        )
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise TypeError(f"workspace {view} tiers must be an ordered list")
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for index, tier in enumerate(value):
        if not isinstance(tier, Mapping):
            raise TypeError(f"workspace {view} tier {index} must be a mapping")
        unknown = set(tier) - _TIER_KEYS
        if unknown:
            raise ValueError(f"unknown workspace tier key(s) {sorted(unknown)}")
        tier_id = tier.get("id")
        label = tier.get("label")
        if not isinstance(tier_id, str) or not tier_id or tier_id != tier_id.strip():
            raise ValueError("workspace tier IDs must be non-empty, trimmed strings")
        if tier_id in seen:
            raise ValueError(f"duplicate workspace {view} tier ID {tier_id!r}")
        if not isinstance(label, str) or not label or label != label.strip():
            raise ValueError("workspace tier labels must be non-empty, trimmed strings")
        seen.add(tier_id)
        out.append((tier_id, label))
    if [tier_id for tier_id, _ in out] != ["preview", "full"]:
        raise ValueError(f"workspace {view} tiers must be ordered preview then full")
    return tuple(out)


def _normalise_attributes(value: Any, *, view: str) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise TypeError(f"workspace {view} attributes must be an ordered list")
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, descriptor in enumerate(value):
        if not isinstance(descriptor, Mapping):
            raise TypeError(f"workspace {view} attribute {index} must be a mapping")
        unknown = set(descriptor) - _ATTRIBUTE_KEYS
        if unknown:
            raise ValueError(f"unknown workspace attribute key(s) {sorted(unknown)}")
        attribute_id = descriptor.get("id")
        label = descriptor.get("label")
        if (
            not isinstance(attribute_id, str)
            or not attribute_id
            or attribute_id != attribute_id.strip()
        ):
            raise ValueError(
                "workspace attribute IDs must be non-empty, trimmed strings"
            )
        if attribute_id in seen:
            raise ValueError(
                f"duplicate workspace {view} attribute ID {attribute_id!r}"
            )
        if not isinstance(label, str) or not label or label != label.strip():
            raise ValueError(
                "workspace attribute labels must be non-empty, trimmed strings"
            )
        kind = descriptor.get("kind", "continuous")
        if kind not in ("continuous", "categorical"):
            raise ValueError(
                "workspace attribute kind must be continuous or categorical"
            )
        units = descriptor.get("units")
        if units is not None and (
            not isinstance(units, str) or not units or units != units.strip()
        ):
            raise ValueError(
                "workspace attribute units must be null or a trimmed string"
            )
        codes = descriptor.get("codes")
        if kind == "continuous" and codes is not None:
            raise ValueError("continuous workspace attributes must declare codes=null")
        canonical_codes: dict[str, dict[str, str | None]] | None = None
        if kind == "categorical":
            if codes is not None and not isinstance(codes, Mapping):
                raise TypeError(
                    "categorical workspace attribute codes must be null or a mapping"
                )
            canonical_codes = None if codes is None else {}
            for code, metadata in (codes or {}).items():
                code_id = str(code)
                if not _INTEGER_CODE.fullmatch(code_id):
                    raise ValueError(
                        "workspace categorical code keys must be canonical integers"
                    )
                if not isinstance(metadata, Mapping):
                    raise TypeError(
                        "workspace categorical code metadata must be a mapping"
                    )
                unknown_code = set(metadata) - _CODE_KEYS
                if unknown_code:
                    raise ValueError(
                        f"unknown workspace categorical code key(s) {sorted(unknown_code)}"
                    )
                code_label = metadata.get("label")
                if code_label is not None and (
                    not isinstance(code_label, str)
                    or not code_label
                    or code_label != code_label.strip()
                ):
                    raise ValueError(
                        "workspace categorical labels must be null or trimmed strings"
                    )
                color = metadata.get("color")
                if color is not None and (
                    not isinstance(color, str)
                    or re.fullmatch(r"#[0-9A-Fa-f]{6}", color) is None
                ):
                    raise ValueError(
                        "workspace categorical colors must be null or #RRGGBB"
                    )
                assert canonical_codes is not None
                canonical_codes[code_id] = {
                    "label": code_label,
                    "color": color.upper() if color is not None else None,
                }
        out.append(
            {
                "id": attribute_id,
                "label": label,
                "kind": kind,
                "units": units,
                "codes": canonical_codes,
            }
        )
        seen.add(attribute_id)
    if not out:
        raise ValueError(f"workspace {view} attributes must not be empty")
    return tuple(out)


def _normalise_project(value: Any) -> dict[str, str | None]:
    if not isinstance(value, Mapping):
        raise TypeError("workspace project must be a mapping")
    unknown = set(value) - _PROJECT_KEYS
    if unknown:
        raise ValueError(f"unknown workspace project key(s) {sorted(unknown)}")
    title = value.get("title")
    if not isinstance(title, str) or not title or title != title.strip():
        raise ValueError("workspace project title must be a non-empty, trimmed string")
    out: dict[str, str | None] = {"title": title}
    for key in ("crs", "unit"):
        field = value.get(key)
        if field is not None and (
            not isinstance(field, str) or not field or field != field.strip()
        ):
            raise ValueError(
                f"workspace project {key} must be null or a trimmed string"
            )
        out[key] = field
    return out


def _normalise_views(
    value: Any, *, provider: bool
) -> tuple[
    tuple[tuple[str, tuple[tuple[str, Any], ...]], ...],
    tuple[tuple[str, tuple[tuple[str, str], ...]], ...],
    tuple[tuple[str, str], ...],
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
        raise TypeError(
            "workspace item views must be a mapping or iterable of view names"
        )

    out: list[tuple[str, tuple[tuple[str, Any], ...]]] = []
    lanes_out: list[tuple[str, tuple[tuple[str, str], ...]]] = []
    active_out: list[tuple[str, str]] = []
    details_out: list[tuple[str, tuple[tuple[str, str], ...]]] = []
    active_details_out: list[tuple[str, str]] = []
    for raw_name, raw_options in names.items():
        name = str(raw_name)
        if name not in _VIEW_NAMES:
            raise ValueError(
                f"unknown workspace view {name!r}; expected one of {sorted(_VIEW_NAMES)}"
            )
        if raw_options is False or raw_options is None:
            if raw_options is False:
                continue
            options: dict[str, Any] = {}
        elif raw_options is True:
            options = {}
        elif isinstance(raw_options, Mapping):
            options = dict(raw_options)
        else:
            raise TypeError(
                f"workspace view {name!r} options must be a mapping or bool"
            )
        raw_lanes = options.pop("lanes", None)
        active_lane = options.pop("active_lane", None)
        default_lane = options.pop("default_lane", None)
        if (
            active_lane is not None
            and default_lane is not None
            and active_lane != default_lane
        ):
            raise ValueError(
                f"workspace {name} active_lane and default_lane must match when both are set"
            )
        active_lane = active_lane if active_lane is not None else default_lane
        if (raw_lanes is not None or active_lane is not None) and not provider:
            raise ValueError(
                "workspace lanes are available only on provider catalog items"
            )
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
        raw_attributes = options.pop("attributes", None)
        active_attribute = options.pop("active_attribute", None)
        active_color_by = options.pop("active_color_by", None)
        transport = options.pop("transport", None)
        raw_modes = options.pop("modes", None)
        if (
            raw_attributes is not None
            or active_attribute is not None
            or active_color_by is not None
            or transport is not None
            or raw_modes is not None
        ) and not provider:
            raise ValueError(
                "workspace v2 view descriptors are available only on provider items"
            )
        attributes = (
            _normalise_attributes(raw_attributes, view=name)
            if raw_attributes is not None
            else ()
        )
        if lanes and attributes:
            raise ValueError(f"workspace {name} cannot mix v1 lanes and v2 attributes")
        if (
            active_attribute is not None or active_color_by is not None
        ) and not attributes:
            raise ValueError(f"workspace {name} selectors require declared attributes")
        if transport is not None and transport != _SHARED_TRANSPORT:
            raise ValueError(f"unsupported workspace {name} transport {transport!r}")
        if transport is not None and not attributes:
            raise ValueError(f"workspace {name} transport requires declared attributes")
        if transport == _SHARED_TRANSPORT and name != "map":
            raise ValueError(
                "shared workspace transport is currently available only for map"
            )
        if raw_modes is not None:
            if transport != _SHARED_TRANSPORT or name != "map":
                raise ValueError("workspace modes require a shared map transport")
            if not isinstance(raw_modes, Sequence) or isinstance(
                raw_modes, (str, bytes)
            ):
                raise TypeError("workspace modes must be an ordered list")
            modes = tuple(raw_modes)
            if modes != ("2d", "3d"):
                raise ValueError("workspace modes must be ordered ['2d', '3d']")
        else:
            modes = ()
        if attributes:
            attribute_ids = {descriptor["id"] for descriptor in attributes}
            active_attribute = active_attribute or attributes[0]["id"]
            active_color_by = active_color_by or active_attribute
            if active_attribute not in attribute_ids:
                raise ValueError(
                    f"workspace {name} active_attribute {active_attribute!r} is not declared"
                )
            if active_color_by not in attribute_ids:
                raise ValueError(
                    f"workspace {name} active_color_by {active_color_by!r} is not declared"
                )
            options["attributes"] = list(attributes)
            options["active_attribute"] = active_attribute
            options["active_color_by"] = active_color_by
            if transport is not None:
                options["transport"] = transport
            if modes:
                options["modes"] = list(modes)
        raw_tiers = options.pop("tiers", None)
        active_detail = options.pop("active_detail", None)
        if (raw_tiers is not None or active_detail is not None) and not provider:
            raise ValueError(
                "workspace detail tiers are available only on provider catalog items"
            )
        details = (
            _normalise_tiers(
                raw_tiers, view=name, shared=transport == _SHARED_TRANSPORT
            )
            if raw_tiers is not None
            else ()
        )
        if active_detail is not None and not details:
            raise ValueError(f"workspace {name} active_detail requires declared tiers")
        if details:
            detail_ids = {detail_id for detail_id, _ in details}
            if active_detail is None:
                active_detail = details[0][0]
            if not isinstance(active_detail, str) or active_detail not in detail_ids:
                raise ValueError(
                    f"workspace {name} active_detail {active_detail!r} is not a declared tier"
                )
            if active_detail != "preview":
                raise ValueError(
                    f"workspace {name} active_detail must be 'preview' for progressive tiers"
                )
            details_out.append((name, details))
            active_details_out.append((name, active_detail))
        allowed = (
            _MAP_OPTIONS
            if name == "map"
            else _SCENE3D_OPTIONS
            if name == "scene3d"
            else frozenset()
        ) | frozenset(
            {
                "attributes",
                "active_attribute",
                "active_color_by",
                "transport",
                "modes",
            }
        )
        unknown = set(options) - allowed
        if unknown and not provider:
            raise ValueError(
                f"unsupported {name} workspace option(s) {sorted(unknown)}; "
                f"expected a subset of {sorted(allowed)}"
            )
        out.append((name, tuple(options.items())))
    if not out and not provider:
        raise ValueError("workspace item must enable at least one view")
    return (
        tuple(out),
        tuple(lanes_out),
        tuple(active_out),
        tuple(details_out),
        tuple(active_details_out),
    )


def _normalise_visible(
    value: Any, views: tuple[tuple[str, Any], ...]
) -> tuple[tuple[str, bool], ...]:
    names = [name for name, _ in views]
    if value is None:
        return tuple((name, True) for name in names)
    if isinstance(value, bool):
        return tuple((name, value) for name in names)
    if not isinstance(value, Mapping):
        raise TypeError("workspace item visible must be bool or a per-view mapping")
    unknown = set(value) - set(names)
    if unknown:
        raise ValueError(
            f"visible names views not enabled by this item: {sorted(unknown)}"
        )
    return tuple((name, bool(value.get(name, False))) for name in names)


class _Normalizer:
    def __init__(self, *, provider: bool) -> None:
        self.provider = provider
        self.ids: set[str] = set()
        self.objects: dict[str, Any] = {}
        self._containers: set[int] = set()
        self.diagnostics: list[dict[str, Any]] = []

    def _claim(self, item_id: str) -> str:
        if not isinstance(item_id, str) or not item_id or item_id != item_id.strip():
            raise ValueError("workspace IDs must be non-empty, trimmed strings")
        if item_id in self.ids:
            raise ValueError(f"duplicate workspace ID {item_id!r}")
        self.ids.add(item_id)
        return item_id

    def roots(self, value: Any) -> tuple[WorkspaceNode, ...]:
        if isinstance(value, Mapping) and not (
            "object" in value or "children" in value
        ):
            return self._mapping(value, ())
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            return self._sequence(value, ())
        raise TypeError(
            "workspace root must be an ordered mapping or list of explicit nodes"
        )

    def _enter(self, value: Any) -> None:
        marker = id(value)
        if marker in self._containers:
            raise ValueError("workspace tree contains a cycle")
        self._containers.add(marker)

    def _leave(self, value: Any) -> None:
        self._containers.remove(id(value))

    def _mapping(
        self, value: Mapping[Any, Any], path: tuple[str, ...]
    ) -> tuple[WorkspaceNode, ...]:
        self._enter(value)
        try:
            out = []
            for raw_label, child in value.items():
                label = str(raw_label)
                child_path = (*path, label)
                provider_leaf = (
                    self.provider
                    and isinstance(child, Mapping)
                    and bool(set(child) & (_PROVIDER_ITEM_KEYS - {"label"}))
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
                            self._claim(_stable_path("group", child_path)),
                            label,
                            children,
                        )
                    )
                elif isinstance(child, Sequence) and not isinstance(
                    child, (str, bytes)
                ):
                    children = self._sequence(child, child_path)
                    out.append(
                        WorkspaceGroup(
                            self._claim(_stable_path("group", child_path)),
                            label,
                            children,
                        )
                    )
                else:
                    out.append(self._leaf(child, child_path, label))
            return tuple(out)
        finally:
            self._leave(value)

    def _sequence(
        self, value: Sequence[Any], path: tuple[str, ...]
    ) -> tuple[WorkspaceNode, ...]:
        self._enter(value)
        try:
            out = []
            for child in value:
                if not isinstance(child, Mapping):
                    raise TypeError(
                        "list workspace children must be explicit node mappings with an id"
                    )
                if "children" in child:
                    node_id = self._claim(str(child.get("id", "")))
                    label = str(child.get("label") or node_id)
                    children_value = child["children"]
                    if isinstance(children_value, Mapping):
                        children = self._mapping(children_value, (*path, node_id))
                    elif isinstance(children_value, Sequence) and not isinstance(
                        children_value, (str, bytes)
                    ):
                        children = self._sequence(children_value, (*path, node_id))
                    else:
                        raise TypeError(
                            "workspace group children must be a mapping or list"
                        )
                    expanded = child.get("expanded")
                    if expanded is not None and not isinstance(expanded, bool):
                        raise TypeError("workspace group expanded must be a bool")
                    out.append(WorkspaceGroup(node_id, label, children, expanded))
                else:
                    if "id" not in child:
                        raise ValueError(
                            "list workspace leaves require an explicit stable id"
                        )
                    out.append(
                        self._leaf(child, path, str(child.get("label") or child["id"]))
                    )
            return tuple(out)
        finally:
            self._leave(value)

    def _leaf(
        self, value: Any, path: tuple[str, ...], fallback_label: str
    ) -> WorkspaceItem:
        if isinstance(value, Mapping):
            allowed_keys = _PROVIDER_ITEM_KEYS if self.provider else _ITEM_KEYS
            unknown = set(value) - allowed_keys
            if unknown:
                raise ValueError(f"unknown workspace item key(s) {sorted(unknown)}")
            obj = value.get("object")
            if obj is None and not self.provider:
                raise TypeError(
                    "an explicit workspace leaf must carry a non-null 'object'"
                )
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
        item_id = self._claim(
            str(explicit_id) if explicit_id is not None else _stable_path("item", path)
        )
        v2_catalog_view = isinstance(raw_views, Mapping) and any(
            isinstance(options, Mapping)
            and bool(
                set(options)
                & {
                    "attributes",
                    "active_attribute",
                    "active_color_by",
                    "transport",
                    "modes",
                }
            )
            for options in raw_views.values()
        )
        if self.provider and v2_catalog_view and isinstance(raw_views, Mapping):
            parts: list[list[Any]] = [[], [], [], [], []]
            invalid_views: list[dict[str, Any]] = []
            for raw_view, raw_options in raw_views.items():
                try:
                    normalized = _normalise_views(
                        {raw_view: raw_options}, provider=True
                    )
                except (TypeError, ValueError) as exc:
                    finding = {
                        "item_id": item_id,
                        "view": str(raw_view),
                        "error": type(exc).__name__,
                        "message": str(exc),
                    }
                    invalid_views.append(finding)
                    self.diagnostics.append(finding)
                    continue
                for index, values in enumerate(normalized):
                    parts[index].extend(values)
            views, lanes, active_lanes, details, active_details = (
                tuple(values) for values in parts
            )
            if invalid_views:
                diagnostic = diagnostic or {
                    "invalid_views": copy.deepcopy(invalid_views)
                }
                if isinstance(raw_visible, Mapping):
                    valid_names = {name for name, _ in views}
                    raw_visible = {
                        name: selected
                        for name, selected in raw_visible.items()
                        if name in valid_names
                    }
            if not views:
                raw_disabled = True
                raw_visible = None
                reason = reason or "Invalid provider view descriptor"
        else:
            views, lanes, active_lanes, details, active_details = _normalise_views(
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
                raise ValueError(
                    "workspace disabled reason must be a non-empty, trimmed string"
                )
        if diagnostic is not None:
            try:
                json.dumps(diagnostic)
            except (TypeError, ValueError) as exc:
                raise TypeError(
                    "workspace diagnostic must be JSON-serializable"
                ) from exc
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
            details=details,
            active_details=active_details,
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
            raise ValueError(
                f"ambiguous visible selector {key!r}; use a canonical workspace ID"
            )
        raise KeyError(f"unknown visible selector {key!r}")

    selected: dict[str, set[str]] = {}
    if isinstance(visible, Mapping):
        for view, selectors in visible.items():
            if view not in _VIEW_NAMES:
                raise ValueError(f"unknown visible view {view!r}")
            values = (
                [selectors] if isinstance(selectors, (str, bytes)) else list(selectors)
            )
            selected[str(view)] = {resolve(value) for value in values}
    else:
        values = [visible] if isinstance(visible, (str, bytes)) else list(visible)
        ids = {resolve(value) for value in values}
        for view in _VIEW_NAMES:
            selected[view] = set(ids)

    def replace(node: WorkspaceNode) -> WorkspaceNode:
        if isinstance(node, WorkspaceGroup):
            return WorkspaceGroup(
                node.id,
                node.label,
                tuple(replace(ch) for ch in node.children),
                node.expanded,
            )
        vis = tuple(
            (view, node.id in selected.get(view, set())) for view, _ in node.visible
        )
        return WorkspaceItem(
            id=node.id,
            label=node.label,
            views=node.views,
            visible=vis,
            role=node.role,
            lanes=node.lanes,
            active_lanes=node.active_lanes,
            details=node.details,
            active_details=node.active_details,
            disabled=node.disabled,
            reason=node.reason,
            diagnostic=copy.deepcopy(node.diagnostic),
        )

    return tuple(replace(node) for node in nodes)


def _block_digest(marker: Any, *, field: str) -> str:
    if not isinstance(marker, Mapping) or set(marker) != {"__block__"}:
        raise ValueError(f"workspace shared {field} must be exactly one BlockRef")
    digest = marker["__block__"]
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise ValueError(f"workspace shared {field} has an invalid block digest")
    return digest


def _validated_blocks(value: Any) -> tuple[dict[str, dict[str, Any]], dict[str, bytes]]:
    if value is None:
        value = {}
    if not isinstance(value, Mapping):
        raise TypeError("workspace shared blocks must be a mapping")
    blocks: dict[str, dict[str, Any]] = {}
    raw_blocks: dict[str, bytes] = {}
    widths = {"f32": 4, "u32": 4, "u8": 1}
    for digest, descriptor in value.items():
        if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
            raise ValueError("workspace shared block keys must be sha-256 digests")
        if not isinstance(descriptor, Mapping):
            raise TypeError("workspace shared block descriptors must be mappings")
        if set(descriptor) != {"dtype", "shape", "data"}:
            raise ValueError(
                "workspace shared blocks require exactly dtype, shape, and data"
            )
        dtype = descriptor["dtype"]
        shape = descriptor["shape"]
        data = descriptor["data"]
        if dtype not in widths:
            raise ValueError(f"unsupported workspace shared block dtype {dtype!r}")
        if (
            not isinstance(shape, Sequence)
            or isinstance(shape, (str, bytes))
            or not shape
            or any(
                not isinstance(size, int) or isinstance(size, bool) or size < 0
                for size in shape
            )
        ):
            raise ValueError(
                "workspace shared block shape must contain non-negative integers"
            )
        if not isinstance(data, str):
            raise TypeError("workspace shared block data must be base64 text")
        try:
            raw = base64.b64decode(data, validate=True)
        except Exception as exc:
            raise ValueError("workspace shared block data is not valid base64") from exc
        count = math.prod(shape)
        if len(raw) != count * widths[dtype]:
            raise ValueError(
                "workspace shared block byte length does not match dtype and shape"
            )
        if hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError("workspace shared block content does not match its digest")
        blocks[digest] = copy.deepcopy(dict(descriptor))
        raw_blocks[digest] = raw
    return blocks, raw_blocks


def _validate_payload_block_refs(value: Any, blocks: Mapping[str, Any]) -> None:
    if isinstance(value, Mapping):
        if "__block__" in value:
            digest = _block_digest(value, field="payload marker")
            if digest not in blocks:
                raise ValueError("workspace shared payload references an unknown block")
            return
        if "__csr__" in value:
            csr = value["__csr__"]
            if (
                set(value) != {"__csr__"}
                or not isinstance(csr, Mapping)
                or set(csr) != {"coords", "offsets"}
            ):
                raise ValueError("workspace shared CSR markers are malformed")
            for digest in csr.values():
                if not isinstance(digest, str) or digest not in blocks:
                    raise ValueError(
                        "workspace shared CSR marker references an unknown block"
                    )
            return
        for child in value.values():
            _validate_payload_block_refs(child, blocks)
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        for child in value:
            _validate_payload_block_refs(child, blocks)


def _validate_frame(value: Any) -> tuple[int, int]:
    if not isinstance(value, Mapping):
        raise TypeError("workspace shared surface_grid frame must be a mapping")
    required = {"origin_x", "origin_y", "spacing_x", "spacing_y", "ncol", "nrow"}
    allowed = required | {"rotation_deg", "yflip", "crs", "units"}
    unknown = set(value) - allowed
    if unknown or not required <= set(value):
        raise ValueError("workspace shared frame has missing or unknown fields")
    for key in ("origin_x", "origin_y", "spacing_x", "spacing_y"):
        field = value[key]
        if (
            not isinstance(field, (int, float))
            or isinstance(field, bool)
            or not math.isfinite(field)
        ):
            raise ValueError(f"workspace shared frame {key} must be finite")
    if value["spacing_x"] <= 0 or value["spacing_y"] <= 0:
        raise ValueError("workspace shared frame spacing must be positive")
    for key in ("ncol", "nrow"):
        if (
            not isinstance(value[key], int)
            or isinstance(value[key], bool)
            or value[key] <= 0
        ):
            raise ValueError(f"workspace shared frame {key} must be a positive integer")
    rotation = value.get("rotation_deg", 0.0)
    if (
        not isinstance(rotation, (int, float))
        or isinstance(rotation, bool)
        or not math.isfinite(rotation)
    ):
        raise ValueError("workspace shared frame rotation_deg must be finite")
    if "yflip" in value and not isinstance(value["yflip"], bool):
        raise TypeError("workspace shared frame yflip must be bool")
    for key in ("crs", "units"):
        field = value.get(key)
        if field is not None and (
            not isinstance(field, str) or not field or field != field.strip()
        ):
            raise ValueError(
                f"workspace shared frame {key} must be null or trimmed text"
            )
    return value["ncol"], value["nrow"]


def _validate_shared_grid(
    payload: dict[str, Any],
    *,
    item: WorkspaceItem,
    view: str,
    blocks: Mapping[str, Mapping[str, Any]],
    raw_blocks: Mapping[str, bytes],
) -> None:
    map_bundle = payload.get("map")
    if not isinstance(map_bundle, Mapping):
        raise ValueError("workspace shared Map response requires payload.map")
    if map_bundle.get("blocks") is not None:
        raise ValueError(
            "workspace shared Map must not repeat blocks under payload.map"
        )
    if payload.get("scene3d") is not None:
        raise ValueError("workspace shared Map must not carry a sibling scene3d bundle")
    grid = map_bundle.get("surface_grid")
    if not isinstance(grid, Mapping):
        raise ValueError("workspace shared Map requires payload.map.surface_grid")
    required = {
        "schema_version",
        "item_id",
        "frame",
        "mask",
        "attributes",
        "triangle_count",
    }
    allowed = required | {"positive"}
    if set(grid) - allowed or not required <= set(grid):
        raise ValueError("workspace shared surface_grid has missing or unknown fields")
    if grid["schema_version"] != 1 or grid["item_id"] != item.id:
        raise ValueError("workspace shared surface_grid identity/version mismatch")
    ncol, nrow = _validate_frame(grid["frame"])
    count = ncol * nrow
    positive = grid.get("positive", "down")
    if positive not in ("down", "up"):
        raise ValueError("workspace shared surface_grid positive must be down or up")
    if "positive" not in grid and isinstance(grid, dict):
        grid["positive"] = positive
    if (
        not isinstance(grid["triangle_count"], int)
        or isinstance(grid["triangle_count"], bool)
        or grid["triangle_count"] < 0
    ):
        raise ValueError(
            "workspace shared surface_grid triangle_count must be non-negative"
        )
    if grid["mask"] is not None:
        digest = _block_digest(grid["mask"], field="mask")
        block = blocks.get(digest)
        if block is None or block.get("dtype") != "u8" or block.get("shape") != [count]:
            raise ValueError("workspace shared mask must resolve to u8 [ncol*nrow]")
    attributes = grid["attributes"]
    declared = item.attributes_for(view)
    if (
        not isinstance(attributes, Sequence)
        or isinstance(attributes, (str, bytes))
        or len(attributes) != len(declared)
    ):
        raise ValueError(
            "workspace shared attribute data must match the resource descriptor count"
        )
    for index, (actual, expected) in enumerate(zip(attributes, declared)):
        if not isinstance(actual, Mapping):
            raise TypeError("workspace shared attribute data must be mappings")
        allowed = _ATTRIBUTE_KEYS | {"values", "range", "colormap", "colormap_reversed"}
        if set(actual) - allowed or not (_ATTRIBUTE_KEYS | {"values", "range"}) <= set(
            actual
        ):
            raise ValueError(
                "workspace shared attribute data has missing or unknown fields"
            )
        if {key: actual.get(key) for key in _ATTRIBUTE_KEYS} != expected:
            raise ValueError(
                f"workspace shared attribute descriptor {index} does not match its spec"
            )
        digest = _block_digest(
            actual["values"], field=f"attribute {expected['id']} values"
        )
        block = blocks.get(digest)
        if (
            block is None
            or block.get("dtype") != "f32"
            or block.get("shape") != [count]
        ):
            raise ValueError(
                "workspace shared attribute values must resolve to f32 [ncol*nrow]"
            )
        range_value = actual["range"]
        colormap = actual.get("colormap")
        if colormap is not None and colormap not in _COLORMAPS:
            raise ValueError(f"unsupported workspace shared colormap {colormap!r}")
        if "colormap_reversed" in actual and not isinstance(
            actual["colormap_reversed"], bool
        ):
            raise TypeError("workspace shared colormap_reversed must be bool")
        finite_values = [
            value[0]
            for value in struct.iter_unpack("<f", raw_blocks[digest])
            if math.isfinite(value[0])
        ]
        if expected["kind"] == "categorical":
            if range_value is not None:
                raise ValueError(
                    "workspace categorical attribute data must use range=null"
                )
            if any(not value.is_integer() for value in finite_values):
                raise ValueError(
                    "workspace categorical attribute values must be integral"
                )
        elif range_value is None:
            if finite_values:
                raise ValueError(
                    "workspace continuous attribute range is required for finite data"
                )
        else:
            if not finite_values:
                raise ValueError(
                    "workspace continuous attribute range must be null without finite data"
                )
            if (
                not isinstance(range_value, Sequence)
                or isinstance(range_value, (str, bytes))
                or len(range_value) != 2
                or any(
                    not isinstance(v, (int, float))
                    or isinstance(v, bool)
                    or not math.isfinite(v)
                    for v in range_value
                )
                or range_value[0] > range_value[1]
            ):
                raise ValueError(
                    "workspace continuous attribute range must be finite and ordered"
                )


def _validate_well_overlays(payload: Mapping[str, Any]) -> None:
    map_bundle = payload.get("map")
    if not isinstance(map_bundle, Mapping) or "well_overlays" not in map_bundle:
        return
    overlays = map_bundle["well_overlays"]
    if not isinstance(overlays, Sequence) or isinstance(overlays, (str, bytes)):
        raise TypeError("workspace map well_overlays must be a list")
    for overlay in overlays:
        if not isinstance(overlay, Mapping):
            raise TypeError("workspace well overlays must be mappings")
        if "intersections" not in overlay:
            continue  # singular compatibility remains unchanged
        intersections = overlay["intersections"]
        if not isinstance(intersections, Sequence) or isinstance(
            intersections, (str, bytes)
        ):
            raise TypeError("workspace overlay intersections must be a list")
        previous = -math.inf
        for record in intersections:
            if not isinstance(record, Mapping) or set(record) != {"md", "xyz"}:
                raise ValueError(
                    "workspace overlay intersections require exactly md and xyz"
                )
            md = record["md"]
            xyz = record["xyz"]
            if (
                not isinstance(md, (int, float))
                or isinstance(md, bool)
                or not math.isfinite(md)
                or not isinstance(xyz, Sequence)
                or isinstance(xyz, (str, bytes))
                or len(xyz) != 3
                or any(
                    not isinstance(value, (int, float))
                    or isinstance(value, bool)
                    or not math.isfinite(value)
                    for value in xyz
                )
            ):
                raise ValueError("workspace overlay intersection MD/XYZ must be finite")
            if md < previous:
                raise ValueError(
                    "workspace overlay intersections must be non-decreasing by MD"
                )
            previous = md
        status = overlay.get("status")
        count = len(intersections)
        if (
            (status == "hit" and count != 1)
            or (status == "ambiguous" and count < 2)
            or (status in ("no_hit", "error") and count != 0)
            or status not in ("hit", "ambiguous", "no_hit", "error")
        ):
            raise ValueError(
                "workspace overlay status/intersections cardinality mismatch"
            )


def _resource_envelope(
    value: Mapping[str, Any],
    *,
    item: WorkspaceItem,
    view: str,
    lane: str | None,
    attribute: str | None,
    color_by: str | None,
    detail: str | None,
) -> dict[str, Any]:
    shared = item.shared_for(view)
    v2 = bool(item.attributes_for(view))
    supplied = copy.deepcopy(dict(value))
    existing = supplied.get("kind") == "workspace_resource"
    if existing:
        result = supplied
    else:
        result = {
            "schema_version": 2 if v2 else 1,
            "kind": "workspace_resource",
            "item_id": item.id,
            "view": view,
            "payload": supplied,
        }
        if not v2:
            # Workspace v1 always serialized the lane member, including null.
            result["lane"] = lane
        if attribute is not None:
            result["attribute"] = attribute
            result["color_by"] = color_by
        if detail is not None:
            result["detail"] = detail
    expected_version = 2 if v2 else 1
    if result.get("schema_version") != expected_version:
        raise ValueError("workspace resource schema_version does not match its request")
    if result.get("item_id") != item.id or result.get("view") != view:
        raise ValueError("workspace resource item/view identity mismatch")
    if result.get("detail") != detail:
        raise ValueError("workspace resource detail echo mismatch")
    if not isinstance(result.get("payload"), Mapping):
        raise TypeError("workspace resource payload must be a mapping")
    _validate_well_overlays(result["payload"])
    if shared:
        if any(name in result for name in ("lane", "attribute", "color_by")):
            raise ValueError("shared workspace resources must not echo selectors")
        payload = copy.deepcopy(dict(result["payload"]))
        map_bundle = payload.get("map")
        nested_blocks = (
            map_bundle.get("blocks") if isinstance(map_bundle, Mapping) else None
        )
        if nested_blocks is not None:
            raise ValueError(
                "workspace shared response must carry blocks only at envelope level"
            )
        blocks, raw_blocks = _validated_blocks(result.get("blocks"))
        result["blocks"] = blocks
        result["payload"] = payload
        _validate_payload_block_refs(payload, blocks)
        _validate_shared_grid(
            payload, item=item, view=view, blocks=blocks, raw_blocks=raw_blocks
        )
    elif v2:
        if "lane" in result:
            raise ValueError("workspace v2 resources must not echo lane")
        if result.get("attribute") != attribute or result.get("color_by") != color_by:
            raise ValueError("workspace resource attribute/color_by echo mismatch")
    else:
        if any(name in result for name in ("attribute", "color_by")):
            raise ValueError("workspace v1 resources must not echo v2 selectors")
        if result.get("lane") != lane:
            raise ValueError("workspace resource lane echo mismatch")
    return result


class WorkspaceSession:
    """Inspectable workspace session returned by :func:`view`.

    The catalog is immutable for the lifetime of one snapshot.  ``refresh()``
    explicitly rebuilds it from the original tree/provider.  Resource values are
    constructed on first request and cached by its schema-specific identity:
    legacy lane, transitional selector pair, or selector-free shared Map.
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
        self._cache: dict[
            tuple[str, str, str | None, str | None, str | None, str | None],
            dict[str, Any],
        ] = {}
        self._inflight: dict[
            tuple[str, str, str | None, str | None, str | None, str | None],
            _ResourceFlight,
        ] = {}
        self._generation = 0
        self._diagnostics: list[dict[str, Any]] = []
        self._catalog_diagnostics: list[dict[str, Any]] = []
        self._project: dict[str, str | None] | None = None
        self._workspace_schema_version = 1
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
        project = None
        declared_version = None
        if (
            self._provider
            and isinstance(catalog, Mapping)
            and "tree" in catalog
            and set(catalog) <= {"schema_version", "project", "tree"}
        ):
            declared_version = catalog.get("schema_version", 2)
            if declared_version != 2:
                raise ValueError(
                    "provider catalog envelopes must use workspace schema_version 2"
                )
            project = (
                _normalise_project(catalog["project"])
                if catalog.get("project") is not None
                else None
            )
            catalog = catalog["tree"]
        normalizer = _Normalizer(provider=self._provider)
        nodes = _apply_visible_override(
            normalizer.roots(catalog), self._visible_override
        )
        items = {item.id: item for item in _walk_items(nodes)}
        if not items:
            raise ValueError("workspace catalog contains no leaves")
        self._nodes = nodes
        self._items = items
        self._objects = normalizer.objects
        has_v2 = any(
            item.attributes_for(view)
            for item in items.values()
            for view, _ in item.views
        )
        self._workspace_schema_version = (
            2 if declared_version == 2 or project or has_v2 else 1
        )
        self._project = project
        self._catalog_diagnostics = normalizer.diagnostics

    @property
    def url(self) -> str | None:
        return self._url

    @property
    def diagnostics(self) -> tuple[dict[str, Any], ...]:
        return tuple(copy.deepcopy(self._catalog_diagnostics + self._diagnostics))

    def tree(self) -> list[dict[str, Any]]:
        """Return a detached JSON-shaped copy of the normalized ordered tree."""
        return [node.to_dict() for node in self._nodes]

    def manifest(self) -> dict[str, Any]:
        """Return the additive workspace-v1/v2 top-level render envelope."""
        payload = copy.deepcopy(self._base_payload)
        available = []
        for item in self._items.values():
            for view, _ in item.views:
                if view not in available:
                    available.append(view)
        workspace = {
            "schema_version": self._workspace_schema_version,
            "title": self._title,
            "tree": self.tree(),
            "available_views": available,
            "initial_tab": self._tab,
            "mode": "live",
        }
        if self._project is not None:
            workspace["project"] = copy.deepcopy(self._project)
        payload["workspace"] = workspace
        return payload

    def refresh(self) -> "WorkspaceSession":
        """Replace the catalog snapshot and clear all materialized resources."""
        with self._lock:
            self._diagnostics.clear()
            self._snapshot()
            self._generation += 1
            self._cache.clear()
            # Existing callers retain their flight object and are woken by its
            # producer, but post-refresh callers start against the new snapshot.
            self._inflight.clear()
        return self

    def _materializer(
        self,
        item: WorkspaceItem,
        view: str,
        lane: str | None,
        attribute: str | None,
        color_by: str | None,
        detail: str | None,
    ) -> Callable[[], Any]:
        if self._provider:
            if item.shared_for(view):
                if detail is not None:
                    return lambda: self._source.view_resource(
                        item_id=item.id, view=view, detail=detail
                    )
                return lambda: self._source.view_resource(item_id=item.id, view=view)
            if attribute is not None:
                if detail is not None:
                    return lambda: self._source.view_resource(
                        item_id=item.id,
                        view=view,
                        attribute=attribute,
                        color_by=color_by,
                        detail=detail,
                    )
                return lambda: self._source.view_resource(
                    item_id=item.id,
                    view=view,
                    attribute=attribute,
                    color_by=color_by,
                )
            if detail is not None:
                return lambda: self._source.view_resource(
                    item_id=item.id, view=view, lane=lane, detail=detail
                )
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

    def resource(
        self,
        item_id: str,
        view: str,
        lane: str | None = None,
        detail: str | None = None,
        *,
        attribute: str | None = None,
        color_by: str | None = None,
    ) -> dict[str, Any]:
        """Materialize and cache one typed leaf/view resource."""
        with self._lock:
            if item_id not in self._items:
                raise KeyError(f"unknown workspace item {item_id!r}")
            item = self._items[item_id]
            if item.disabled or view not in dict(item.views):
                raise KeyError(f"workspace item {item_id!r} has no {view!r} resource")
            attributes = item.attributes_for(view)
            shared = item.shared_for(view)
            if lane is not None and (attribute is not None or color_by is not None):
                raise ValueError(
                    "workspace resource cannot mix lane with attribute/color_by"
                )
            lanes = item.lanes_for(view)
            if lanes:
                if attribute is not None or color_by is not None:
                    raise ValueError(
                        "workspace v1 lane resources do not accept v2 selectors"
                    )
                lane = item.active_lane(view) if lane is None else lane
                declared = {lane_id for lane_id, _ in lanes}
                if lane not in declared:
                    raise ValueError(
                        f"workspace item {item_id!r} view {view!r} has no lane {lane!r}"
                    )
            elif lane is not None:
                raise ValueError(
                    f"workspace item {item_id!r} view {view!r} has no lanes"
                )
            if shared:
                if attribute is not None or color_by is not None:
                    raise ValueError(
                        "shared workspace Map requests do not accept selectors"
                    )
                attribute = None
                color_by = None
            elif attributes:
                if (attribute is None) != (color_by is None):
                    raise ValueError(
                        "non-shared workspace v2 requests require both attribute and color_by"
                    )
                attribute = (
                    item.active_attribute(view) if attribute is None else attribute
                )
                color_by = item.active_color_by(view) if color_by is None else color_by
                declared_attributes = {descriptor["id"] for descriptor in attributes}
                if attribute not in declared_attributes:
                    raise ValueError(
                        f"workspace item {item_id!r} view {view!r} has no attribute {attribute!r}"
                    )
                if color_by not in declared_attributes:
                    raise ValueError(
                        f"workspace item {item_id!r} view {view!r} has no color_by {color_by!r}"
                    )
            elif attribute is not None or color_by is not None:
                raise ValueError(
                    f"workspace item {item_id!r} view {view!r} has no v2 selectors"
                )
            details = item.details_for(view)
            if details:
                detail = item.active_detail(view) if detail is None else detail
                declared_details = {detail_id for detail_id, _ in details}
                if detail not in declared_details:
                    raise ValueError(
                        f"workspace item {item_id!r} view {view!r} has no detail {detail!r}"
                    )
            elif detail is not None:
                raise ValueError(
                    f"workspace item {item_id!r} view {view!r} has no detail tiers"
                )
            key = (item_id, view, lane, attribute, color_by, detail)
            cached = self._cache.get(key)
            if cached is not None:
                return copy.deepcopy(cached)
            flight = self._inflight.get(key)
            leader = flight is None
            if flight is None:
                flight = _ResourceFlight(self._generation)
                self._inflight[key] = flight

        if not leader:
            flight.event.wait()
            if flight.error is not None:
                raise flight.error
            assert flight.result is not None
            return copy.deepcopy(flight.result)

        try:
            value = self._materializer(item, view, lane, attribute, color_by, detail)()
            if isinstance(value, str):
                value = json.loads(value)
            if not isinstance(value, Mapping):
                raise TypeError(
                    "workspace resource provider must return a mapping or JSON object"
                )
            result = _resource_envelope(
                value,
                item=item,
                view=view,
                lane=lane,
                attribute=attribute,
                color_by=color_by,
                detail=detail,
            )
        except Exception as exc:
            with self._lock:
                if self._inflight.get(key) is flight:
                    del self._inflight[key]
                flight.error = exc
                self._diagnostics.append(
                    {
                        "item_id": item_id,
                        "view": view,
                        "lane": lane,
                        "attribute": attribute,
                        "color_by": color_by,
                        "detail": detail,
                        "error": type(exc).__name__,
                        "message": str(exc),
                    }
                )
                flight.event.set()
            raise

        with self._lock:
            if (
                self._generation == flight.generation
                and self._inflight.get(key) is flight
            ):
                self._cache[key] = result
                del self._inflight[key]
            flight.result = result
            flight.event.set()
        return copy.deepcopy(result)

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
