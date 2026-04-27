"""
Sliding Window Buffer — per-session rolling event buffer.

Uses collections.deque with maxlen=WINDOW_SIZE as the core data structure.
deque with maxlen provides O(1) append and automatic eviction of the oldest
element when full — no manual index management, no resizing allocations.

Thread safety:
    Each SlidingWindow instance is owned exclusively by one active gRPC stream
    (one concurrent call to StreamEvents). The Python gRPC servicer runs each
    RPC in its own thread from the ThreadPoolExecutor. Therefore, one window
    instance is never shared across threads — no locking is needed at the
    instance level.

    The WindowRegistry (which maps session_id → SlidingWindow) IS accessed
    from multiple threads (one per concurrent gRPC RPC). The registry uses a
    threading.Lock for all mutations (register/evict) but NOT for reads during
    event processing — reads happen within the owning stream thread.

Memory eviction strategy:
    See WindowRegistry.evict() and the Phase 5 summary below for the full
    strategy. Short version: eviction is deterministic on stream termination,
    not GC-dependent. The deque itself is unreachable once evicted → CPython
    reference-counting reclaims it immediately (no GC cycle needed).
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Optional

import numpy as np
import structlog

log = structlog.get_logger(__name__)

# ─── Constants ────────────────────────────────────────────────────────────────

WINDOW_SIZE: int = 50       # Number of events per inference window
N_FEATURES:  int = 6        # Feature vector dimensionality (must match LSTM input)

# Orphan TTL: if no event has been received for this many seconds, the window
# is considered orphaned and will be evicted by the reaper thread.
ORPHAN_TTL_SECONDS: int = 120


# ─── SlidingWindow ────────────────────────────────────────────────────────────

class SlidingWindow:
    """
    Rolling buffer of feature vectors for a single authenticated session.

    Lifecycle:
        __init__  → empty deque, zero event count
        push()    → append feature vector; returns True when window is full
        get_array() → returns (WINDOW_SIZE, N_FEATURES) numpy array for LSTM
        reset()   → clear buffer (called after inference to start next window)
        mark_closed() → signals the buffer is no longer active (for reaper)
    """

    __slots__ = (
        '_buf', '_session_id', '_created_at', '_last_event_at',
        '_event_count', '_closed',
    )

    def __init__(self, session_id: str) -> None:
        self._buf: deque[list[float]] = deque(maxlen=WINDOW_SIZE)
        self._session_id = session_id
        self._created_at = time.monotonic()
        self._last_event_at = time.monotonic()
        self._event_count: int = 0
        self._closed: bool = False

    def push(self, feature_vector: list[float]) -> bool:
        """
        Append a feature vector.

        Returns True when the deque has reached WINDOW_SIZE entries and is
        ready for inference. The caller is responsible for calling get_array()
        then reset() immediately after receiving True.
        """
        if self._closed:
            return False

        if len(feature_vector) != N_FEATURES:
            raise ValueError(
                f"Feature vector length {len(feature_vector)} != expected {N_FEATURES}"
            )

        self._buf.append(feature_vector)
        self._event_count += 1
        self._last_event_at = time.monotonic()

        return len(self._buf) == WINDOW_SIZE

    def get_array(self) -> np.ndarray:
        """
        Return the current buffer as a (WINDOW_SIZE, N_FEATURES) float32 array.

        Called only when push() returns True (buffer is full).
        Shape is validated to catch any deque size mismatch before LSTM inference.
        """
        arr = np.array(list(self._buf), dtype=np.float32)
        assert arr.shape == (WINDOW_SIZE, N_FEATURES), (
            f"Window shape mismatch: {arr.shape} != ({WINDOW_SIZE}, {N_FEATURES})"
        )
        return arr

    def reset(self) -> None:
        """
        Clear the buffer after a successful inference window.
        Retains the last WINDOW_SIZE//2 events as overlap for the next window
        (50% overlap strategy reduces boundary effects at window edges).
        """
        # Keep the second half as seed for the next window (overlap)
        overlap_start = WINDOW_SIZE // 2
        overlap = list(self._buf)[overlap_start:]
        self._buf.clear()
        for vec in overlap:
            self._buf.append(vec)

    def mark_closed(self) -> None:
        """
        Signal that this session's stream has terminated.
        After this call, push() is a no-op and the reaper can evict this window.
        """
        self._closed = True

    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def is_full(self) -> bool:
        return len(self._buf) == WINDOW_SIZE

    @property
    def size(self) -> int:
        return len(self._buf)

    @property
    def event_count(self) -> int:
        return self._event_count

    @property
    def is_closed(self) -> bool:
        return self._closed

    @property
    def idle_seconds(self) -> float:
        return time.monotonic() - self._last_event_at


# ─── WindowRegistry ───────────────────────────────────────────────────────────

class WindowRegistry:
    """
    Thread-safe registry mapping session_id → SlidingWindow.

    Memory eviction strategy (three complementary layers):

    Layer 1 — Deterministic on-stream-termination eviction:
        When a gRPC StreamEvents RPC completes (client disconnect, server half-close,
        or error), the servicer calls evict(session_id). This is the primary path —
        it runs synchronously in the stream's own thread, immediately calls
        window.mark_closed() and removes the reference from the dict. In CPython,
        reference counting drops to zero at this point → deque memory is released
        immediately (no GC cycle needed). This handles >99% of cases cleanly.

    Layer 2 — Orphan reaper thread:
        A background daemon thread runs every REAPER_INTERVAL_SECONDS.
        It sweeps the registry for windows that are:
          (a) marked closed but somehow not evicted (edge case: evict() raised), OR
          (b) not closed but idle for > ORPHAN_TTL_SECONDS (network zombie sessions —
              client socket gone but gRPC stream not cleanly terminated).
        Orphans are evicted immediately. The reaper thread is a daemon → it does
        not prevent process exit.

    Layer 3 — maxlen deque auto-eviction:
        Even if Layer 1 and 2 both fail, the deque's maxlen=WINDOW_SIZE bounds
        the per-window memory to at most WINDOW_SIZE * N_FEATURES * 4 bytes
        (50 × 6 × 4 = 1,200 bytes per window). 10,000 zombie windows would consume
        only ~12 MB — bounded, not unbounded growth.
    """

    REAPER_INTERVAL_SECONDS: int = 30

    def __init__(self) -> None:
        self._windows: dict[str, SlidingWindow] = {}
        self._lock = threading.Lock()
        self._start_reaper()

    def get_or_create(self, session_id: str) -> SlidingWindow:
        """Return the existing window for a session, or create a new one."""
        with self._lock:
            if session_id not in self._windows:
                self._windows[session_id] = SlidingWindow(session_id)
                log.info("window.created", session_id=session_id,
                         total_windows=len(self._windows))
            return self._windows[session_id]

    def get(self, session_id: str) -> Optional[SlidingWindow]:
        """Return the window for a session, or None if not registered."""
        with self._lock:
            return self._windows.get(session_id)

    def evict(self, session_id: str) -> None:
        """
        Deterministically evict a session's window.
        Marks the window closed then removes it from the registry.
        CPython reference counting releases the deque memory immediately.
        """
        with self._lock:
            window = self._windows.pop(session_id, None)
            if window is not None:
                window.mark_closed()
                log.info("window.evicted", session_id=session_id,
                         events_processed=window.event_count,
                         remaining_windows=len(self._windows))
            # window reference drops to zero here → deque freed immediately (CPython)

    def active_count(self) -> int:
        with self._lock:
            return len(self._windows)

    # ─── Orphan reaper ────────────────────────────────────────────────────────

    def _start_reaper(self) -> None:
        t = threading.Thread(
            target=self._reaper_loop,
            name="window-reaper",
            daemon=True,   # daemon: won't block process exit
        )
        t.start()
        log.info("window_reaper.started",
                 interval_seconds=self.REAPER_INTERVAL_SECONDS,
                 orphan_ttl_seconds=ORPHAN_TTL_SECONDS)

    def _reaper_loop(self) -> None:
        while True:
            time.sleep(self.REAPER_INTERVAL_SECONDS)
            try:
                self._reap_orphans()
            except Exception as exc:
                log.error("window_reaper.error", error=str(exc))

    def _reap_orphans(self) -> None:
        with self._lock:
            orphan_ids = [
                sid for sid, w in self._windows.items()
                if w.is_closed or w.idle_seconds > ORPHAN_TTL_SECONDS
            ]

        if not orphan_ids:
            return

        log.warning("window_reaper.evicting_orphans", count=len(orphan_ids))
        for sid in orphan_ids:
            self.evict(sid)


# ─── Singleton ────────────────────────────────────────────────────────────────

window_registry = WindowRegistry()
