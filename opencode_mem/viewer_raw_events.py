from __future__ import annotations

import datetime as dt
import logging
import os
import sys
import threading
import time

from .db import DEFAULT_DB_PATH
from .raw_event_flush import flush_raw_events  # noqa: F401
from .store import MemoryStore

logger = logging.getLogger(__name__)


class RawEventAutoFlusher:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._timers: dict[str, threading.Timer] = {}
        self._flushing: set[str] = set()

    def enabled(self) -> bool:
        return os.environ.get("OPENCODE_MEM_RAW_EVENTS_AUTO_FLUSH") == "1"

    def debounce_ms(self) -> int:
        value = os.environ.get("OPENCODE_MEM_RAW_EVENTS_DEBOUNCE_MS", "60000")
        try:
            return int(value)
        except (TypeError, ValueError):
            return 60000

    def note_activity(self, opencode_session_id: str) -> None:
        if not opencode_session_id:
            return
        if not self.enabled():
            return
        delay_ms = self.debounce_ms()
        if delay_ms <= 0:
            self.flush_now(opencode_session_id)
            return
        with self._lock:
            existing = self._timers.pop(opencode_session_id, None)
            if existing:
                existing.cancel()
            timer = threading.Timer(delay_ms / 1000.0, self.flush_now, args=(opencode_session_id,))
            timer.daemon = True
            self._timers[opencode_session_id] = timer
            timer.start()

    def flush_now(self, opencode_session_id: str) -> None:
        if not opencode_session_id:
            return
        with self._lock:
            if opencode_session_id in self._flushing:
                return
            self._flushing.add(opencode_session_id)
            timer = self._timers.pop(opencode_session_id, None)
        if timer:
            timer.cancel()
        try:
            store = MemoryStore(os.environ.get("OPENCODE_MEM_DB") or DEFAULT_DB_PATH)
            try:
                from . import viewer as _viewer

                _viewer.flush_raw_events(
                    store,
                    opencode_session_id=opencode_session_id,
                    cwd=None,
                    project=None,
                    started_at=None,
                    max_events=None,
                )
            finally:
                store.close()
        finally:
            with self._lock:
                self._flushing.discard(opencode_session_id)


RAW_EVENT_FLUSHER = RawEventAutoFlusher()


class RawEventSweeper:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def enabled(self) -> bool:
        value = (os.environ.get("OPENCODE_MEM_RAW_EVENTS_SWEEPER") or "1").strip().lower()
        return value not in {"0", "false", "off"}

    def interval_ms(self) -> int:
        value = os.environ.get("OPENCODE_MEM_RAW_EVENTS_SWEEPER_INTERVAL_MS", "30000")
        try:
            return int(value)
        except (TypeError, ValueError):
            return 30000

    def idle_ms(self) -> int:
        value = os.environ.get("OPENCODE_MEM_RAW_EVENTS_SWEEPER_IDLE_MS", "120000")
        try:
            return int(value)
        except (TypeError, ValueError):
            return 120000

    def limit(self) -> int:
        value = os.environ.get("OPENCODE_MEM_RAW_EVENTS_SWEEPER_LIMIT", "25")
        try:
            return int(value)
        except (TypeError, ValueError):
            return 25

    def retention_ms(self) -> int:
        value = os.environ.get("OPENCODE_MEM_RAW_EVENTS_RETENTION_MS", "0")
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0

    def stuck_batch_ms(self) -> int:
        value = os.environ.get("OPENCODE_MEM_RAW_EVENTS_STUCK_BATCH_MS", "300000")
        try:
            return int(value)
        except (TypeError, ValueError):
            return 300000

    def tick(self) -> None:
        if not self.enabled():
            return
        now_ms = int(time.time() * 1000)
        idle_before = now_ms - self.idle_ms()
        store = MemoryStore(os.environ.get("OPENCODE_MEM_DB") or DEFAULT_DB_PATH)
        try:
            retention_ms = self.retention_ms()
            if retention_ms > 0:
                store.purge_raw_events(retention_ms)

            stuck_ms = self.stuck_batch_ms()
            if stuck_ms > 0:
                cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(milliseconds=stuck_ms)
                store.mark_stuck_raw_event_batches_as_error(
                    older_than_iso=cutoff.isoformat(),
                    limit=100,
                )

            session_ids = store.raw_event_sessions_pending_idle_flush(
                idle_before_ts_wall_ms=idle_before,
                limit=self.limit(),
            )
            for opencode_session_id in session_ids:
                try:
                    from . import viewer as _viewer

                    _viewer.flush_raw_events(
                        store,
                        opencode_session_id=opencode_session_id,
                        cwd=None,
                        project=None,
                        started_at=None,
                        max_events=None,
                    )
                except Exception as exc:
                    # Never silently swallow flush failures: they can cause the backlog to grow
                    # indefinitely and mask observer/auth issues.
                    logger.exception(
                        "raw event sweeper flush failed",
                        extra={"opencode_session_id": opencode_session_id},
                        exc_info=exc,
                    )
                    if not logging.getLogger().hasHandlers():
                        print(
                            f"opencode-mem: raw event sweeper flush failed for {opencode_session_id}: {exc}",
                            file=sys.stderr,
                        )
                    continue
        finally:
            store.close()

    def start(self) -> None:
        if not self.enabled():
            return
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        interval_ms = max(1000, self.interval_ms())
        while not self._stop.wait(interval_ms / 1000.0):
            self.tick()


RAW_EVENT_SWEEPER = RawEventSweeper()
