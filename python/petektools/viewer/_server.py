"""The local viewer HTTP server — the viewer unit's live rendering surface.

Serves the packaged viewer assets + the caller's payload (as ``model.json``)
from a temp dir on ``127.0.0.1`` only, and adds one live endpoint —
``GET /section?line=..|well=..&property=..`` — routed to a caller-supplied
``section_provider`` callback. The callback is how a **domain** package answers
fence/well requests without the viewer unit knowing anything about the domain;
omit it for a render-only payload (the endpoint then replies ``501``).
"""

from __future__ import annotations

import http.server
import json
import shutil
import socketserver
import tempfile
import threading
import webbrowser
from pathlib import Path
from typing import Any, Callable, Optional, Union
from urllib.parse import parse_qs, urlparse

from ._bundle import viewer_js

_ASSETS = Path(__file__).parent / "assets"

#: A live-section callback: ``(line, well, property) -> JSON str | JSON-able``.
SectionProvider = Callable[..., Union[str, bytes, Any]]
#: A shell re-cut callback: ``(property, cutoff, keep_above) -> v3 envelope``
#: (a JSON str / bytes / JSON-able dict). The pluggable hook the viewer's
#: threshold "true interior" toggle calls so the server re-cuts the exterior
#: shell at a cutoff (exposing revealed interior faces). peteksim implements it.
VolumeProvider = Callable[..., Union[str, bytes, Any]]

Payload = Union[str, dict]


def _payload_str(payload: Payload) -> str:
    """Normalise a payload (dict *or* pre-serialized JSON string) to a string."""
    return payload if isinstance(payload, str) else json.dumps(payload)


def build_server(
    payload: Payload,
    *,
    port: int = 0,
    section_provider: Optional[SectionProvider] = None,
    volume_provider: Optional[VolumeProvider] = None,
    model_bin: Optional[bytes] = None,
):
    """Build (but do **not** start) the local viewer server.

    Returns ``(httpd, url)``. The server serves the packaged assets + the payload
    (``model.json``) and — when ``section_provider`` is given — a live
    ``GET /section`` endpoint that calls
    ``section_provider(line=<list|None>, well=<str|None>, property=<str|None>)``
    and returns whatever it produces (a JSON string, bytes, or a JSON-able
    object). All ``127.0.0.1``-only. The caller starts and later closes it.
    """
    payload_json = _payload_str(payload)
    tmp = Path(tempfile.mkdtemp(prefix="petek-view-"))
    for asset in _ASSETS.iterdir():
        if asset.is_file():
            shutil.copy(asset, tmp / asset.name)
    # viewer.js is assembled from its ordered concat parts (see `_bundle`).
    (tmp / "viewer.js").write_text(viewer_js())
    (tmp / "model.json").write_text(payload_json)
    # A v3 sidecar payload references a companion model.bin (raw LE blocks, no
    # base64 tax); serve it alongside so the viewer can fetch + slice it.
    if model_bin is not None:
        (tmp / "model.bin").write_bytes(model_bin)

    class _Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(tmp), **kw)

        def log_message(self, *args):  # keep the console quiet
            pass

        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/section":
                self._section()
                return
            if path == "/volume":
                self._volume()
                return
            super().do_GET()

        def _send(self, code: int, data: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _section(self):
            if section_provider is None:
                self._send(
                    501,
                    b"no section provider: this payload ships pre-computed sections only",
                    "text/plain",
                )
                return
            q = parse_qs(urlparse(self.path).query)
            line = q.get("line", [None])[0]
            well = q.get("well", [None])[0]
            prop = q.get("property", [None])[0]
            try:
                line_pts = json.loads(line) if line else None
                body = section_provider(line=line_pts, well=well, property=prop)
                if isinstance(body, bytes):
                    data = body
                elif isinstance(body, str):
                    data = body.encode("utf-8")
                else:
                    data = json.dumps(body).encode("utf-8")
                self._send(200, data, "application/json")
            except Exception as exc:  # a bad trace / missing well -> 400 with reason
                self._send(400, str(exc).encode("utf-8"), "text/plain")

        def _volume(self):
            if volume_provider is None:
                self._send(
                    501,
                    b"no volume provider: this payload uses the client-side shell filter only",
                    "text/plain",
                )
                return
            q = parse_qs(urlparse(self.path).query)
            prop = q.get("property", [None])[0]
            cutoff = q.get("cutoff", [None])[0]
            keep_above = q.get("keep_above", ["true"])[0] != "false"
            try:
                body = volume_provider(
                    property=prop,
                    cutoff=float(cutoff) if cutoff is not None else None,
                    keep_above=keep_above,
                )
                if isinstance(body, bytes):
                    data = body
                elif isinstance(body, str):
                    data = body.encode("utf-8")
                else:
                    data = json.dumps(body).encode("utf-8")
                self._send(200, data, "application/json")
            except Exception as exc:
                self._send(400, str(exc).encode("utf-8"), "text/plain")

    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), _Handler)
    httpd.daemon_threads = True
    url = f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd._petek_tmp = tmp  # remembered for cleanup
    return httpd, url


def serve(
    payload: Payload,
    *,
    port: int = 0,
    block: bool = False,
    open_browser: bool = True,
    section_provider: Optional[SectionProvider] = None,
    volume_provider: Optional[VolumeProvider] = None,
    model_bin: Optional[bytes] = None,
) -> str:
    """Serve the viewer for ``payload``; return the URL.

    Non-blocking by default: the server runs on a background daemon thread, the
    URL is printed, and control returns immediately (live fence-draw / click-a-well
    hit the ``/section`` endpoint via ``section_provider``). ``block=True`` serves
    in the foreground until ``Ctrl-C``. Pass ``open_browser=False`` to start the
    server without auto-opening a tab.
    """
    httpd, url = build_server(
        payload,
        port=port,
        section_provider=section_provider,
        volume_provider=volume_provider,
        model_bin=model_bin,
    )

    if block:
        print(f"petek viewer at {url}  (Ctrl-C to stop)", flush=True)
        if open_browser:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")
        finally:
            httpd.server_close()
            shutil.rmtree(httpd._petek_tmp, ignore_errors=True)
        return url

    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print(f"petek viewer at {url}  (background; pass block=True to hold)", flush=True)
    if open_browser:
        webbrowser.open(url)
    return url
