"""
LSTM Model Architecture

Defines and builds the Keras LSTM model for behavioral anomaly detection.
The model is trained offline (training/train.py) and loaded from disk at
service startup via ModelRegistry.

Architecture:
    Input → (batch=1, timesteps=50, features=6)  ← single-session online inference
                                                    batch=None for offline training

    LSTM(128, return_sequences=True)   — captures long-range temporal patterns
    Dropout(0.2)                        — regularisation (active at training only)
    LSTM(64, return_sequences=False)    — aggregates sequence into fixed vector
    Dropout(0.2)
    Dense(32, activation='relu')        — non-linear projection
    Dense(1,  activation='sigmoid')     — anomaly score ∈ [0.0, 1.0]

Output semantics:
    0.0 = fully normal behaviour (high confidence)
    1.0 = high anomaly probability (behavioural pattern deviates significantly)

Training objective:
    Binary cross-entropy on labelled windows.
    Label = 0 (normal) for windows from verified authentic sessions.
    Label = 1 (anomaly) for synthetically perturbed or flagged windows.

    NOTE: Label assignment is handled in training/train.py, not here.
"""

from __future__ import annotations

import structlog

log = structlog.get_logger(__name__)

# TensorFlow import is deferred to avoid slowing module load when the model
# is not yet available (e.g., first startup before training).
try:
    import tensorflow as tf
    from tensorflow import keras
    _TF_AVAILABLE = True
except ImportError:
    _TF_AVAILABLE = False
    log.warning("lstm_model.tensorflow_unavailable",
                message="TensorFlow not installed — model operations will fail at runtime")


def build_lstm_model(window_size: int = 50, n_features: int = 6) -> "keras.Model":
    """
    Construct and compile the LSTM anomaly detection model.

    Args:
        window_size: Number of timesteps per inference window (default 50)
        n_features:  Number of features per timestep (default 6)

    Returns:
        Compiled keras.Model ready for training or inference.
    """
    if not _TF_AVAILABLE:
        raise RuntimeError("TensorFlow is required to build the LSTM model")

    inputs = keras.Input(shape=(window_size, n_features), name="behavior_sequence")

    # First LSTM layer — captures short-to-medium range patterns
    x = keras.layers.LSTM(
        units=128,
        return_sequences=True,
        kernel_regularizer=keras.regularizers.l2(1e-4),
        name="lstm_1",
    )(inputs)
    x = keras.layers.Dropout(0.2, name="dropout_1")(x)

    # Second LSTM layer — aggregates into a fixed-size context vector
    x = keras.layers.LSTM(
        units=64,
        return_sequences=False,
        kernel_regularizer=keras.regularizers.l2(1e-4),
        name="lstm_2",
    )(x)
    x = keras.layers.Dropout(0.2, name="dropout_2")(x)

    # Dense projection
    x = keras.layers.Dense(32, activation="relu", name="dense_1")(x)

    # Output: anomaly score ∈ [0, 1]
    output = keras.layers.Dense(1, activation="sigmoid", name="anomaly_score")(x)

    model = keras.Model(inputs=inputs, outputs=output, name="zk_auth_lstm")

    model.compile(
        optimizer=keras.optimizers.Adam(learning_rate=1e-3),
        loss="binary_crossentropy",
        metrics=["accuracy", keras.metrics.AUC(name="auc")],
    )

    log.info(
        "lstm_model.built",
        window_size=window_size,
        n_features=n_features,
        total_params=model.count_params(),
    )

    return model


def load_model(model_path: str) -> "keras.Model":
    """
    Load a saved Keras model from disk (.keras format).

    The loaded model is used for inference only — compilation is preserved
    from the saved state. We set trainable=False on all layers to prevent
    accidental weight updates during inference.
    """
    if not _TF_AVAILABLE:
        raise RuntimeError("TensorFlow is required to load the LSTM model")

    log.info("lstm_model.loading", path=model_path)
    model = keras.models.load_model(model_path)

    # Freeze weights for inference — no gradient computation needed
    model.trainable = False

    log.info(
        "lstm_model.loaded",
        path=model_path,
        total_params=model.count_params(),
    )
    return model
