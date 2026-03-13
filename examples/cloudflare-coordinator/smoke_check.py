from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib import error, request

from codemem import db
from codemem.sync_auth import build_auth_headers
from codemem.sync_identity import ensure_device_identity, load_public_key


def _json_request(
    method: str, url: str, *, headers: dict[str, str], body: dict | None = None
) -> dict:
    body_bytes = None
    if body is not None:
        body_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = request.Request(url, data=body_bytes, headers=headers, method=method)
    try:
        with request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"{method} {url} failed with HTTP {exc.code}: {detail}") from exc


def main() -> None:
    parser = argparse.ArgumentParser(description="Smoke-check a deployed Cloudflare coordinator")
    parser.add_argument("--db", required=True, help="Path to local codemem SQLite DB")
    parser.add_argument("--url", required=True, help="Coordinator base URL")
    parser.add_argument("--group", required=True, help="Coordinator group ID")
    parser.add_argument(
        "--advertise",
        action="append",
        default=[],
        help="Explicit address to advertise (repeatable). Defaults to no addresses.",
    )
    parser.add_argument("--keys-dir", default=None, help="Optional CODEMEM_KEYS_DIR override")
    args = parser.parse_args()

    db_path = Path(args.db).expanduser()
    keys_dir = Path(args.keys_dir).expanduser() if args.keys_dir else None
    conn = db.connect(db_path)
    try:
        device_id, fingerprint = ensure_device_identity(conn, keys_dir=keys_dir)
    finally:
        conn.close()
    public_key = load_public_key(keys_dir)
    if not public_key:
        raise SystemExit("public key missing")

    base_url = args.url.rstrip("/")
    presence_url = f"{base_url}/v1/presence"
    peers_url = f"{base_url}/v1/peers?group_id={args.group}"
    presence_body = {
        "group_id": args.group,
        "fingerprint": fingerprint,
        "public_key": public_key,
        "addresses": args.advertise,
        "ttl_s": 180,
    }
    presence_headers = build_auth_headers(
        device_id=device_id,
        method="POST",
        url=presence_url,
        body_bytes=json.dumps(presence_body, ensure_ascii=False).encode("utf-8"),
        keys_dir=keys_dir,
    )
    peers_headers = build_auth_headers(
        device_id=device_id,
        method="GET",
        url=peers_url,
        body_bytes=b"",
        keys_dir=keys_dir,
    )

    print(
        json.dumps(
            _json_request("POST", presence_url, headers=presence_headers, body=presence_body),
            indent=2,
        )
    )
    print(json.dumps(_json_request("GET", peers_url, headers=peers_headers), indent=2))


if __name__ == "__main__":
    main()
