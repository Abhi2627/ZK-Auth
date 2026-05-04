"""
TimescaleDB Telemetry Reader — training data pipeline.

Reads labeled behavioral event windows from telemetry.behavior_events
and telemetry.risk_scores to produce training batches for the LSTM.

Called by training/train.py — not used during online inference.
"""

from __future__ import annotations

from typing import Generator, Optional

import numpy as np
import structlog
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from src.model.feature_extractor import feature_extractor, N_FEATURES
from src.model.sliding_window import WINDOW_SIZE

log = structlog.get_logger(__name__)


class TelemetryReader:
    """
    Connects to TimescaleDB and streams labeled training windows.

    Label assignment:
        A window is labelled 1 (anomaly) if it contains at least one event
        from a session that had a CONFIRMED step-up event (from auth.step_up_events)
        resolved as FAILED or TIMED_OUT — meaning the behavioural anomaly
        was real (the user could not re-authenticate or didn't try).

        All other windows are labelled 0 (normal).

        This is a weak supervision scheme — label quality improves as the
        system collects more confirmed anomaly sessions over time.
    """

    def __init__(self, timescale_url: str) -> None:
        self._url = timescale_url
        self._engine: Optional[Engine] = None

    def connect(self) -> None:
        self._engine = create_engine(self._url, pool_size=2, max_overflow=0)
        with self._engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        log.info("telemetry_reader.connected")

    def fetch_training_windows(
        self,
        hours: int = 720,
        batch_size: int = 256,
    ) -> Generator[tuple[np.ndarray, np.ndarray], None, None]:
        """
        Yield (X, y) batches for LSTM training.

        X shape: (batch_size, WINDOW_SIZE, N_FEATURES) float32
        y shape: (batch_size, 1)                       float32

        Yields batches until all available data is consumed.
        """
        if self._engine is None:
            raise RuntimeError("Call connect() before fetch_training_windows()")

        query = text("""
            SELECT
                be.session_id,
                be.time,
                be.event_type,
                be.mouse_velocity,
                be.key_dwell_ms,
                be.scroll_delta,
                be.touch_pressure,
                be.sequence_num,
                -- Label: 1 if this session had a confirmed anomaly
                COALESCE(anom.is_anomaly, 0) AS label
            FROM telemetry.behavior_events be
            LEFT JOIN (
                SELECT DISTINCT s.id AS session_id, 1 AS is_anomaly
                FROM auth.sessions s
                JOIN auth.step_up_events sue ON sue.session_id = s.id
                WHERE sue.resolution IN ('FAILED', 'TIMED_OUT')
            ) anom ON anom.session_id = be.session_id
            WHERE be.time > NOW() - INTERVAL ':hours hours'
            ORDER BY be.session_id, be.time
        """).bindparams(hours=hours)

        X_batch: list[np.ndarray] = []
        y_batch: list[float] = []
        current_session: Optional[str] = None
        session_events: list[tuple] = []
        session_label: float = 0.0

        with self._engine.connect() as conn:
            result = conn.execute(query)

            for row in result:
                sid = str(row.session_id)

                if current_session != sid:
                    # Process completed session
                    if current_session is not None and len(session_events) >= WINDOW_SIZE:
                        for window, label in self._sliding_windows(session_events, session_label):
                            X_batch.append(window)
                            y_batch.append(label)
                            if len(X_batch) == batch_size:
                                yield (
                                    np.array(X_batch, dtype=np.float32),
                                    np.array(y_batch, dtype=np.float32).reshape(-1, 1),
                                )
                                X_batch.clear()
                                y_batch.clear()

                    current_session = sid
                    session_events = []
                    session_label = float(row.label)

                session_events.append(row)

        # Flush remainder
        if X_batch:
            yield (
                np.array(X_batch, dtype=np.float32),
                np.array(y_batch, dtype=np.float32).reshape(-1, 1),
            )

    def _sliding_windows(
        self,
        events: list,
        label: float,
    ) -> Generator[tuple[np.ndarray, float], None, None]:
        """Produce non-overlapping windows from a session's event list."""
        for start in range(0, len(events) - WINDOW_SIZE + 1, WINDOW_SIZE):
            window_events = events[start : start + WINDOW_SIZE]
            features = []
            prev_seq = None
            for e in window_events:
                gap = prev_seq is not None and e.sequence_num > prev_seq + 1
                features.append(feature_extractor.extract(e, gap))
                prev_seq = e.sequence_num
            yield np.array(features, dtype=np.float32), label
