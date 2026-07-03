#!/usr/bin/env python3
"""
Empirical Security Validation - G5 (Session-Continuity / Hijack Detection)
==========================================================================
Paper: Section "Empirical Security Validation" (Theorem: Session-Continuity;
Eq. compounded-survival 0.5668^k).

What this harness measures (offline, on the public Balabit test split):
  For each *intruder* session (a hijack of a genuine account), replay the
  session event-by-event through the DEPLOYED inference pipeline:
      raw features -> scaler -> LSTM -> EMA smoothing (alpha=0.3)
  and record the sliding-window index at which the EMA-smoothed risk score
  first crosses the HARD step-up threshold (r >= 0.90). That index is the
  session's "time-to-detect" in windows (convertible to seconds at the
  observed event rate).

Reported metrics (fill the paper's G5 "[HARNESS OUTPUT: ...]" placeholder):
  - detection rate within k windows (k configurable, default 10)
  - median / mean time-to-detect (in windows)
  - fraction of intruder sessions never detected within the session
  - the empirical counterpart of the modeled 0.5668^k survival curve

This is the OBSERVED detection behavior to report side-by-side with the
modeled compounded-survival bound of Eq. (compound) in the paper.

-- Prerequisites --------------------------------------------------------------
  - Trained model + scaler:
        ml-service/models/lstm_balabit/model.keras
        ml-service/models/lstm_balabit/scaler.pkl
  - Balabit test sessions on disk (the same data used for training/eval).
  - Python deps: tensorflow, numpy, pandas, scikit-learn, joblib
    (the ml-service .venv already has these).

-- Usage ----------------------------------------------------------------------
  cd ml-service
  python eval/run_stepup_detection_eval.py \
      --data-dir training/data/balabit-data \
      --model-path models/lstm_balabit/model.keras \
      --scaler-path models/lstm_balabit/scaler.pkl \
      --threshold 0.90 --alpha 0.3 --stride 25 --k 10

Output JSON -> ml-service/eval/results/stepup-detection-<date>.json
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from datetime import date

import numpy as np

# Make the training adapter importable (feature extraction identical to deploy).
_HERE = os.path.dirname(os.path.abspath(__file__))
_ML_ROOT = os.path.dirname(_HERE)
sys.path.insert(0, os.path.join(_ML_ROOT, "training"))

try:
    import joblib
    import tensorflow as tf
    from balabit_adapter import (  # type: ignore
        WINDOW_SIZE,
        N_FEATURES,
        load_session,
        session_to_vectors,
        vectors_to_windows,
    )
except Exception as e:  # pragma: no cover
    print(f"[stepup-eval] import failed: {e}", file=sys.stderr)
    print("  Run from ml-service/ with the project .venv active.", file=sys.stderr)
    sys.exit(1)


def ema_smoothing(raw: np.ndarray, alpha: float) -> np.ndarray:
    """Match predictor.py: smoothed[0]=raw[0]; s[t]=a*raw[t]+(1-a)*s[t-1]."""
    out = np.empty_like(raw)
    if len(raw) == 0:
        return out
    out[0] = raw[0]
    for t in range(1, len(raw)):
        out[t] = alpha * raw[t] + (1.0 - alpha) * out[t - 1]
    return out


def load_intruder_files(data_dir: str) -> list:
    """
    Discover intruder test sessions using the Balabit public_labels.csv
    (is_illegal=1), exactly matching balabit_adapter.process_dataset labeling.
    Sessions live at <data_dir>/test_files/<user>/session_*.
    """
    import pandas as pd
    from pathlib import Path

    labels_path = os.path.join(data_dir, "public_labels.csv")
    if not os.path.exists(labels_path):
        raise FileNotFoundError(
            f"public_labels.csv not found at {labels_path}; point --data-dir at "
            "the balabit-data folder (containing public_labels.csv + test_files/)."
        )
    labels_df = pd.read_csv(labels_path)
    intruder_names = set(
        labels_df.loc[labels_df["is_illegal"].astype(float) == 1.0, "filename"].str.strip()
    )
    test_glob = os.path.join(data_dir, "test_files", "*", "session_*")
    return [fp for fp in sorted(glob.glob(test_glob)) if Path(fp).name in intruder_names]


def evaluate(args) -> dict:
    scaler = joblib.load(args.scaler_path)
    model = tf.keras.models.load_model(args.model_path)
    model.trainable = False

    intruder_files = load_intruder_files(args.data_dir)
    if not intruder_files:
        print(
            "[stepup-eval] No intruder sessions found. Ensure --data-dir points at\n"
            "  the balabit-data folder containing public_labels.csv and test_files/.",
            file=sys.stderr,
        )

    ttd_windows: list[int] = []      # time-to-detect (windows) for detected sessions
    never_detected = 0
    total_sessions = 0
    per_session = []

    for fp in intruder_files:
        try:
            df = load_session(fp)
            if len(df) < WINDOW_SIZE:
                continue
            vecs = session_to_vectors(df)                       # (T, 6) raw
            # vectors_to_windows takes a SCALAR label; we discard y and keep X only.
            X, _ = vectors_to_windows(vecs, 1.0,
                                      window_size=WINDOW_SIZE, stride=args.stride)
            if X.shape[0] == 0:
                continue
            n, w, f = X.shape
            Xs = scaler.transform(X.reshape(-1, f)).reshape(n, w, f).astype(np.float32)
            raw = model.predict(Xs, batch_size=256, verbose=0).flatten()
            smoothed = ema_smoothing(raw, args.alpha)

            total_sessions += 1
            crossed = np.where(smoothed >= args.threshold)[0]
            if crossed.size > 0:
                ttd = int(crossed[0]) + 1                       # 1-indexed window count
                ttd_windows.append(ttd)
                per_session.append({"file": os.path.basename(fp), "detected": True,
                                    "ttd_windows": ttd, "n_windows": int(n)})
            else:
                never_detected += 1
                per_session.append({"file": os.path.basename(fp), "detected": False,
                                    "ttd_windows": None, "n_windows": int(n)})
        except Exception as e:  # keep going on a malformed session
            print(f"[stepup-eval] skip {fp}: {e}", file=sys.stderr)

    detected = len(ttd_windows)
    within_k = sum(1 for t in ttd_windows if t <= args.k)
    ttd_arr = np.array(ttd_windows) if ttd_windows else np.array([])

    summary = {
        "generatedAt": date.today().isoformat(),
        "config": {
            "threshold": args.threshold, "alpha": args.alpha,
            "stride": args.stride, "k": args.k,
            "window_size": WINDOW_SIZE, "n_features": N_FEATURES,
        },
        "intruderSessions": total_sessions,
        "detectedAnyWindow": detected,
        "detectionRateSession": round(detected / total_sessions, 4) if total_sessions else None,
        "detectedWithinK": within_k,
        "detectionRateWithinK": round(within_k / total_sessions, 4) if total_sessions else None,
        "neverDetected": never_detected,
        "neverDetectedRate": round(never_detected / total_sessions, 4) if total_sessions else None,
        "timeToDetectWindows": {
            "median": float(np.median(ttd_arr)) if ttd_arr.size else None,
            "mean": round(float(np.mean(ttd_arr)), 3) if ttd_arr.size else None,
            "min": int(ttd_arr.min()) if ttd_arr.size else None,
            "max": int(ttd_arr.max()) if ttd_arr.size else None,
        },
        "modeledSurvivalAtK": round(0.5668 ** args.k, 6),  # paper Eq. (compound)
    }

    print("=" * 63)
    print("  ZK-Auth Step-Up Detection Eval  (G5 empirical validation)")
    print("=" * 63)
    print(f"  Intruder sessions       : {total_sessions}")
    if total_sessions:
        print(f"  Detected (any window)   : {detected} "
              f"({summary['detectionRateSession']*100:.1f}%)")
        print(f"  Detected within k={args.k:<3} : {within_k} "
              f"({summary['detectionRateWithinK']*100:.1f}%)")
        print(f"  Never detected          : {never_detected} "
              f"({summary['neverDetectedRate']*100:.1f}%)")
        if ttd_arr.size:
            print(f"  Time-to-detect (windows): median {summary['timeToDetectWindows']['median']}, "
                  f"mean {summary['timeToDetectWindows']['mean']}, "
                  f"range [{summary['timeToDetectWindows']['min']}, "
                  f"{summary['timeToDetectWindows']['max']}]")
        print(f"  Modeled survival 0.5668^{args.k} = {summary['modeledSurvivalAtK']}")
        print("-" * 63)
        print("  PASTE INTO PAPER (Sec. Empirical Security Validation, G5):")
        print(f"    detection rate within k={args.k}: "
              f"{summary['detectionRateWithinK']*100:.0f}%, "
              f"median time-to-detect {summary['timeToDetectWindows']['median']} windows, "
              f"never-detected {summary['neverDetectedRate']*100:.0f}%")
    print("=" * 63)

    out_dir = os.path.join(_HERE, "results")
    os.makedirs(out_dir, exist_ok=True)
    out_file = os.path.join(out_dir, f"stepup-detection-{date.today().isoformat()}.json")
    with open(out_file, "w") as fh:
        json.dump({"summary": summary, "perSession": per_session}, fh, indent=2)
    print(f"  Output: {out_file}")
    return summary


def main() -> None:
    p = argparse.ArgumentParser(description="G5 hijack step-up detection eval")
    p.add_argument("--data-dir", required=True,
                   help="Directory of Balabit test session files (intruder + genuine)")
    p.add_argument("--model-path", default="models/lstm_balabit/model.keras")
    p.add_argument("--scaler-path", default="models/lstm_balabit/scaler.pkl")
    p.add_argument("--threshold", type=float, default=0.90, help="HARD step-up threshold")
    p.add_argument("--alpha", type=float, default=0.3, help="EMA smoothing alpha")
    p.add_argument("--stride", type=int, default=25, help="Sliding-window stride")
    p.add_argument("--k", type=int, default=10, help="Detection-budget window count")
    args = p.parse_args()
    evaluate(args)


if __name__ == "__main__":
    main()
