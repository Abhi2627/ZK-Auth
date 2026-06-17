#!/usr/bin/env python3
"""
Synthetic Behavioral Data Generator for ZK-Auth LSTM Training

Generates realistic behavioral event sequences for two classes:
  - Normal  (label=0): Genuine user with personal biometric variation
  - Anomaly (label=1): Bot / different human / mobile attacker

Outputs labeled windows to a numpy .npz file so training can run
without a live TimescaleDB instance during initial model bootstrap.

Usage:
    cd ml-service
    python -m training.generate_synthetic \
        --n-normal 8000 --n-anomaly 2000 \
        --out training/data/synthetic.npz
"""

from __future__ import annotations
import argparse
import numpy as np
from pathlib import Path

WINDOW_SIZE = 50
N_FEATURES  = 6

# Feature indices (must match feature_extractor.py)
F_MOUSE_VEL  = 0
F_KEY_DWELL  = 1
F_SCROLL     = 2
F_TOUCH      = 3
F_EVENT_TYPE = 4
F_GAP        = 5


def _normal_window(rng: np.random.Generator) -> np.ndarray:
    """
    Genuine authenticated user.
    Each call picks a random user (unique center speed/dwell)
    then adds Gaussian noise around their personal baseline.
    """
    w = np.zeros((WINDOW_SIZE, N_FEATURES), dtype=np.float32)

    # Mouse velocity: user-specific center in [0.05, 0.35]
    mu_v = rng.uniform(0.05, 0.35)
    w[:, F_MOUSE_VEL] = np.clip(rng.normal(mu_v, 0.03, WINDOW_SIZE), 0.0, 1.0)

    # Key dwell: 80-200ms normalised over MAX=2000ms -> [0.04, 0.10]
    mu_d = rng.uniform(0.04, 0.10)
    w[:, F_KEY_DWELL] = np.clip(rng.normal(mu_d, 0.008, WINDOW_SIZE), 0.0, 1.0)

    # Scroll delta: sparse bursts
    mask = rng.random(WINDOW_SIZE) < 0.22
    w[mask, F_SCROLL] = np.clip(rng.exponential(0.12, mask.sum()), 0.0, 1.0)

    # Desktop: touch pressure = 0
    w[:, F_TOUCH] = 0.0

    # Event type: natural web app distribution
    probs = [0.40, 0.20, 0.20, 0.15, 0.04, 0.01]
    w[:, F_EVENT_TYPE] = rng.choice(6, size=WINDOW_SIZE, p=probs) / 5.0

    # No sequence gaps in clean sessions
    w[:, F_GAP] = 0.0

    return w


def _anomaly_window(rng: np.random.Generator) -> np.ndarray:
    """
    Three attacker archetypes:
      bot     -- scripted automation, unnaturally consistent
      human   -- legitimate person, wrong biometric profile
      mobile  -- mobile script with touch/gyro signals
    """
    w = np.zeros((WINDOW_SIZE, N_FEATURES), dtype=np.float32)
    t = rng.choice(['bot', 'human', 'mobile'])

    if t == 'bot':
        speed = rng.uniform(0.75, 0.98)
        w[:, F_MOUSE_VEL]  = np.clip(rng.normal(speed, 0.003, WINDOW_SIZE), 0.0, 1.0)
        w[:, F_KEY_DWELL]  = np.clip(rng.normal(0.008, 0.001, WINDOW_SIZE), 0.0, 1.0)
        w[:, F_EVENT_TYPE] = 0.2   # all KEY_DOWN - scripted form fill
        w[:, F_GAP]        = (rng.random(WINDOW_SIZE) < 0.12).astype(np.float32)

    elif t == 'human':
        mu_v = rng.uniform(0.50, 0.88)
        mu_d = rng.uniform(0.18, 0.45)
        w[:, F_MOUSE_VEL]  = np.clip(rng.normal(mu_v, 0.07, WINDOW_SIZE), 0.0, 1.0)
        w[:, F_KEY_DWELL]  = np.clip(rng.normal(mu_d, 0.04, WINDOW_SIZE), 0.0, 1.0)
        probs = [0.30, 0.25, 0.25, 0.12, 0.05, 0.03]
        w[:, F_EVENT_TYPE] = rng.choice(6, size=WINDOW_SIZE, p=probs) / 5.0
        w[:, F_GAP]        = (rng.random(WINDOW_SIZE) < 0.04).astype(np.float32)

    else:  # mobile
        w[:, F_MOUSE_VEL]  = np.clip(rng.normal(0.55, 0.14, WINDOW_SIZE), 0.0, 1.0)
        w[:, F_KEY_DWELL]  = np.clip(rng.normal(0.28, 0.09, WINDOW_SIZE), 0.0, 1.0)
        w[:, F_TOUCH]      = np.clip(rng.normal(0.68, 0.14, WINDOW_SIZE), 0.0, 1.0)
        w[:, F_SCROLL]     = np.clip(rng.exponential(0.38, WINDOW_SIZE), 0.0, 1.0)
        probs = [0.20, 0.10, 0.10, 0.20, 0.35, 0.05]
        w[:, F_EVENT_TYPE] = rng.choice(6, size=WINDOW_SIZE, p=probs) / 5.0
        w[:, F_GAP]        = (rng.random(WINDOW_SIZE) < 0.07).astype(np.float32)

    return w


def generate(n_normal: int, n_anomaly: int, seed: int = 42):
    rng = np.random.default_rng(seed)
    n   = n_normal + n_anomaly
    X   = np.zeros((n, WINDOW_SIZE, N_FEATURES), dtype=np.float32)
    y   = np.zeros(n, dtype=np.float32)

    for i in range(n_normal):
        X[i] = _normal_window(rng)

    for i in range(n_anomaly):
        X[n_normal + i] = _anomaly_window(rng)
        y[n_normal + i] = 1.0

    idx = rng.permutation(n)
    return X[idx], y[idx]


def main():
    p = argparse.ArgumentParser(description='Generate synthetic behavioral training data')
    p.add_argument('--n-normal',  type=int, default=8000)
    p.add_argument('--n-anomaly', type=int, default=2000)
    p.add_argument('--seed',      type=int, default=42)
    p.add_argument('--out',       type=str, default='training/data/synthetic.npz')
    args = p.parse_args()

    print(f'[synthetic] Generating {args.n_normal} normal + {args.n_anomaly} anomaly windows...')
    X, y = generate(args.n_normal, args.n_anomaly, args.seed)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(str(out), X=X, y=y)

    print(f'[synthetic] Saved {len(X)} windows -> {out}')
    print(f'[synthetic] Anomaly rate: {100*y.mean():.1f}%   Shape: {X.shape}')


if __name__ == '__main__':
    main()
