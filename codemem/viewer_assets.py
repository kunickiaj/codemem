from __future__ import annotations

import mimetypes
import os
from importlib import resources
from pathlib import PurePosixPath

_INDEX_HTML: bytes | None = None
_APP_JS: bytes | None = None
_ASSET_CACHE: dict[str, bytes] = {}


def _no_cache_enabled() -> bool:
    return os.environ.get("CODEMEM_VIEWER_NO_CACHE") == "1"


def get_index_html_bytes() -> bytes:
    global _INDEX_HTML
    if _no_cache_enabled():
        return resources.files(__package__).joinpath("viewer_static/index.html").read_bytes()
    if _INDEX_HTML is None:
        _INDEX_HTML = resources.files(__package__).joinpath("viewer_static/index.html").read_bytes()
    return _INDEX_HTML


def get_app_js_bytes() -> bytes:
    global _APP_JS
    if _no_cache_enabled():
        return resources.files(__package__).joinpath("viewer_static/app.js").read_bytes()
    if _APP_JS is None:
        _APP_JS = resources.files(__package__).joinpath("viewer_static/app.js").read_bytes()
    return _APP_JS


def get_static_asset_bytes(asset_path: str) -> tuple[bytes, str]:
    """Return bytes + content-type for a packaged viewer_static asset."""

    clean = asset_path.strip().lstrip("/")
    path = PurePosixPath(clean)
    if not clean or path.is_absolute() or ".." in path.parts:
        raise ValueError("invalid asset path")

    key = str(path)
    cached: bytes | None = None
    if not _no_cache_enabled():
        cached = _ASSET_CACHE.get(key)
    if cached is None:
        cached = resources.files(__package__).joinpath("viewer_static").joinpath(key).read_bytes()
        if not _no_cache_enabled():
            _ASSET_CACHE[key] = cached

    content_type = mimetypes.guess_type(key)[0] or "application/octet-stream"
    if content_type.startswith("text/"):
        content_type = f"{content_type}; charset=utf-8"
    return cached, content_type
