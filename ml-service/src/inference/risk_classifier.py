"""
Risk Classifier — maps raw float score to RiskLevel enum + RiskReason.
Phase 3: wire to threshold config from settings.
"""

from dataclasses import dataclass


@dataclass
class RiskClassification:
    level: str        # LOW | MEDIUM | HIGH | CRITICAL
    reason: str       # RiskReason code


def classify(
    score: float,
    threshold_medium: float = 0.45,
    threshold_high: float = 0.75,
    threshold_critical: float = 0.90,
    prev_score: float | None = None,
) -> RiskClassification:
    """
    Map a raw score to a risk level.
    Also detects VELOCITY_SPIKE_REVERSE (sharp drop after high score).
    """
    if score >= threshold_critical:
        return RiskClassification(level="CRITICAL", reason="MULTI_FACTOR_ANOMALY")
    if score >= threshold_high:
        return RiskClassification(level="HIGH", reason="ANOMALOUS_TYPING_RHYTHM")
    if score >= threshold_medium:
        # Detect a sudden score reversal (potential evasion after high risk)
        if prev_score is not None and prev_score >= threshold_high and score < threshold_medium:
            return RiskClassification(level="MEDIUM", reason="VELOCITY_SPIKE_REVERSE")
        return RiskClassification(level="MEDIUM", reason="VELOCITY_SPIKE")
    return RiskClassification(level="LOW", reason="NORMAL")
