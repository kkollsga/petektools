"""Assemble ``viewer.js`` from its ordered concat parts (build-time concat).

The viewer SPA is one shared-closure IIFE, maintained as ordered fragments under
``assets/viewer/`` (``NN-name.js``, one feature area per file: app core, chrome,
workspace shell, map, section, volume, wells, charts, overlays, panel+boot). They are **not**
standalone scripts or ES modules — the zero-CDN / zero-external-fetch constraint
rules out runtime imports, so the packaging layer concatenates them (in numeric
filename order, byte-for-byte) into the single ``viewer.js`` the page loads:
``serve()`` writes the assembled file next to ``index.html``; ``save_view()``
inlines the assembled source into the single-file export. Editing rule: a part
must begin exactly where the previous one ended — the assembled bundle is the
one source of truth the browser sees.
"""

from __future__ import annotations

from pathlib import Path

_ASSETS = Path(__file__).parent / "assets"
_PARTS_DIR = _ASSETS / "viewer"


def viewer_js() -> str:
    """The assembled ``viewer.js`` source: every ``assets/viewer/*.js`` part
    concatenated in sorted (numeric-prefix) filename order."""
    parts = sorted(_PARTS_DIR.glob("*.js"))
    if not parts:
        raise FileNotFoundError(f"no viewer.js parts found under {_PARTS_DIR}")
    return "".join(p.read_text() for p in parts)
