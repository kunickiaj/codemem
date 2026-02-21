from __future__ import annotations

import datetime as dt
import logging
import os
import sys
import threading
import time

from .db import DEFAULT_DB_PATH
from .observer import ObserverAuthError
from .raw_event_flush import flush_raw_events
from .store import MemoryStore

logger = logging.getLogger(__name__)

# Back off for 5 minutes after an auth error before retrying (seconds).
_AUTH_BACKOFF_S = 300


class RawEventAutoFlusher:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._timers: dict[str, threading.Timer] = {}
        self._flushing: set[str] = set()

    def enabled(self) -> bool:
        return os.environ.get("CODEMEM_RAW_EVENTS_AUTO_FLUSH") == "1"

    def debounce_ms(self) -> int:
        value = os.environ.get("CODEMEM_RAW_EVENTS_DEBOUNCE_MS", "60000")
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
            store = MemoryStore(os.environ.get("CODEMEM_DB") or DEFAULT_DB_PATH)
            try:
                flush_raw_events(
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
        self._auth_backoff_until: float = 0.0  # epoch ms; skip flushes until this time
        self._auth_error_logged: bool = False

    def enabled(self) -> bool:
        value = (os.environ.get("CODEMEM_RAW_EVENTS_SWEEPER") or "1").strip().lower()
        return value not in {"0", "false", "off"}

    def interval_ms(self) -> int:
        value = os.environ.get("CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS", "30000")
        try:
            return int(value)
        except (TypeError, ValueError):
            return 30000

    def idle_ms(self) -> int:
        value = os.environ.get("CODEMEM_RAW_EVENTS_SWEEPER_IDLE_MS", "120000")
        try:
            return int(value)
        except (TypeError, ValueError):
            return 120000

    def limit(self) -> int:
        value = os.environ.get("CODEMEM_RAW_EVENTS_SWEEPER_LIMIT", "25")
        try:
            return int(value)
        except (TypeError, ValueError):
            return 25

    def worker_max_events(self) -> int | None:
        value = os.environ.get("CODEMEM_RAW_EVENTS_WORKER_MAX_EVENTS", "250")
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            parsed = 250
        if parsed <= 0:
            return None
        return parsed

    def retention_ms(self) -> int:
        value = os.environ.get("CODEMEM_RAW_EVENTS_RETENTION_MS", "0")
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0

    def stuck_batch_ms(self) -> int:
        value = os.environ.get("CODEMEM_RAW_EVENTS_STUCK_BATCH_MS", "300000")
        try:
            return int(value)
        except (TypeError, ValueError):
            return 300000

    def _handle_auth_error(self, exc: ObserverAuthError) -> None:
        """Set backoff and log once per backoff window."""
        self._auth_backoff_until = time.time() + _AUTH_BACKOFF_S
        if not self._auth_error_logged:
            self._auth_error_logged = True
            msg = (
                f"codemem: observer auth error — backing off for {_AUTH_BACKOFF_S}s. "
                f"Refresh your provider credentials or update observer_provider in settings. "
                f"({exc})"
            )
            logger.warning(msg)
            print(msg, file=sys.stderr)

    def tick(self) -> None:
        if not self.enabled():
            return

        # Skip observer-dependent flushes while backing off from an auth error.
        now = time.time()
        if now < self._auth_backoff_until:
            return
        # Backoff expired — reset so next auth error gets logged again.
        if self._auth_error_logged:
            self._auth_error_logged = False

        now_ms = int(now * 1000)
        idle_before = now_ms - self.idle_ms()
        store = MemoryStore(os.environ.get("CODEMEM_DB") or DEFAULT_DB_PATH)
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

            max_events = self.worker_max_events()
            drained: set[str] = set()
            queue_session_ids = store.raw_event_sessions_with_pending_queue(limit=self.limit())
            for opencode_session_id in queue_session_ids:
                try:
                    flush_raw_events(
                        store,
                        opencode_session_id=opencode_session_id,
                        cwd=None,
                        project=None,
                        started_at=None,
                        max_events=max_events,
                    )
                    drained.add(opencode_session_id)
                except ObserverAuthError as exc:
                    self._handle_auth_error(exc)
                    return  # Stop all flush work during auth backoff.
                except Exception as exc:
                    logger.exception(
                        "raw event queue worker flush failed",
                        extra={"opencode_session_id": opencode_session_id},
                        exc_info=exc,
                    )
                    if not logging.getLogger().hasHandlers():
                        print(
                            f"codemem: raw event queue worker flush failed"
                            f" for {opencode_session_id}: {exc}",
                            file=sys.stderr,
                        )
                    continue

            session_ids = store.raw_event_sessions_pending_idle_flush(
                idle_before_ts_wall_ms=idle_before,
                limit=self.limit(),
            )
            for opencode_session_id in session_ids:
                if opencode_session_id in drained:
                    continue
                try:
                    flush_raw_events(
                        store,
                        opencode_session_id=opencode_session_id,
                        cwd=None,
                        project=None,
                        started_at=None,
                        max_events=max_events,
                    )
                except ObserverAuthError as exc:
                    self._handle_auth_error(exc)
                    return  # Stop all flush work during auth backoff.
                except Exception as exc:
                    logger.exception(
                        "raw event sweeper flush failed",
                        extra={"opencode_session_id": opencode_session_id},
                        exc_info=exc,
                    )
                    if not logging.getLogger().hasHandlers():
                        print(
                            f"codemem: raw event sweeper flush failed"
                            f" for {opencode_session_id}: {exc}",
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
