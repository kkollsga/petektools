"""Declarative, serializable well-correlation view templates."""

from __future__ import annotations

import copy
import json
import math
from dataclasses import dataclass, field, replace as dc_replace
from typing import Any, Mapping


def _name(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value.strip()


def _finite(value: Any, label: str) -> float:
    out = float(value)
    if not math.isfinite(out):
        raise ValueError(f"{label} must be finite")
    return out


def _positive(value: Any, label: str) -> float:
    out = _finite(value, label)
    if out <= 0:
        raise ValueError(f"{label} must be > 0")
    return out


def _style(style: Mapping[str, Any] | None, label: str) -> dict[str, Any]:
    out = dict(style or {})
    allowed = {"color", "width", "opacity", "dash", "fill", "fill_opacity"}
    extra = set(out) - allowed
    if extra:
        raise ValueError(f"unknown {label} style key(s): {sorted(extra)}")
    if "color" in out and (not isinstance(out["color"], str) or not out["color"].strip()):
        raise TypeError(f"{label} style color must be a non-empty CSS color")
    if "width" in out:
        out["width"] = _positive(out["width"], f"{label} style width")
    for key in ("opacity", "fill_opacity"):
        if key in out:
            out[key] = _finite(out[key], f"{label} style {key}")
            if not 0 <= out[key] <= 1:
                raise ValueError(f"{label} style {key} must be between 0 and 1")
    if "dash" in out:
        out["dash"] = [_positive(v, f"{label} dash") for v in out["dash"]]
    return out


@dataclass(frozen=True)
class CorrelationTrack:
    """One ordered track, optionally grouped and containing overlay layers."""

    id: str
    title: str | None = None
    width: float = 1.0
    group: str | None = None
    scale: str = "linear"
    side: str = "left"
    minimum: float | None = None
    maximum: float | None = None
    reversed: bool = False
    layers: tuple[dict[str, Any], ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", _name(self.id, "track id"))
        if self.title is not None:
            object.__setattr__(self, "title", _name(self.title, "track title"))
        object.__setattr__(self, "width", _positive(self.width, "track width"))
        if self.group is not None:
            object.__setattr__(self, "group", _name(self.group, "track group"))
        if self.scale not in {"linear", "log"}:
            raise ValueError("track scale must be 'linear' or 'log'")
        if self.side not in {"left", "right"}:
            raise ValueError("track side must be 'left' or 'right'")
        lo = None if self.minimum is None else _finite(self.minimum, "track minimum")
        hi = None if self.maximum is None else _finite(self.maximum, "track maximum")
        if (lo is None) != (hi is None):
            raise ValueError("track minimum and maximum must be supplied together")
        if lo is not None and lo == hi:
            raise ValueError("track minimum and maximum must differ")
        if self.scale == "log" and lo is not None and (lo <= 0 or hi <= 0):
            raise ValueError("log track bounds must be positive")
        object.__setattr__(self, "minimum", lo)
        object.__setattr__(self, "maximum", hi)
        layers = tuple(_validate_layer(dict(layer)) for layer in self.layers)
        ids = [layer["id"] for layer in layers]
        if len(ids) != len(set(ids)):
            raise ValueError(f"track {self.id!r} has duplicate layer ids")
        object.__setattr__(self, "layers", layers)

    def curve(
        self,
        mnemonic: str,
        *,
        id: str | None = None,
        style: Mapping[str, Any] | None = None,
        fill: Mapping[str, Any] | None = None,
        cutoff: float | None = None,
        overlay: bool = False,
    ) -> "CorrelationTrack":
        layer: dict[str, Any] = {
            "id": id or mnemonic,
            "kind": "curve",
            "mnemonic": mnemonic,
            "style": dict(style or {}),
            "overlay": bool(overlay),
        }
        if fill is not None:
            layer["fill"] = dict(fill)
        if cutoff is not None:
            layer["cutoff"] = cutoff
        return dc_replace(self, layers=(*self.layers, layer))

    def flag(
        self,
        mnemonic: str,
        *,
        id: str | None = None,
        style: Mapping[str, Any] | None = None,
        overlay: bool = False,
    ) -> "CorrelationTrack":
        return dc_replace(
            self,
            layers=(
                *self.layers,
                {
                    "id": id or mnemonic,
                    "kind": "flag",
                    "mnemonic": mnemonic,
                    "style": dict(style or {}),
                    "overlay": bool(overlay),
                },
            ),
        )

    def replace(self, **changes: Any) -> "CorrelationTrack":
        return dc_replace(self, **changes)

    def to_dict(self) -> dict[str, Any]:
        return {
            "spec": "CorrelationTrack",
            "schema_version": 1,
            "id": self.id,
            "title": self.title,
            "width": self.width,
            "group": self.group,
            "scale": self.scale,
            "side": self.side,
            "minimum": self.minimum,
            "maximum": self.maximum,
            "reversed": bool(self.reversed),
            "layers": copy.deepcopy(list(self.layers)),
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "CorrelationTrack":
        data = dict(value)
        if data.pop("spec", "CorrelationTrack") != "CorrelationTrack":
            raise ValueError("not a CorrelationTrack dictionary")
        if data.pop("schema_version", 1) != 1:
            raise ValueError("unsupported CorrelationTrack schema version")
        data["layers"] = tuple(data.get("layers", ()))
        return cls(**data)


def _validate_layer(layer: dict[str, Any]) -> dict[str, Any]:
    allowed = {"id", "kind", "mnemonic", "style", "fill", "cutoff", "overlay"}
    extra = set(layer) - allowed
    if extra:
        raise ValueError(f"unknown correlation layer key(s): {sorted(extra)}")
    layer["id"] = _name(layer.get("id"), "layer id")
    if layer.get("kind") not in {"curve", "flag"}:
        raise ValueError("layer kind must be 'curve' or 'flag'")
    layer["mnemonic"] = _name(layer.get("mnemonic"), "layer mnemonic")
    layer["style"] = _style(layer.get("style"), "layer")
    layer["overlay"] = bool(layer.get("overlay", False))
    if "cutoff" in layer:
        layer["cutoff"] = _finite(layer["cutoff"], "layer cutoff")
    if "fill" in layer:
        if not isinstance(layer["fill"], Mapping):
            raise TypeError("layer fill must be a mapping")
        fill = dict(layer["fill"])
        extra_fill = set(fill) - {"to", "color", "opacity", "when"}
        if extra_fill:
            raise ValueError(f"unknown layer fill key(s): {sorted(extra_fill)}")
        if "to" in fill and not isinstance(fill["to"], (str, int, float)):
            raise TypeError("layer fill.to must be a mnemonic or number")
        if "to" in fill and isinstance(fill["to"], (int, float)):
            fill["to"] = _finite(fill["to"], "fill to")
        if "color" in fill and (
            not isinstance(fill["color"], str) or not fill["color"].strip()
        ):
            raise TypeError("layer fill.color must be a non-empty CSS color")
        if "when" in fill and fill["when"] not in {"above", "below", "between", "always"}:
            raise ValueError("layer fill.when must be above, below, between, or always")
        if "opacity" in fill:
            fill["opacity"] = _finite(fill["opacity"], "fill opacity")
            if not 0 <= fill["opacity"] <= 1:
                raise ValueError("fill opacity must be between 0 and 1")
        layer["fill"] = fill
    return layer


@dataclass(frozen=True)
class CorrelationTemplate:
    """Named layout specification for a WellLogBundle correlation view."""

    name: str
    tracks: tuple[CorrelationTrack, ...] = ()
    depth_axis: str = "tvd"
    padding: float = 14.0
    gap: float = 14.0
    show_tops: bool = True
    top_labels: bool = True
    connectors: bool = True
    show_zones: bool = True
    default_hang: str = "tvd"
    flatten_pick: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", _name(self.name, "template name"))
        tracks = tuple(
            t if isinstance(t, CorrelationTrack) else CorrelationTrack.from_dict(t)
            for t in self.tracks
        )
        ids = [t.id for t in tracks]
        if len(ids) != len(set(ids)):
            raise ValueError("template track ids must be unique")
        object.__setattr__(self, "tracks", tracks)
        if self.depth_axis not in {"tvd", "md"}:
            raise ValueError("depth_axis must be 'tvd' or 'md'")
        object.__setattr__(self, "padding", _finite(self.padding, "template padding"))
        object.__setattr__(self, "gap", _finite(self.gap, "template gap"))
        if self.padding < 0 or self.gap < 0:
            raise ValueError("template padding and gap must be >= 0")
        if self.default_hang not in {"tvd", "flatten"}:
            raise ValueError("default_hang must be 'tvd' or 'flatten'")
        if self.flatten_pick is not None:
            object.__setattr__(self, "flatten_pick", _name(self.flatten_pick, "flatten_pick"))
        if self.default_hang == "flatten" and self.flatten_pick is None:
            raise ValueError("default_hang='flatten' requires flatten_pick")
        for key in ("show_tops", "top_labels", "connectors", "show_zones"):
            if not isinstance(getattr(self, key), bool):
                raise TypeError(f"{key} must be bool")

    def add_track(self, track: CorrelationTrack) -> "CorrelationTemplate":
        if not isinstance(track, CorrelationTrack):
            raise TypeError("add_track requires a CorrelationTrack")
        return dc_replace(self, tracks=(*self.tracks, track))

    def track(self, id: str, **kwargs: Any) -> "CorrelationTemplate":
        return self.add_track(CorrelationTrack(id, **kwargs))

    def replace(self, **changes: Any) -> "CorrelationTemplate":
        return dc_replace(self, **changes)

    def to_dict(self) -> dict[str, Any]:
        return {
            "spec": "CorrelationTemplate",
            "schema_version": 1,
            "name": self.name,
            "tracks": [track.to_dict() for track in self.tracks],
            "layout": {
                "depth_axis": self.depth_axis,
                "padding": self.padding,
                "gap": self.gap,
            },
            "tops": {"show": bool(self.show_tops), "labels": bool(self.top_labels), "connectors": bool(self.connectors)},
            "zones": {"show": bool(self.show_zones)},
            "default_hang": self.default_hang,
            "flatten_pick": self.flatten_pick,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "CorrelationTemplate":
        data = dict(value)
        if data.pop("spec", "CorrelationTemplate") != "CorrelationTemplate":
            raise ValueError("not a CorrelationTemplate dictionary")
        if data.pop("schema_version", 1) != 1:
            raise ValueError("unsupported CorrelationTemplate schema version")
        layout = dict(data.pop("layout", {}))
        tops = dict(data.pop("tops", {}))
        zones = dict(data.pop("zones", {}))
        if set(layout) - {"depth_axis", "padding", "gap"}:
            raise ValueError("unknown CorrelationTemplate layout field")
        if set(tops) - {"show", "labels", "connectors"}:
            raise ValueError("unknown CorrelationTemplate tops field")
        if set(zones) - {"show"}:
            raise ValueError("unknown CorrelationTemplate zones field")
        return cls(
            tracks=tuple(CorrelationTrack.from_dict(t) for t in data.pop("tracks", ())),
            depth_axis=layout.pop("depth_axis", "tvd"),
            padding=layout.pop("padding", 14.0),
            gap=layout.pop("gap", 14.0),
            show_tops=tops.pop("show", True),
            top_labels=tops.pop("labels", True),
            connectors=tops.pop("connectors", True),
            show_zones=zones.pop("show", True),
            **data,
        )

    def apply(self, bundle: Mapping[str, Any]) -> dict[str, Any]:
        if bundle.get("kind") != "wells_logs":
            raise ValueError("CorrelationTemplate applies only to a wells_logs bundle")
        needed = {layer["mnemonic"] for track in self.tracks for layer in track.layers}
        available = {
            str(curve.get("mnemonic"))
            for well in bundle.get("wells", [])
            for curve in well.get("curves", [])
        }
        missing = sorted(needed - available)
        if missing:
            raise ValueError(f"template curve(s) absent from every well: {', '.join(missing)}")
        out = copy.deepcopy(dict(bundle))
        out["template"] = self.to_dict()
        # JSON value semantics are part of the persistence contract.
        json.dumps(out["template"], allow_nan=False, sort_keys=True)
        return out

    __call__ = apply
