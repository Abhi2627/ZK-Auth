"""
Risk Classifier — smoothed score → RiskLevel + RiskReason.

Converts the EMA-smoothed float output from predictor.py into a
structured classification with a risk level and a human-readable reason code.

Reason codes:
    NORMAL                   — score < MEDIUM threshold
    VELOCITY_SPIKE           — score in MEDIUM band, no reversal
    VELOCITY_SPIKE_REVERSE   — score in MEDIUM band after a HIGH/CRITICAL drop
                               (potential evasion attempt — adversary lowered
                                risk score deliberately after detection)
    ANOMALOUS_TYPING_RHYTHM  — score in HIGH band
    MULTI_FACTOR_ANOMALY     — score >= CRITICAL threshold

T8 Mitigation note:
    VELOCITY_SPIKE_REVERSE is specifically designed to catch ML model evasion.
    An adversary who detects they have triggered HIGH risk and then deliberately
    reverts to normal behaviour would normally produce a LOW score on the next
    window. The reverse-spike detector flags this pattern as MEDIUM-risk rather
    than LOW, forcing continued monitoring.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class RiskClassification:
    level:  str   # LOW | MEDIUM | HIGH | CRITICAL
    reason: str   # reason code from the list above


def classify(
    score: float,
    threshold_medium:   float = 0.45,
    threshold_high:     float = 0.75,
    threshold_critical: float = 0.90,
    prev_score: Optional[float] = None,
) -> RiskClassification:
    """
    Map a smoothed anomaly score to a RiskClassification.

    Args:
        score:              Current EMA-smoothed score ∈ [0.0, 1.0]
        threshold_medium:   Lower bound for MEDIUM risk
        threshold_high:     Lower bound for HIGH risk
        threshold_critical: Lower bound for CRITICAL risk
        prev_score:         Previous smoothed score (for reversal detection).
                            None on the first window of a session.

    Returns:
        RiskClassification(level, reason)
    """
    if not 0.0 <= score <= 1.0:
        raise ValueError(f"score must be in [0.0, 1.0], got {score}")

    if score >= threshold_critical:
        return RiskClassification(
            level="CRITICAL",
            reason="MULTI_FACTOR_ANOMALY",
        )

    if score >= threshold_high:
        return RiskClassification(
            level="HIGH",
            reason="ANOMALOUS_TYPING_RHYTHM",
        )

    if score >= threshold_medium:
        # Check for reverse spike (T8 evasion mitigation)
        if (
            prev_score is not None
            and prev_score >= threshold_high
            and score < threshold_medium
        ):
            return RiskClassification(
                level="MEDIUM",
                reason="VELOCITY_SPIKE_REVERSE",
            )
        return RiskClassification(
            level="MEDIUM",
            reason="VELOCITY_SPIKE",
        )

    return RiskClassification(level="LOW", reason="NORMAL")
