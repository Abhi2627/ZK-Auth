"""
TimescaleDB reader for LSTM training pipeline.
Phase 3 implementation.
"""


class TelemetryReader:
    """
    Reads behavioral event windows from TimescaleDB for model training.
    Uses SQLAlchemy + psycopg2 with the zkauth_lstm_role credentials.
    """

    def __init__(self, timescale_url: str) -> None:
        self._url = timescale_url
        self._engine = None

    def connect(self) -> None:
        """Phase 3: create SQLAlchemy engine."""
        raise NotImplementedError("TelemetryReader.connect — Phase 3 target")

    def fetch_training_windows(self, hours: int = 720):
        """
        Fetch labeled event windows for training.
        Returns a list of (feature_matrix, label) tuples.
        Phase 3 implementation.
        """
        raise NotImplementedError("TelemetryReader.fetch_training_windows — Phase 3 target")
