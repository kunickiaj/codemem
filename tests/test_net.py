from __future__ import annotations

import subprocess

from codemem import net


def test_interface_ipv4_candidates_include_utun_and_filter_low_signal_interfaces(
    monkeypatch,
) -> None:
    ifconfig_output = """
lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
    inet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
    inet 192.168.1.20 netmask 0xffffff00 broadcast 192.168.1.255
utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1380
    inet 10.11.12.13 --> 10.11.12.13 netmask 0xffffffff
awdl0: flags=8943<UP,BROADCAST,RUNNING,PROMISC,SIMPLEX,MULTICAST> mtu 1484
    inet 169.254.12.99 netmask 0xffff0000 broadcast 169.254.255.255
docker0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST> mtu 1500
    inet 172.17.0.1 netmask 255.255.0.0 broadcast 172.17.255.255
""".strip()

    def _fake_run(command, capture_output, text, check):
        if tuple(command) == ("ifconfig",):
            return subprocess.CompletedProcess(command, 0, stdout=ifconfig_output, stderr="")
        raise FileNotFoundError

    monkeypatch.setattr(net.subprocess, "run", _fake_run)

    assert net._interface_ipv4_candidates() == ["192.168.1.20", "10.11.12.13"]


def test_pick_advertise_hosts_auto_keeps_lan_first_then_tailscale(monkeypatch) -> None:
    monkeypatch.setattr(net, "_local_ipv4_candidates", lambda: ["192.168.1.20", "10.11.12.13"])
    monkeypatch.setattr(net, "_tailscale_ipv4", lambda: "100.99.10.1")

    assert net.pick_advertise_hosts("auto") == ["192.168.1.20", "10.11.12.13", "100.99.10.1"]


def test_pick_advertise_hosts_tailscale_mode_prioritizes_tailscale(monkeypatch) -> None:
    monkeypatch.setattr(net, "_local_ipv4_candidates", lambda: ["192.168.1.20", "100.99.10.1"])
    monkeypatch.setattr(net, "_tailscale_ipv4", lambda: "100.99.10.1")

    assert net.pick_advertise_hosts("tailscale") == ["100.99.10.1", "192.168.1.20"]
