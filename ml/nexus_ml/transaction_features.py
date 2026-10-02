"""Transaction feature engineering (NEXUS format).

Ported from iis_mini unified pipeline; reshaped to match
ml/nexus_ml/features.py conventions:
  - TRANSACTION_FEATURE_NAMES registry
  - transaction_features(row) for single-row inference
  - transaction_feature_frame(df) for batch training
  - clean_transaction_frame(df) for raw IBM CSV rows

Best-method notes (Person2 XGBoost Tuning4 wins over Person1 RF/LogReg):
  fraud is interaction-driven (channel x geography x MCC), so features
  expose those interactions explicitly instead of 223-way one-hot states.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

TRANSACTION_FEATURE_NAMES = [
    "Amount",
    "LogAmount",
    "Hour",
    "Minute",
    "Year",
    "Month",
    "Day",
    "Zip",
    "MCC",
    "IsOnline",
    "StateMissing",
    "StateRisky",
    "HasError",
    "IsNight",
    "CreditLimit",
    "CardOnDarkWeb",
    "FicoScore",
]

# States with highest empirical fraud rates (Person1/Person2 agreement).
RISKY_STATES = {"Italy", "Algeria", "Nigeria", "MISSING"}


def _parse_amount(value: object) -> float:
    try:
        return float(str(value).replace("$", "").replace(",", ""))
    except (ValueError, TypeError):
        return 0.0


def _parse_hour_minute(value: object) -> tuple[int, int]:
    try:
        parts = str(value).split(":")
        return int(parts[0]), int(parts[1]) if len(parts) > 1 else 0
    except (ValueError, TypeError, IndexError):
        return 12, 0


def _series(df: pd.DataFrame, name: str, default: object) -> pd.Series:
    """Return a column, or a same-length Series of `default` when absent.

    The single-row inference path may omit optional columns (e.g. Zip,
    Merchant State); returning a scalar here would break the `.fillna`
    / `.apply` calls that follow, so always materialize a Series.
    """
    if name in df.columns:
        return df[name]
    return pd.Series([default] * len(df), index=df.index)


def clean_transaction_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Clean raw IBM transaction rows into inference-ready numeric/categorical."""
    df = df.copy()
    df["Amount"] = _series(df, "Amount", 0).apply(_parse_amount).astype(float)
    if "Time" in df.columns:
        hours_minutes = df["Time"].apply(_parse_hour_minute)
        df["Hour"] = [hm[0] for hm in hours_minutes]
        df["Minute"] = [hm[1] for hm in hours_minutes]
    for col in ["Year", "Month", "Day"]:
        df[col] = pd.to_numeric(_series(df, col, 2000), errors="coerce").fillna(2000).astype(int)
    df["Zip"] = pd.to_numeric(_series(df, "Zip", -1), errors="coerce").fillna(-1)
    df["MCC"] = pd.to_numeric(_series(df, "MCC", 0), errors="coerce").fillna(0).astype(int)
    for col in ["Use Chip", "Merchant State", "Errors?"]:
        if col in df.columns:
            df[col] = df[col].fillna("MISSING").astype(str)
    if "Merchant State" in df.columns:
        counts = df["Merchant State"].value_counts()
        keep = set(counts[counts >= 50].index.tolist()) | RISKY_STATES
        df["Merchant State"] = df["Merchant State"].where(
            df["Merchant State"].isin(keep), "Other"
        )
    use_chip = df.get("Use Chip", pd.Series("", index=df.index)).astype(str)
    merchant_state = df.get("Merchant State", pd.Series("", index=df.index)).astype(str)
    errors = df.get("Errors?", pd.Series("MISSING", index=df.index)).astype(str)
    df["IsOnline"] = (use_chip == "Online Transaction").astype(int)
    df["StateMissing"] = (merchant_state == "MISSING").astype(int)
    df["StateRisky"] = merchant_state.isin(RISKY_STATES).astype(int)
    df["HasError"] = ((errors.notna()) & (errors != "MISSING")).astype(int)
    df["IsNight"] = df["Hour"].isin([0, 1, 2, 3, 4, 5]).astype(int)
    df["LogAmount"] = np.log1p(df["Amount"].clip(lower=0))
    n = len(df)
    df["CreditLimit"] = pd.to_numeric(
        df["CreditLimit"] if "CreditLimit" in df.columns else pd.Series([25000.0] * n, index=df.index),
        errors="coerce",
    ).fillna(25000.0)
    df["CardOnDarkWeb"] = pd.to_numeric(
        df["CardOnDarkWeb"] if "CardOnDarkWeb" in df.columns else pd.Series([0] * n, index=df.index),
        errors="coerce",
    ).fillna(0).astype(int)
    fico_src = (
        df["FICO Score"] if "FICO Score" in df.columns
        else (df["FicoScore"] if "FicoScore" in df.columns else pd.Series([700] * n, index=df.index))
    )
    df["FicoScore"] = pd.to_numeric(fico_src, errors="coerce").fillna(700)
    return df


def transaction_features(row: pd.Series) -> dict[str, float]:
    """Single-row feature dict (inference path, no aux join needed)."""
    cleaned = clean_transaction_frame(pd.DataFrame([row]))
    record = cleaned.iloc[0]
    return {name: float(record.get(name, 0.0)) for name in TRANSACTION_FEATURE_NAMES}


def transaction_feature_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Batch feature frame with fixed column order for training/serving."""
    cleaned = clean_transaction_frame(df)
    for name in TRANSACTION_FEATURE_NAMES:
        if name not in cleaned.columns:
            cleaned[name] = 0.0
    return cleaned[TRANSACTION_FEATURE_NAMES].fillna(0.0).astype("float64")
