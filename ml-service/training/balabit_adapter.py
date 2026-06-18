#!/usr/bin/env python3
"""
Balabit Mouse Dynamics Challenge → ZK-Auth LSTM Training Format

Dataset structure (actual):
  training_files/<user>/session_XXXXXXXXXX   ← all genuine (no label file needed)
  test_files/<user>/session_XXXXXXXXXX        ← labeled by public_labels.csv
  public_labels.csv                           ← filename,is_illegal (1=intruder, 0=genuine)

Session file format (tab/space separated, has header):
  record timestamp,client timestamp,button,state,x,y

Feature mapping to ZK-Auth's 6-dimensional vector:
  [0] mouse_velocity  ← speed in px/s from consecutive (x,y,t) pairs, norm by MAX=3000 px/s
  [1] key_dwell_ms    ← 0.0 (Balabit tracks mouse only, no keyboard dwell)
  [2] scroll_delta    ← 0.0 (no scroll in this dataset)
  [3] touch_pressure  ← 0.0 (desktop dataset)
  [4] event_type      ← NoButton=0, Left=1/5, Right=2/5, Middle/Scroll=3/5, Drag=4/5
  [5] sequence_gap    ← 1.0 if inter-event gap > 1.0s

Usage:
    cd ml-service
    pip install pandas
    python -m training.balabit_adapter \\
        --data-dir training/data/balabit-data \\
        --out      training/data/balabit_windows.npz

    python -m training.train \\
        --npz  training/data/balabit_windows.npz \\
        --output models/lstm_balabit/model.keras \\
        --scaler-out models/lstm_balabit/scaler.pkl \\
        --epochs 40

    # Evaluate and print Table II values:
    python -m training.balabit_adapter \\
        --data-dir training/data/balabit-data \\
        --out      training/data/balabit_windows.npz \\
        --eval \\
        --model-path  models/lstm_balabit/model.keras \\
        --scaler-path models/lstm_balabit/scaler.pkl
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import time
from pathlib import Path
from typing import Tuple

import numpy as np
import pandas as pd

WINDOW_SIZE = 50
N_FEATURES  = 6

# Feature indices (must match feature_extractor.py)
F_MOUSE_VEL  = 0
F_KEY_DWELL  = 1
F_SCROLL     = 2
F_TOUCH      = 3
F_EVENT_TYPE = 4
F_GAP        = 5

MAX_VELOCITY     = 3000.0   # px/s  (Balabit timestamps are in seconds)
GAP_THRESHOLD_S  = 1.0      # inter-event gap > 1s → gap flag

# Button/state → ZK-Auth event_type feature value
# ZK-Auth encoding: MOUSE_MOVE=0/5, KEY_DOWN=1/5, KEY_UP=2/5, SCROLL=3/5, TOUCH=4/5
BUTTON_TO_FEATURE = {
    'NoButton': 0.0 / 5.0,   # pure move
    'Left':     1.0 / 5.0,   # click
    'Right':    2.0 / 5.0,   # right click
    'Middle':   3.0 / 5.0,
    'Scroll':   3.0 / 5.0,
    'Drag':     4.0 / 5.0,   # dragging (touch-like)
}


def load_session(filepath: str) -> pd.DataFrame:
    """Load one Balabit session file. Files have a CSV header, no extension."""
    try:
        df = pd.read_csv(filepath, sep=',')
        # Normalise column names (strip whitespace)
        df.columns = [c.strip() for c in df.columns]
        # Expected: 'record timestamp', 'client timestamp', 'button', 'state', 'x', 'y'
        # Use 'client timestamp' as the time axis (wall-clock, more reliable)
        df = df.rename(columns={
            'client timestamp': 'ts',
            'record timestamp': 'rec_ts',
        })
        df['ts'] = pd.to_numeric(df['ts'], errors='coerce')
        df['x']  = pd.to_numeric(df['x'],  errors='coerce')
        df['y']  = pd.to_numeric(df['y'],  errors='coerce')
        df = df.dropna(subset=['ts', 'x', 'y'])
        df = df.sort_values('ts').reset_index(drop=True)
        return df
    except Exception as e:
        raise RuntimeError(f"Failed to load {filepath}: {e}")


def session_to_vectors(df: pd.DataFrame) -> np.ndarray:
    """Convert a session DataFrame → (N_events, N_FEATURES) float32 array."""
    n = len(df)
    vectors = np.zeros((n, N_FEATURES), dtype=np.float32)

    ts  = df['ts'].to_numpy(dtype=np.float64)
    xs  = df['x'].to_numpy(dtype=np.float64)
    ys  = df['y'].to_numpy(dtype=np.float64)
    btns = df['button'].fillna('NoButton').tolist() if 'button' in df.columns else ['NoButton'] * n

    for i in range(n):
        if i == 0:
            vel = 0.0
            gap = 0.0
        else:
            dt = ts[i] - ts[i - 1]
            if dt <= 0:
                vel = 0.0
                gap = 0.0
            else:
                dx  = xs[i] - xs[i - 1]
                dy  = ys[i] - ys[i - 1]
                vel = math.sqrt(dx * dx + dy * dy) / dt   # px/s
                gap = 1.0 if dt > GAP_THRESHOLD_S else 0.0

        vectors[i, F_MOUSE_VEL]  = float(np.clip(vel / MAX_VELOCITY, 0.0, 1.0))
        vectors[i, F_KEY_DWELL]  = 0.0   # not in dataset
        vectors[i, F_SCROLL]     = 0.0   # not in dataset
        vectors[i, F_TOUCH]      = 0.0   # desktop
        btn = str(btns[i]) if i < len(btns) else 'NoButton'
        vectors[i, F_EVENT_TYPE] = BUTTON_TO_FEATURE.get(btn, 0.0)
        vectors[i, F_GAP]        = gap

    return vectors


def vectors_to_windows(
    vectors: np.ndarray,
    label: float,
    window_size: int = WINDOW_SIZE,
    stride: int = 25,
) -> Tuple[np.ndarray, np.ndarray]:
    """Slice feature matrix into overlapping windows."""
    n = len(vectors)
    wins = []
    for s in range(0, n - window_size + 1, stride):
        wins.append(vectors[s: s + window_size])
    if not wins:
        return np.zeros((0, window_size, N_FEATURES), dtype=np.float32), np.zeros(0, dtype=np.float32)
    X = np.stack(wins).astype(np.float32)
    y = np.full(len(wins), label, dtype=np.float32)
    return X, y


def process_dataset(data_dir: str, stride: int = 25) -> Tuple[np.ndarray, np.ndarray]:
    """
    Load training_files (all genuine) + test_files (labeled by public_labels.csv).
    Returns (X, y) arrays ready for train.py.
    """
    # Load ground-truth labels for test sessions
    labels_path = os.path.join(data_dir, 'public_labels.csv')
    if not os.path.exists(labels_path):
        raise FileNotFoundError(f"public_labels.csv not found at {labels_path}")
    labels_df = pd.read_csv(labels_path)
    # is_illegal=1 → anomaly/intruder (label=1), is_illegal=0 → genuine (label=0)
    test_labels = dict(zip(labels_df['filename'].str.strip(), labels_df['is_illegal'].astype(float)))

    all_X, all_y = [], []
    stats = {'training_genuine': 0, 'test_genuine': 0, 'test_intruder': 0,
             'skipped_short': 0, 'skipped_error': 0}

    # ── training_files: all genuine ──────────────────────────────────────────
    training_dir = os.path.join(data_dir, 'training_files')
    session_files = glob.glob(os.path.join(training_dir, '*', 'session_*'))
    print(f'  Training files: {len(session_files)} sessions (all genuine)')
    for fp in sorted(session_files):
        try:
            df = load_session(fp)
            if len(df) < WINDOW_SIZE:
                stats['skipped_short'] += 1
                continue
            X, y = vectors_to_windows(session_to_vectors(df), label=0.0, stride=stride)
            if len(X) > 0:
                all_X.append(X); all_y.append(y)
                stats['training_genuine'] += 1
        except Exception as e:
            stats['skipped_error'] += 1

    # ── test_files: use public_labels.csv for ground truth ───────────────────
    test_dir = os.path.join(data_dir, 'test_files')
    session_files = glob.glob(os.path.join(test_dir, '*', 'session_*'))
    print(f'  Test files: {len(session_files)} sessions (labeled by public_labels.csv)')
    for fp in sorted(session_files):
        fname = Path(fp).name
        if fname not in test_labels:
            continue   # no label available, skip
        label = test_labels[fname]
        try:
            df = load_session(fp)
            if len(df) < WINDOW_SIZE:
                stats['skipped_short'] += 1
                continue
            X, y = vectors_to_windows(session_to_vectors(df), label=label, stride=stride)
            if len(X) > 0:
                all_X.append(X); all_y.append(y)
                if label == 0.0:
                    stats['test_genuine'] += 1
                else:
                    stats['test_intruder'] += 1
        except Exception as e:
            stats['skipped_error'] += 1

    print(f'\n  Sessions loaded:  training genuine={stats["training_genuine"]}, '
          f'test genuine={stats["test_genuine"]}, test intruder={stats["test_intruder"]}')
    print(f'  Skipped: short={stats["skipped_short"]}, error={stats["skipped_error"]}')

    if not all_X:
        raise RuntimeError('No windows generated. Check data_dir path and file format.')

    X = np.concatenate(all_X, axis=0)
    y = np.concatenate(all_y, axis=0)
    return X, y


def evaluate_model(model_path: str, scaler_path: str,
                   X_test: np.ndarray, y_test: np.ndarray) -> dict:
    """Run evaluation and return metrics for paper Table II."""
    import tensorflow as tf
    import joblib
    from sklearn.metrics import (
        roc_auc_score, classification_report, confusion_matrix,
    )

    scaler = joblib.load(scaler_path)
    model  = tf.keras.models.load_model(model_path)
    model.trainable = False

    n, w, f = X_test.shape
    X_scaled = scaler.transform(X_test.reshape(-1, f)).reshape(n, w, f).astype(np.float32)

    y_prob = model.predict(X_scaled, batch_size=256, verbose=0).flatten()
    y_pred = (y_prob >= 0.75).astype(int)

    auc = roc_auc_score(y_test, y_prob)
    tn, fp, fn, tp = confusion_matrix(y_test, y_pred).ravel()
    far = fp / (fp + tn) if (fp + tn) > 0 else 0.0
    frr = fn / (fn + tp) if (fn + tp) > 0 else 0.0

    report = classification_report(y_test, y_pred,
                                   target_names=['Normal', 'Anomaly'],
                                   output_dict=True)

    # Inference speed: 1000 single-window predictions
    single = X_scaled[:1]
    t0 = time.perf_counter()
    for _ in range(1000):
        model.predict(single, verbose=0)
    infer_ms = (time.perf_counter() - t0) / 1000 * 1000

    return {
        'auc_roc':            round(auc, 4),
        'far':                round(far, 4),
        'frr':                round(frr, 4),
        'precision_normal':   round(report['Normal']['precision'], 4),
        'precision_anomaly':  round(report['Anomaly']['precision'], 4),
        'recall_normal':      round(report['Normal']['recall'], 4),
        'recall_anomaly':     round(report['Anomaly']['recall'], 4),
        'f1_normal':          round(report['Normal']['f1-score'], 4),
        'f1_anomaly':         round(report['Anomaly']['f1-score'], 4),
        'f1_weighted':        round(report['weighted avg']['f1-score'], 4),
        'inference_ms':       round(infer_ms, 3),
        'threshold':          0.75,
        'n_test':             int(len(y_test)),
        'n_genuine_test':     int((y_test == 0).sum()),
        'n_intruder_test':    int((y_test == 1).sum()),
    }


def main() -> None:
    p = argparse.ArgumentParser(description='Balabit → ZK-Auth window converter')
    p.add_argument('--data-dir',    required=True,
                   help='Path to cloned balabit Mouse-Dynamics-Challenge repo')
    p.add_argument('--out',         default='training/data/balabit_windows.npz')
    p.add_argument('--stride',      type=int, default=25,
                   help='Window stride (25 = 50%% overlap)')
    p.add_argument('--test-split',  type=float, default=0.20)
    p.add_argument('--eval',        action='store_true',
                   help='Run evaluation after conversion (requires trained model)')
    p.add_argument('--model-path',  default='models/lstm_balabit/model.keras')
    p.add_argument('--scaler-path', default='models/lstm_balabit/scaler.pkl')
    args = p.parse_args()

    print(f'\n[balabit_adapter] Processing: {args.data_dir}')
    print(f'[balabit_adapter] Window={WINDOW_SIZE}, stride={args.stride}')

    X, y = process_dataset(args.data_dir, stride=args.stride)

    n      = len(X)
    n_anom = int(y.sum())
    n_norm = n - n_anom
    print(f'\n[balabit_adapter] Total windows: {n}')
    print(f'[balabit_adapter]   Genuine:  {n_norm}  ({100*n_norm/n:.1f}%)')
    print(f'[balabit_adapter]   Intruder: {n_anom} ({100*n_anom/n:.1f}%)')

    # Shuffle and split
    rng   = np.random.default_rng(42)
    idx   = rng.permutation(n)
    X, y  = X[idx], y[idx]
    n_test   = int(n * args.test_split)
    X_test,  y_test  = X[:n_test],  y[:n_test]
    X_train, y_train = X[n_test:],  y[n_test:]

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(str(out), X=X_train, y=y_train, X_test=X_test, y_test=y_test)

    print(f'\n[balabit_adapter] Saved: {out}')
    print(f'[balabit_adapter]   Train: {len(X_train)} windows  '
          f'({int(y_train.sum())} intruder, {int((y_train==0).sum())} genuine)')
    print(f'[balabit_adapter]   Test:  {len(X_test)} windows  '
          f'({int(y_test.sum())} intruder, {int((y_test==0).sum())} genuine)')

    print(f'\nNext — train:')
    print(f'  python -m training.train \\')
    print(f'    --npz {args.out} \\')
    print(f'    --output {args.model_path} \\')
    print(f'    --scaler-out {args.scaler_path} \\')
    print(f'    --epochs 40')

    if args.eval:
        if not (os.path.exists(args.model_path) and os.path.exists(args.scaler_path)):
            print('\n[balabit_adapter] Model not found — train first, then re-run with --eval')
            return
        print('\n[balabit_adapter] Evaluating...')
        m = evaluate_model(args.model_path, args.scaler_path, X_test, y_test)

        print('\n' + '='*62)
        print('  EVALUATION RESULTS  →  paste into paper Table II')
        print('='*62)
        print(f"  AUC-ROC:               {m['auc_roc']:.4f}")
        print(f"  FAR (thresh=0.75):     {m['far']:.4f}  ({m['far']*100:.2f}%)")
        print(f"  FRR (thresh=0.75):     {m['frr']:.4f}  ({m['frr']*100:.2f}%)")
        print(f"  Precision  (Normal):   {m['precision_normal']:.4f}")
        print(f"  Precision  (Anomaly):  {m['precision_anomaly']:.4f}")
        print(f"  Recall     (Normal):   {m['recall_normal']:.4f}")
        print(f"  Recall     (Anomaly):  {m['recall_anomaly']:.4f}")
        print(f"  F1         (Normal):   {m['f1_normal']:.4f}")
        print(f"  F1         (Anomaly):  {m['f1_anomaly']:.4f}")
        print(f"  F1 weighted avg:       {m['f1_weighted']:.4f}")
        print(f"  Inference:             {m['inference_ms']:.3f} ms/window")
        print(f"  Test set: {m['n_test']} windows "
              f"({m['n_genuine_test']} genuine, {m['n_intruder_test']} intruder)")
        print('='*62)

        eval_out = str(out).replace('.npz', '_eval.json')
        with open(eval_out, 'w') as f_:
            json.dump(m, f_, indent=2)
        print(f'\n[balabit_adapter] Saved eval: {eval_out}')


if __name__ == '__main__':
    main()
