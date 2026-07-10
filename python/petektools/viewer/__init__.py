"""petektools.viewer — the horizontal bundle renderer (the viewer unit).

Domain-agnostic rendering of **typed JSON bundles**: map raster layers, vertical
section columns, and a corner-point cell mesh. The viewer carries no domain
knowledge and performs **no computation** — a consumer maps its domain bundle
onto the generic render schema (``SCHEMA.md``) and hands it here.

    from petektools import viewer

    viewer.serve(payload)                      # live local server (background)
    viewer.save_view(payload, "model.html")    # one self-contained HTML file

``serve`` accepts a ``section_provider`` callback — the pluggable ``/section``
endpoint by which a domain package answers live fence-draw / click-a-well
requests. ``save_view`` ships a frozen, render-only snapshot (pre-computed
sections only) that opens over ``file://`` with zero external fetches.

This unit ships as **petektools wheel package data**; the crates.io Rust kernel
crate excludes it (same treatment as the wheel sources) and stays lean.
"""

from pathlib import Path

from ._save import save_view
from ._server import build_server, serve
from ._view2d import view2d, view2d_payload
from ._view3d import view3d, view3d_payload

#: Directory of the packaged viewer assets (index.html + the three JS files).
ASSETS = Path(__file__).parent / "assets"

__all__ = [
    "serve",
    "build_server",
    "save_view",
    "view2d",
    "view2d_payload",
    "view3d",
    "view3d_payload",
    "ASSETS",
]
