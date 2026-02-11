from __future__ import annotations

from collections.abc import Callable
from typing import Any


def capture_context(
    cwd: str,
    *,
    capture_pre: Callable[[str], dict[str, Any]],
    capture_post: Callable[[str], dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    pre = capture_pre(cwd)
    post = capture_post(cwd)
    return pre, post


def build_artifacts(
    pre: dict[str, Any],
    post: dict[str, Any],
    transcript: str,
    *,
    build_bundle: Callable[..., list[tuple[str, str, str | None]]],
) -> list[tuple[str, str, str | None]]:
    return build_bundle(pre, post, transcript)
