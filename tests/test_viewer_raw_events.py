from __future__ import annotations

from codemem import viewer, viewer_raw_events


def test_viewer_raw_events_reexports() -> None:
    assert viewer.RawEventAutoFlusher is viewer_raw_events.RawEventAutoFlusher
    assert viewer.RawEventSweeper is viewer_raw_events.RawEventSweeper
    assert viewer.RAW_EVENT_FLUSHER is viewer_raw_events.RAW_EVENT_FLUSHER
    assert viewer.RAW_EVENT_SWEEPER is viewer_raw_events.RAW_EVENT_SWEEPER
    assert viewer.flush_raw_events is viewer_raw_events.flush_raw_events
