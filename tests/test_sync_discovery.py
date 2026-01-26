from opencode_mem.sync_discovery import mdns_addresses_for_peer


def test_mdns_addresses_for_peer_falls_back_to_ip_bytes() -> None:
    entries = [
        {
            "host": "",
            "port": 7337,
            "address": b"\xc0\xa8\x2a\x36",  # 192.168.42.54
            "properties": {b"device_id": b"peer-1"},
        }
    ]
    addresses = mdns_addresses_for_peer("peer-1", entries)
    assert addresses == ["192.168.42.54:7337"]


def test_mdns_addresses_ignores_service_name_host_when_ip_present() -> None:
    entries = [
        {
            "host": "peer-1._opencode-mem._tcp.local",
            "port": 7337,
            "address": b"\xc0\xa8\x2a\x36",  # 192.168.42.54
            "properties": {b"device_id": b"peer-1"},
        }
    ]
    addresses = mdns_addresses_for_peer("peer-1", entries)
    assert addresses == ["192.168.42.54:7337"]
