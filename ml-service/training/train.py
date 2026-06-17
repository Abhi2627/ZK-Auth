"""
LSTM Training Pipeline - ZK-Auth

Two data sources (auto-detected):
  1. --npz path/to/synthetic.npz  - offline numpy file (fastest, no DB needed)
  2. TimescaleDB (default)        - pulls from live telemetry

Usage (synthetic - recommended for first bootstrap):
    cd ml-service
    python -m training.generate_synthetic --out training/data/synthetic.npz
    python -m training.train --npz training/data/synthetic.npz \
        --output models/lstm_v1/model.keras --scaler-out models/lstm_v1/scaler.pkl

Usage (live DB):
    python -m training.train --hours 720 \
        --output models/lstm_v1/model.keras --scaler-out models/lstm_v1/scaler.pkl
"""

from __future__ import annotations

import argparse
import os

import numpy as np
import structlog

log = structlog.get_logger(__name__)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Train ZK-Auth LSTM model")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--npz",    type=str, default=None,  help="Path to .npz dataset (skips TimescaleDB)")
    g.add_argument("--hours",  type=int, default=720,   help="Hours of TimescaleDB data to use")
    p.add_argument("--epochs",     type=int,   default=30,    help="Training epochs")
    p.add_argument("--batch-size", type=int,   default=256,   help="Batch size")
    p.add_argument("--val-split",  type=float, default=0.15,  help="Validation split")
    p.add_argument("--output",     type=str,   default="models/lstm_v1/model.keras")
    p.add_argument("--scaler-out", type=str,   default="models/lstm_v1/scaler.pkl")
    return p.parse_args()


def main() -> None:
    args = parse_args()

    from src.model.lstm_model import build_lstm_model
    from src.model.sliding_window import WINDOW_SIZE
    from src.model.feature_extractor import N_FEATURES

    try:
        import tensorflow as tf
    except ImportError:
        raise SystemExit("TensorFlow is required: pip install tensorflow")

    # Load data
    if args.npz:
        log.info("training.loading_npz", path=args.npz)
        data = np.load(args.npz)
        X: np.ndarray = data['X'].astype(np.float32)
        y: np.ndarray = data['y'].astype(np.float32)
        log.info("training.data_loaded", total=len(X),
                 anomaly_pct=round(float(y.mean()) * 100, 2), shape=str(X.shape))
    else:
        from src.config import settings
        from src.db.telemetry_reader import TelemetryReader

        reader = TelemetryReader(settings.TIMESCALE_URL)
        reader.connect()
        log.info("training.collecting_timescaledb", hours=args.hours)
        X_all: list[np.ndarray] = []
        y_all: list[np.ndarray] = []
        for X_batch, y_batch in reader.fetch_training_windows(hours=args.hours, batch_size=1024):
            X_all.append(X_batch)
            y_all.append(y_batch)
        if not X_all:
            raise SystemExit(
                "No data in TimescaleDB. Run:\n"
                "  python -m training.generate_synthetic\n"
                "  python -m training.train --npz training/data/synthetic.npz"
            )
        X = np.concatenate(X_all).astype(np.float32)
        y = np.concatenate(y_all).astype(np.float32)
        log.info("training.data_loaded", total=len(X), anomaly_pct=round(float(y.mean()) * 100, 2))

    assert X.shape[1:] == (WINDOW_SIZE, N_FEATURES), \
        f"Shape mismatch: expected ({WINDOW_SIZE},{N_FEATURES}), got {X.shape[1:]}"

    # Fit scaler
    import joblib
    from sklearn.preprocessing import StandardScaler
    scaler = StandardScaler()
    X_flat = X.reshape(-1, N_FEATURES)
    scaler.fit(X_flat)
    X_scaled = scaler.transform(X_flat).reshape(X.shape)
    os.makedirs(os.path.dirname(args.scaler_out) or '.', exist_ok=True)
    joblib.dump(scaler, args.scaler_out)
    log.info("training.scaler_saved", path=args.scaler_out)

    # Build model
    model = build_lstm_model(window_size=WINDOW_SIZE, n_features=N_FEATURES)
    model.summary()

    n_neg = int((y == 0).sum())
    n_pos = int((y == 1).sum())
    class_weight = {0: 1.0, 1: max(1.0, n_neg / max(n_pos, 1))}
    log.info("training.class_weights", weights=class_weight)

    callbacks = [
        tf.keras.callbacks.EarlyStopping(
            monitor="val_auc", patience=5, restore_best_weights=True, mode="max", verbose=1,
        ),
        tf.keras.callbacks.ReduceLROnPlateau(
            monitor="val_loss", factor=0.5, patience=3, min_lr=1e-6, verbose=1,
        ),
        tf.keras.callbacks.ModelCheckpoint(
            filepath=args.output.replace(".keras", "") + ".best.keras",
            monitor="val_auc", mode="max", save_best_only=True, verbose=1,
        ),
    ]

    history = model.fit(
        X_scaled, y,
        epochs=args.epochs,
        batch_size=args.batch_size,
        validation_split=args.val_split,
        callbacks=callbacks,
        class_weight=class_weight,
        verbose=1,
    )

    os.makedirs(os.path.dirname(args.output) or '.', exist_ok=True)
    model.save(args.output)
    log.info("training.model_saved", path=args.output)

    val_auc  = max(history.history.get('val_auc',  [0.0]))
    val_acc  = max(history.history.get('val_accuracy', [0.0]))
    val_loss = min(history.history.get('val_loss', [9.9]))

    print("\n" + "="*60)
    print("  TRAINING COMPLETE")
    print(f"  Best val AUC:      {val_auc:.4f}")
    print(f"  Best val loss:     {val_loss:.4f}")
    print(f"  Best val accuracy: {val_acc:.4f}")
    print(f"  Model:  {args.output}")
    print(f"  Scaler: {args.scaler_out}")
    print("="*60)
    print("\nRestart ml-service to load the new model:")
    print("  kill $(pgrep -f 'python -m src.server') && python -m src.server &")


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
