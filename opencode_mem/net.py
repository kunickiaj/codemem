from __future__ import annotations

import socket
import subprocess


def _tailscale_ipv4() -> str | None:
    try:
        result = subprocess.run(
            ["tailscale", "ip", "-4"],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return None
    if result.returncode != 0:
        return None
    for line in result.stdout.splitlines():
        value = line.strip()
        if value:
            return value
    return None


def _primary_lan_ipv4() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]
    except OSError:
        return None
    return ip if ip and not ip.startswith("127.") else None


def _local_ipv4_candidates() -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()

    def _add(value: str | None) -> None:
        if not value:
            return
        cleaned = value.strip()
        if not cleaned or cleaned.startswith("127.") or cleaned == "0.0.0.0":
            return
        if cleaned in seen:
            return
        seen.add(cleaned)
        candidates.append(cleaned)

    _add(_primary_lan_ipv4())

    try:
        host = socket.gethostname()
        for ip in socket.gethostbyname_ex(host)[2]:
            _add(ip)
        for info in socket.getaddrinfo(host, None, family=socket.AF_INET):
            addr = info[4][0] if info and info[4] else None
            if isinstance(addr, str):
                _add(addr)
    except Exception:
        pass

    return candidates


def pick_advertise_hosts(value: str | None) -> list[str]:
    if not value:
        return []
    lowered = value.strip().lower()
    if lowered in {"none", "off"}:
        return []
    if lowered in {"auto", "default"}:
        # Prefer LAN first for same-network pairing; include Tailscale as fallback.
        lan = _local_ipv4_candidates()
        ts = _tailscale_ipv4()
        return [*lan, *([ts] if ts and ts not in lan else [])]
    if lowered in {"lan", "local"}:
        return _local_ipv4_candidates()
    if lowered in {"tailscale", "ts"}:
        ts = _tailscale_ipv4()
        lan = _local_ipv4_candidates()
        return [*([ts] if ts else []), *[ip for ip in lan if ip != ts]]
    return [value.strip()]


def pick_advertise_host(value: str | None) -> str | None:
    hosts = pick_advertise_hosts(value)
    return hosts[0] if hosts else None
