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
        return f"<script>\n{code.replace('</script>', '<\\/script>')}\n</script>"

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
