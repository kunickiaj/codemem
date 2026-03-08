from __future__ import annotations

from codemem import viewer, viewer_raw_events
from codemem.config import OpencodeMemConfig


def test_viewer_raw_events_reexports() -> None:
    assert viewer.RawEventAutoFlusher is viewer_raw_events.RawEventAutoFlusher
    assert viewer.RawEventSweeper is viewer_raw_events.RawEventSweeper
    assert viewer.RAW_EVENT_FLUSHER is viewer_raw_events.RAW_EVENT_FLUSHER
    assert viewer.RAW_EVENT_SWEEPER is viewer_raw_events.RAW_EVENT_SWEEPER
    assert viewer.flush_raw_events is viewer_raw_events.flush_raw_events


def test_raw_event_sweeper_interval_uses_config_when_env_unset(
    monkeypatch,
) -> None:
    sweeper = viewer_raw_events.RawEventSweeper()
    cfg = OpencodeMemConfig(raw_events_sweeper_interval_s=42)
    monkeypatch.delenv("CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS", raising=False)
    monkeypatch.setattr(viewer_raw_events, "load_config", lambda: cfg)

    assert sweeper.interval_ms() == 42000


def test_raw_event_sweeper_interval_prefers_env_ms(monkeypatch) -> None:
    sweeper = viewer_raw_events.RawEventSweeper()
    monkeypatch.setenv("CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS", "5000")
    monkeypatch.setattr(
        viewer_raw_events,
        "load_config",
        lambda: OpencodeMemConfig(raw_events_sweeper_interval_s=42),
    )

    assert sweeper.interval_ms() == 5000


def test_raw_event_sweeper_config_change_wakes_worker() -> None:
    sweeper = viewer_raw_events.RawEventSweeper()

    assert sweeper._wake.is_set() is False
    sweeper.notify_config_changed()
    assert sweeper._wake.is_set() is True


def test_raw_event_sweeper_reset_auth_backoff_clears_state() -> None:
    sweeper = viewer_raw_events.RawEventSweeper()
    sweeper._auth_backoff_until = 123.0
    sweeper._auth_error_logged = True

    sweeper.reset_auth_backoff()

    assert sweeper._auth_backoff_until == 0.0
    assert sweeper._auth_error_logged is False
    assert sweeper._wake.is_set() is True
