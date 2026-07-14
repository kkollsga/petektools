"""The single-file viewer export — one self-contained HTML document.

Inlines the payload + all JS so the file opens over ``file://`` with **zero
external fetches**: three.js is a vendored classic global, the payload is
inlined as ``window.PETEK_VIEWER_PAYLOAD``, and a ``file`` mode flag disables the
live fence-draw (this export ships only pre-computed sections). Nothing loads off
the network — confidential data never leaves the machine.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional, Sequence, Union

from ._bundle import viewer_js

_ASSETS = Path(__file__).parent / "assets"

Payload = Union[str, dict]


def save_view(
    payload: Payload,
    path: Union[str, Path],
    *,
    precomputed_sections: Optional[Sequence[Any]] = None,
) -> None:
    """Write ONE self-contained HTML file (all JS + data inlined) to ``path``.

    ``payload`` is a render bundle — a dict *or* a pre-serialized JSON string (see
    ``SCHEMA.md``). ``precomputed_sections``, if given, is a list of section
    bundles appended to the payload's ``sections`` (with generated labels) so a
    static export can also ship sections a consumer computed in Python. The result
    opens over ``file://`` with no external resource loads of any kind.
    """
    if precomputed_sections:
        payload_obj = json.loads(payload) if isinstance(payload, str) else dict(payload)
        secs = list(payload_obj.get("sections") or [])
        labels = list(payload_obj.get("section_labels") or [])
        for section in precomputed_sections:
            secs.append(section)
            labels.append(f"Section {len(secs)}")
        payload_obj["sections"] = secs
        payload_obj["section_labels"] = labels
        payload_json = json.dumps(payload_obj)
    else:
        payload_json = payload if isinstance(payload, str) else json.dumps(payload)

    html = (_ASSETS / "index.html").read_text()

    def inline_code(code: str) -> str:
        # Hoisted out of the f-string: a backslash inside an f-string expression
        # is a SyntaxError before Python 3.12, and our floor is 3.10.
        safe_code = code.replace("</script>", "<\\/script>")
        return f"<script>\n{safe_code}\n</script>"

    def inline(script_name: str) -> str:
        return inline_code((_ASSETS / script_name).read_text())

    # Payload first, then every script inlined in load order (decode kernel →
    # three → orbitcontrols → viewer). Zero external fetches; the v3 binary blocks
    # are base64 inside the payload and the decode kernel + worker source are here
    # too, so a self-contained export decodes with no companion file.
    safe_json = payload_json.replace("</", "<\\/")
    payload_tag = (
        "<script>window.PETEK_VIEWER_PAYLOAD="
        + safe_json
        + ';window.PETEK_VIEWER_MODE="file";</script>'
    )
    html = html.replace(
        '<script src="./decode.js"></script>',
        payload_tag + "\n" + inline("decode.js"),
    )
    html = html.replace(
        '<script src="./three.global.js"></script>',
        inline("three.global.js"),
    )
    html = html.replace(
        '<script src="./orbitcontrols.global.js"></script>',
        inline("orbitcontrols.global.js"),
    )
    # viewer.js is assembled from its ordered concat parts (see `_bundle`).
    html = html.replace('<script src="./viewer.js"></script>', inline_code(viewer_js()))
    Path(path).write_text(html)


def save_workspace(
    session, path: Union[str, Path], *, include: str = "visible"
) -> None:
    """Freeze a workspace into the existing zero-network single-file export."""
    if include not in ("visible", "selected"):
        raise ValueError("workspace save include= must be 'visible' or 'selected'")
    payload = session.manifest()
    workspace = payload["workspace"]
    workspace["mode"] = "static"
    resources: dict[str, dict[str, Any]] = {}
    embedded: list[str] = []
    state: dict[str, dict[str, Any]] = {}
    for item in session._items.values():
        for view, _ in item.views:
            if include == "visible" and not item.visible_in(view):
                continue
            attributes = item.attributes_for(view)
            details = item.details_for(view)
            if item.shared_for(view):
                detail = (
                    "full"
                    if any(detail_id == "full" for detail_id, _ in details)
                    else item.active_detail(view)
                )
                resources.setdefault(item.id, {})[view] = session.resource(
                    item.id, view, detail=detail
                )
                state.setdefault(item.id, {})[view] = {
                    "active_attribute": item.active_attribute(view),
                    "active_color_by": item.active_color_by(view),
                    "mode": (item.modes_for(view) or ("2d",))[0],
                    "detail": detail,
                }
                embedded.append(
                    "::".join(
                        part for part in (item.id, view, detail) if part is not None
                    )
                )
                continue
            if attributes:
                if include == "selected" and len(attributes) > 1:
                    raise ValueError(
                        "selected static export cannot enumerate a multi-attribute "
                        "non-shared workspace v2 resource"
                    )
                attribute = item.active_attribute(view)
                color_by = item.active_color_by(view)
                detail = (
                    "full"
                    if any(detail_id == "full" for detail_id, _ in details)
                    else item.active_detail(view)
                )
                resources.setdefault(item.id, {})[view] = session.resource(
                    item.id,
                    view,
                    detail=detail,
                    attribute=attribute,
                    color_by=color_by,
                )
                state.setdefault(item.id, {})[view] = {
                    "active_attribute": attribute,
                    "active_color_by": color_by,
                    "detail": detail,
                }
                embedded.append(
                    "::".join(
                        part
                        for part in (item.id, view, attribute, color_by, detail)
                        if part is not None
                    )
                )
                continue
            lanes = item.lanes_for(view)
            if lanes or details:
                lane_ids = (
                    (
                        [item.active_lane(view)]
                        if include == "visible"
                        else [lane_id for lane_id, _ in lanes]
                    )
                    if lanes
                    else [None]
                )
                # A static file has no progressive network phase: freeze the
                # advertised complete tier directly and open on it offline.
                detail_ids = (
                    (
                        ["full"]
                        if any(detail_id == "full" for detail_id, _ in details)
                        else [item.active_detail(view)]
                    )
                    if details
                    else [None]
                )
                packed = [
                    session.resource(item.id, view, lane, detail)
                    for lane in lane_ids
                    for detail in detail_ids
                    if (not lanes or lane is not None)
                    and (not details or detail is not None)
                ]
                resources.setdefault(item.id, {})[view] = packed
                embedded.extend(
                    "::".join(
                        part
                        for part in (item.id, view, lane, detail)
                        if part is not None
                    )
                    for lane in lane_ids
                    for detail in detail_ids
                )
            else:
                resources.setdefault(item.id, {})[view] = session.resource(
                    item.id, view
                )
                embedded.append(f"{item.id}::{view}")
    workspace["resources"] = resources
    workspace["snapshot"] = {
        "include": include,
        "embedded": embedded,
        **({"state": state} if state else {}),
        "message": (
            "This static snapshot embeds initially visible resources only."
            if include == "visible"
            else "This static snapshot embeds every selected workspace resource and declared lane."
        ),
    }
    save_view(payload, path)
