"""
LSTM Training Pipeline

Reads labeled behavioral windows from TimescaleDB and trains the
ZK-Auth LSTM anomaly detection model.

Usage:
    python -m training.train \
        --hours 720 \
        --epochs 20 \
        --batch-size 256 \
        --output models/lstm_v2/model.keras

The trained model is saved in Keras SavedModel format and can be hot-swapped
into the running service by updating MODEL_PATH env var and restarting.
"""

from __future__ import annotations

import argparse
import os
import time

import numpy as np
import structlog

log = structlog.get_logger(__name__)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Train ZK-Auth LSTM model")
    p.add_argument("--hours",      type=int,   default=720,   help="Training window (hours)")
    p.add_argument("--epochs",     type=int,   default=20,    help="Training epochs")
    p.add_argument("--batch-size", type=int,   default=256,   help="Batch size")
    p.add_argument("--val-split",  type=float, default=0.15,  help="Validation split")
    p.add_argument("--output",     type=str,   default="models/lstm_v2/model.keras")
    p.add_argument("--scaler-out", type=str,   default="models/lstm_v2/scaler.pkl")
    return p.parse_args()


def main() -> None:
    args = parse_args()

    from src.config import settings
    from src.db.telemetry_reader import TelemetryReader
    from src.model.lstm_model import build_lstm_model
    from src.model.sliding_window import WINDOW_SIZE
    from src.model.feature_extractor import N_FEATURES

    try:
        import tensorflow as tf
    except ImportError:
        raise SystemExit("TensorFlow is required for training")

    # ── Collect training data ──────────────────────────────────────────────────
    reader = TelemetryReader(settings.TIMESCALE_URL)
    reader.connect()

    log.info("training.collecting_data", hours=args.hours)
    X_all: list[np.ndarray] = []
    y_all: list[np.ndarray] = []

    for X_batch, y_batch in reader.fetch_training_windows(hours=args.hours, batch_size=1024):
        X_all.append(X_batch)
        y_all.append(y_batch)

    if not X_all:
        raise SystemExit("No training data found — ensure behavior_events table has data")

    X = np.concatenate(X_all)
    y = np.concatenate(y_all)

    log.info("training.data_loaded",
             total_windows=len(X),
             anomaly_pct=round(float(y.mean()) * 100, 2))

    # ── Build and train model ──────────────────────────────────────────────────
    model = build_lstm_model(window_size=WINDOW_SIZE, n_features=N_FEATURES)

    callbacks = [
        tf.keras.callbacks.EarlyStopping(
            monitor="val_auc", patience=3, restore_best_weights=True, mode="max"
        ),
        tf.keras.callbacks.ReduceLROnPlateau(
            monitor="val_loss", factor=0.5, patience=2, min_lr=1e-5
        ),
    ]

    history = model.fit(
        X, y,
        epochs=args.epochs,
        batch_size=args.batch_size,
        validation_split=args.val_split,
        callbacks=callbacks,
        class_weight={0: 1.0, 1: max(1.0, (len(y) - y.sum()) / max(y.sum(), 1))},
    )

    # ── Save model ────────────────────────────────────────────────────────────
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    model.save(args.output)
    log.info("training.model_saved", path=args.output)

    # Save a placeholder scaler (Phase 6: fit real StandardScaler on training data)
    import joblib
    from sklearn.preprocessing import StandardScaler
    scaler = StandardScaler()
    scaler.fit(X.reshape(-1, N_FEATURES))
    joblib.dump(scaler, args.scaler_out)
    log.info("training.scaler_saved", path=args.scaler_out)


if __name__ == "__main__":
    import logging
    import structlog
    logging.basicConfig(level="INFO")
    structlog.configure(processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.add_log_level,
        structlog.dev.ConsoleRenderer(),
    ])
    main()
