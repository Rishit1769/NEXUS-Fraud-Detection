"""Versioned numeric features derived from the preceding LLM stage.

The model never consumes raw LLM prose. Only this fixed numeric contract is
used, which makes the feature schema reproducible and prevents prompt output
from changing the XGBoost input shape unexpectedly.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pandas as pd

LLM_FEATURE_VERSION = "llm-features-1"
LLM_FEATURE_NAMES = [
    "llm_proposed_score",
    "llm_confidence",
    "llm_risk_low",
    "llm_risk_medium",
    "llm_risk_high",
    "llm_risk_critical",
    "llm_disagreement",
]


def input_hash(value: str) -> str:
    return hashlib.sha256(str(value).strip().encode("utf-8")).hexdigest()


def llm_feature_values(
    analysis: dict[str, Any] | None,
) -> dict[str, float]:
    analysis = analysis or {}
    level = str(analysis.get("proposedRiskLevel", "UNKNOWN")).upper()
    score = float(analysis.get("proposedScore", 0.0) or 0.0)
    confidence = float(analysis.get("confidence", 0.0) or 0.0)
    return {
        "llm_proposed_score": max(0.0, min(100.0, score)),
        "llm_confidence": max(0.0, min(1.0, confidence)),
        "llm_risk_low": float(level == "LOW"),
        "llm_risk_medium": float(level == "MEDIUM"),
        "llm_risk_high": float(level == "HIGH"),
        "llm_risk_critical": float(level == "CRITICAL"),
        "llm_disagreement": float(bool(analysis.get("disagreement", False))),
    }


def runtime_llm_frame(analysis: dict[str, Any] | None, rows: int = 1) -> pd.DataFrame:
    values = llm_feature_values(analysis)
    return pd.DataFrame([values] * rows, columns=LLM_FEATURE_NAMES).astype("float64")


def load_cached_features(path: Path | None) -> dict[str, dict[str, Any]]:
    if path is None or not path.exists():
        return {}
    result: dict[str, dict[str, Any]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        key = str(row.get("input_hash", ""))
        if key:
            result[key] = row
    return result


def cached_llm_frame(values: pd.Series, path: Path | None) -> pd.DataFrame:
    cache = load_cached_features(path)
    rows = []
    for value in values.fillna("").astype(str):
        rows.append(llm_feature_values(cache.get(input_hash(value))))
    return pd.DataFrame(rows, columns=LLM_FEATURE_NAMES).astype("float64")
