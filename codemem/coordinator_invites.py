from __future__ import annotations

import base64
import json
from typing import TypedDict
from urllib.parse import parse_qs, quote, urlparse


class InvitePayload(TypedDict):
    v: int
    kind: str
    coordinator_url: str
    group_id: str
    policy: str
    token: str
    expires_at: str
    team_name: str | None


def encode_invite_payload(payload: InvitePayload) -> str:
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_invite_payload(value: str) -> InvitePayload:
    padding = "=" * (-len(value) % 4)
    data = json.loads(base64.urlsafe_b64decode(value + padding).decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("invalid invite payload")
    return data  # type: ignore[return-value]


def invite_link(encoded_payload: str) -> str:
    return f"codemem://join?invite={quote(encoded_payload)}"


def extract_invite_payload(value: str) -> str:
    raw = value.strip()
    if raw.startswith("codemem://"):
        parsed = urlparse(raw)
        invite = parse_qs(parsed.query).get("invite", [""])[0]
        if not invite:
            raise ValueError("invite payload missing from link")
        return invite
    return raw
