"""Shared well adapters and serializable rendering styles for 2-D and 3-D."""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace as dc_replace
from typing import Any, Iterable, Mapping


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


def _color(value: Any, label: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise TypeError(f"{label} must be a non-empty CSS color string or None")
    return value.strip()


@dataclass(frozen=True)
class WellPathStyle:
    """Trajectory stroke. Common kwargs stay flat; ``dash`` is opt-in detail."""

    color: str | None = None
    width: float = 2.0
    opacity: float = 0.9
    dash: tuple[float, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "color", _color(self.color, "path color"))
        object.__setattr__(self, "width", _positive(self.width, "path width"))
        opacity = _finite(self.opacity, "path opacity")
        if not 0 <= opacity <= 1:
            raise ValueError("path opacity must be between 0 and 1")
        object.__setattr__(self, "opacity", opacity)
        dash = tuple(_positive(v, "path dash") for v in self.dash)
        object.__setattr__(self, "dash", dash)

    def replace(self, **changes: Any) -> "WellPathStyle":
        return dc_replace(self, **changes)

    def to_dict(self) -> dict[str, Any]:
        return {"color": self.color, "width": self.width, "opacity": self.opacity, "dash": list(self.dash)}

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "WellPathStyle":
        return cls(**dict(value))


@dataclass(frozen=True)
class WellMarkerStyle:
    """Screen-space wellhead marker style."""

    size: float = 7.0
    fill: str | None = None
    stroke: str | None = None
    stroke_width: float = 2.0
    shape: str = "circle"

    def __post_init__(self) -> None:
        object.__setattr__(self, "size", _positive(self.size, "marker size"))
        object.__setattr__(self, "fill", _color(self.fill, "marker fill"))
        object.__setattr__(self, "stroke", _color(self.stroke, "marker stroke"))
        object.__setattr__(self, "stroke_width", _positive(self.stroke_width, "marker stroke_width"))
        if self.shape not in {"circle", "diamond", "square"}:
            raise ValueError("marker shape must be 'circle', 'diamond', or 'square'")

    def replace(self, **changes: Any) -> "WellMarkerStyle":
        return dc_replace(self, **changes)

    def to_dict(self) -> dict[str, Any]:
        return {
            "size": self.size,
            "fill": self.fill,
            "stroke": self.stroke,
            "stroke_width": self.stroke_width,
            "shape": self.shape,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "WellMarkerStyle":
        return cls(**dict(value))


@dataclass(frozen=True)
class WellLabelStyle:
    """Crisp screen-space label and collision-leader style."""

    color: str | None = None
    font_size: float = 11.0
    halo: bool = True
    leader: bool = True
    max_displacement: float = 72.0

    def __post_init__(self) -> None:
        object.__setattr__(self, "color", _color(self.color, "label color"))
        object.__setattr__(self, "font_size", _positive(self.font_size, "label font_size"))
        object.__setattr__(
            self, "max_displacement", _positive(self.max_displacement, "label max_displacement")
        )

    def replace(self, **changes: Any) -> "WellLabelStyle":
        return dc_replace(self, **changes)

    def to_dict(self) -> dict[str, Any]:
        return {
            "color": self.color,
            "font_size": self.font_size,
            "halo": bool(self.halo),
            "leader": bool(self.leader),
            "max_displacement": self.max_displacement,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "WellLabelStyle":
        return cls(**dict(value))


@dataclass(frozen=True)
class WellStyle:
    """Shared 2-D/3-D well style with progressively disclosed sub-styles."""

    path: WellPathStyle = field(default_factory=WellPathStyle)
    marker: WellMarkerStyle = field(default_factory=WellMarkerStyle)
    label: WellLabelStyle = field(default_factory=WellLabelStyle)

    def __post_init__(self) -> None:
        if isinstance(self.path, Mapping):
            object.__setattr__(self, "path", WellPathStyle.from_dict(self.path))
        if isinstance(self.marker, Mapping):
            object.__setattr__(self, "marker", WellMarkerStyle.from_dict(self.marker))
        if isinstance(self.label, Mapping):
            object.__setattr__(self, "label", WellLabelStyle.from_dict(self.label))
        if not isinstance(self.path, WellPathStyle):
            raise TypeError("WellStyle.path must be WellPathStyle or a mapping")
        if not isinstance(self.marker, WellMarkerStyle):
            raise TypeError("WellStyle.marker must be WellMarkerStyle or a mapping")
        if not isinstance(self.label, WellLabelStyle):
            raise TypeError("WellStyle.label must be WellLabelStyle or a mapping")

    def replace(self, **changes: Any) -> "WellStyle":
        return dc_replace(self, **changes)

    def to_dict(self) -> dict[str, Any]:
        return {
            "spec": "WellStyle",
            "schema_version": 1,
            "path": self.path.to_dict(),
            "marker": self.marker.to_dict(),
            "label": self.label.to_dict(),
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "WellStyle":
        data = dict(value)
        spec = data.pop("spec", "WellStyle")
        version = data.pop("schema_version", 1)
        if spec != "WellStyle" or version != 1:
            raise ValueError(f"unsupported well style {spec!r} schema version {version!r}")
        return cls(**data)


def coerce_well_style(value: WellStyle | Mapping[str, Any] | None) -> WellStyle:
    if value is None:
        return WellStyle()
    if isinstance(value, WellStyle):
        return value
    if isinstance(value, Mapping):
        return WellStyle.from_dict(value)
    raise TypeError("well_style must be WellStyle, a mapping, or None")


def normalize_wells(
    source: Any,
    *,
    labels: bool | str,
    style: WellStyle | Mapping[str, Any] | None,
) -> list[dict[str, Any]]:
    """Normalize bare wells, collection ducks, and explicit wire dictionaries."""
    if labels not in (False, True, "auto"):
        raise ValueError("well_labels must be False, True, or 'auto'")
    if source is None:
        return []
    shared = coerce_well_style(style)
    entries: list[dict[str, Any]] = []
    for raw in _well_objects(source):
        entries.extend(_one_or_bores(raw, shared))
    show = bool(labels is True or (labels == "auto" and len(entries) <= 12))
    for entry in entries:
        entry["label"] = show
    return entries


def _well_objects(source: Any) -> list[Any]:
    if _looks_like_well(source) or _is_explicit(source):
        return [source]
    values = getattr(source, "values", None)
    if callable(values):
        try:
            rows = list(values())
            if rows:
                return rows
        except (TypeError, AttributeError):
            pass
    if isinstance(source, Iterable) and not isinstance(source, (str, bytes, Mapping)):
        return list(source)
    raise TypeError("wells must be a well, an iterable/project-wells collection, or explicit dict entries")


def _is_explicit(value: Any) -> bool:
    return isinstance(value, Mapping) and ("trajectory" in value or "object" in value)


def _looks_like_well(value: Any) -> bool:
    return any(getattr(value, key, None) is not None for key in ("trajectory", "bores", "sidetrack"))


def _one_or_bores(raw: Any, shared: WellStyle) -> list[dict[str, Any]]:
    if isinstance(raw, Mapping):
        if "object" in raw:
            allowed = {"object", "name", "style"}
            extra = set(raw) - allowed
            if extra:
                raise ValueError(f"unknown well dict key(s): {sorted(extra)}")
            obj = raw["object"]
            name = raw.get("name")
            own = coerce_well_style(raw.get("style", shared))
            return _object_entries(obj, own, name)
        return [_wire_entry(raw, shared)]
    return _object_entries(raw, shared, None)


def _object_entries(obj: Any, style: WellStyle, name: Any) -> list[dict[str, Any]]:
    bores = getattr(obj, "bores", None)
    sidetrack = getattr(obj, "sidetrack", None)
    if callable(bores) and callable(sidetrack):
        labels = list(bores())
        if labels:
            out = []
            base = _identity(obj, name, "well")
            for bore in labels:
                st = sidetrack(bore)
                if st is None:
                    continue
                suffix = str(bore).strip()
                out.append(_entry(st, f"{base}/{suffix}" if suffix else base, style, head=getattr(obj, "head", None)))
            if out:
                return out
    return [_entry(obj, _identity(obj, name, "well"), style, head=getattr(obj, "head", None))]


def _wire_entry(raw: Mapping[str, Any], shared: WellStyle) -> dict[str, Any]:
    allowed = {"id", "name", "display_name", "x", "y", "trajectory", "style", "ties"}
    extra = set(raw) - allowed
    if extra:
        raise ValueError(f"unknown explicit well key(s): {sorted(extra)}")
    wid = raw.get("id", raw.get("name"))
    if wid is None:
        raise TypeError("explicit well dict requires 'id' or 'name'")
    rows = _rows(raw.get("trajectory", []), "explicit well trajectory")
    x = raw.get("x", rows[0][0] if rows else None)
    y = raw.get("y", rows[0][1] if rows else None)
    if x is None or y is None:
        raise TypeError("explicit well dict requires x/y or a non-empty trajectory")
    out = {
        "id": str(wid),
        "display_name": str(raw.get("display_name", wid)),
        "x": _finite(x, "well x"),
        "y": _finite(y, "well y"),
        "trajectory": rows,
        "style": coerce_well_style(raw.get("style", shared)).to_dict(),
    }
    if "ties" in raw:
        out["ties"] = raw["ties"]
    return out


def _entry(obj: Any, wid: str, style: WellStyle, *, head: Any = None) -> dict[str, Any]:
    rows = _trajectory_rows(obj)
    h = head() if callable(head) else head
    if h is not None:
        hv = list(h)
        x, y = _finite(hv[0], "wellhead x"), _finite(hv[1], "wellhead y")
    elif rows:
        x, y = rows[0][0], rows[0][1]
    else:
        raise TypeError(f"well {wid!r} offers neither a trajectory nor a head")
    return {
        "id": wid,
        "display_name": wid,
        "x": x,
        "y": y,
        "trajectory": rows,
        "style": style.to_dict(),
    }


def _identity(obj: Any, override: Any, fallback: str) -> str:
    if override is not None:
        return str(override)
    for key in ("id", "name", "label"):
        value = getattr(obj, key, None)
        if value is not None and not callable(value):
            return str(value)
    return fallback


def _trajectory_rows(obj: Any) -> list[list[float | None]]:
    traj = getattr(obj, "trajectory", None)
    if traj is not None:
        return _rows(traj() if callable(traj) else traj, f"trajectory on {type(obj).__name__}")
    md_range = getattr(obj, "md_range", None)
    xyz = getattr(obj, "xyz", None)
    if callable(md_range) and callable(xyz):
        span = md_range()
        if span is None:
            return []
        lo, hi = float(span[0]), float(span[1])
        n = 128
        samples = (xyz(lo + (hi - lo) * q / (n - 1)) for q in range(n))
        return _rows((p for p in samples if p is not None), f"xyz() on {type(obj).__name__}")
    return []


def _rows(rows: Any, label: str) -> list[list[float | None]]:
    out: list[list[float | None]] = []
    for row in rows or []:
        vals = list(row)
        if len(vals) < 2:
            raise TypeError(f"{label} must yield [x, y, z?] rows, got {row!r}")
        z = None
        if len(vals) > 2 and vals[2] is not None:
            zf = float(vals[2])
            z = zf if math.isfinite(zf) else None
        out.append([_finite(vals[0], "trajectory x"), _finite(vals[1], "trajectory y"), z])
    return out
