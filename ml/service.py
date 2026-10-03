from __future__ import annotations

import hmac
import json
import os
from pathlib import Path
from typing import Any

import pandas as pd
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from xgboost import XGBClassifier
from urllib.parse import urlparse

from nexus_ml.features import (
    message_feature_frame,
    url_feature_frame,
    url_lexical_frame,
)
from nexus_ml.llm_features import LLM_FEATURE_NAMES, runtime_llm_frame
from nexus_ml.transaction_features import transaction_feature_frame


ROOT = Path(__file__).resolve().parent
ARTIFACT_ROOT = Path(os.getenv("MODEL_ARTIFACT_ROOT", str(ROOT / "artifacts")))
API_SECRET = os.getenv("MODEL_API_SECRET", "")
# Fail closed by default: production must not silently serve legacy artifacts
# that ignore the LLM-derived inputs.
REQUIRE_LLM_FEATURES = os.getenv("REQUIRE_LLM_FEATURES", "true").lower() in {"1", "true", "yes"}

KNOWN_SAFE_DOMAINS = {
    "google.com", "gmail.com", "google.co.in", "hdfcbank.com", "sbi.co.in",
    "onlinesbi.sbi", "icicibank.com", "axisbank.com", "paypal.com",
    "amazon.com", "amazon.in", "netflix.com", "whatsapp.com", "instagram.com",
    "microsoft.com", "apple.com", "telegram.org", "irctc.co.in",
}


class PredictRequest(BaseModel):
    requestId: str = Field(min_length=1, max_length=200)
    text: str = Field(default="", max_length=100_000)
    urls: list[str] = Field(default_factory=list, max_length=20)
    urlFeatures: list[dict[str, float]] | None = None
    # Advisory context from the preceding LLM stage. Existing trained models
    # do not consume this as a feature; it is accepted for workflow ordering
    # and future models retrained with this input contract.
    llmAnalysis: dict[str, Any] | None = None
    transaction: dict[str, Any] | None = None


class FeatureContribution(BaseModel):
    name: str
    value: float
    importance: float
    direction: str


class Prediction(BaseModel):
    task: str
    modelVersion: str
    featureVersion: str
    probability: float
    calibrated: bool
    riskLevel: str
    topFeatures: list[FeatureContribution]


class PredictResponse(BaseModel):
    requestId: str
    message: Prediction | None
    urls: list[Prediction]
    transaction: Prediction | None = None


app = FastAPI(title="NEXUS Model API", version="1.0.0")


def _check_secret(api_key: str | None) -> None:
    if API_SECRET and not api_key:
        raise HTTPException(status_code=401, detail="Missing model API key")
    if API_SECRET and not hmac.compare_digest(api_key or "", API_SECRET):
        raise HTTPException(status_code=401, detail="Invalid model API key")


def _latest_artifact(task: str) -> Path | None:
    candidates = sorted((ARTIFACT_ROOT / task).glob("*/model.json"))
    return candidates[-1].parent if candidates else None


def _load_model(task: str) -> tuple[XGBClassifier, dict[str, Any], dict[str, float], Path] | None:
    artifact = _latest_artifact(task)
    if artifact is None:
        return None
    model = XGBClassifier()
    model.load_model(artifact / "model.json")
    manifest = json.loads((artifact / "feature_manifest.json").read_text(encoding="utf-8"))
    defaults_path = artifact / "feature_defaults.json"
    defaults = json.loads(defaults_path.read_text(encoding="utf-8")) if defaults_path.exists() else {}
    return model, manifest, defaults, artifact


def _artifact_uses_llm_features(task: str) -> bool:
    candidates = []
    if task == "message":
        candidates = sorted((ARTIFACT_ROOT / "message-tfidf").glob("*/feature_manifest.json"))
    if not candidates:
        candidates = sorted((ARTIFACT_ROOT / task).glob("*/feature_manifest.json"))
    artifact = candidates[-1].parent if candidates else None
    if artifact is None:
        return False
    try:
        manifest = json.loads((artifact / "feature_manifest.json").read_text(encoding="utf-8"))
        columns = manifest.get("columns", [])
        llm_columns = manifest.get("llm_columns", [])
        return any(str(column).startswith("llm_") for column in columns) or bool(llm_columns)
    except (OSError, json.JSONDecodeError):
        return False


def _risk_level(probability: float) -> str:
    if probability >= 0.95:
        return "CRITICAL"
    if probability >= 0.80:
        return "HIGH"
    if probability >= 0.50:
        return "MEDIUM"
    return "LOW"


def _is_known_safe_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower().removeprefix("www.")
    return any(host == domain or host.endswith("." + domain) for domain in KNOWN_SAFE_DOMAINS)


def _predict(task: str, frame: pd.DataFrame, llm_analysis: dict[str, Any] | None = None) -> Prediction | None:
    loaded = _load_model(task)
    if loaded is None:
        return None
    model, manifest, defaults, artifact = loaded
    columns = list(manifest["columns"])
    if llm_analysis and any(column in columns for column in LLM_FEATURE_NAMES):
        frame = pd.concat([frame, runtime_llm_frame(llm_analysis, len(frame))], axis=1)
    for column in columns:
        if column not in frame.columns:
            frame[column] = defaults.get(column, 0.0)
    frame = frame[columns].fillna(0.0).astype("float64")
    probability = float(model.predict_proba(frame)[0, 1])
    calibrated = False
    calibration_path = artifact / "calibration_model.joblib"
    if calibration_path.exists():
        try:
            import joblib as _joblib

            iso = _joblib.load(calibration_path)
            probability = float(iso.predict([probability])[0])
            calibrated = True
        except Exception:
            pass
    importances = getattr(model, "feature_importances_", [])
    ranked = sorted(zip(columns, frame.iloc[0].tolist(), importances), key=lambda item: item[2], reverse=True)[:8]
    top_features = [
        FeatureContribution(
            name=name,
            value=float(value),
            importance=float(importance),
            direction="unknown",
        )
        for name, value, importance in ranked
        if float(importance) > 0
    ]
    return Prediction(
        task=task,
        modelVersion=f"xgboost-{task}-{artifact.name}",
        featureVersion=str(manifest["feature_version"]),
        probability=probability,
        calibrated=calibrated,
        riskLevel=_risk_level(probability),
        topFeatures=top_features,
    )


def _predict_message_tfidf(text: str, llm_analysis: dict[str, Any] | None = None) -> Prediction | None:
    """TF-IDF message head (preferred). Falls back to count head if absent."""
    cands = sorted((ARTIFACT_ROOT / "message-tfidf").glob("*/model.json"))
    if not cands:
        return None
    artifact = cands[-1].parent
    try:
        import joblib as _joblib

        from nexus_ml.message_tfidf import transform as _tfidf_transform

        model = XGBClassifier()
        model.load_model(artifact / "model.json")
        vecs = _joblib.load(artifact / "vectorizer.joblib")
        manifest = json.loads((artifact / "feature_manifest.json").read_text(encoding="utf-8"))
        frame = _tfidf_transform(
            vecs["char"], vecs["word"], pd.Series([text]),
            llm_analysis=llm_analysis if manifest.get("llm_columns") else None,
        )
        probability = float(model.predict_proba(frame)[0, 1])
        importances = getattr(model, "feature_importances_", [])
        top_features = [
            FeatureContribution(name=f"tfidf-rank-{rank}", value=0.0,
                                importance=float(imp), direction="unknown")
            for rank, imp in enumerate(sorted(importances, reverse=True)[:8])
            if float(imp) > 0
        ]
        return Prediction(
            task="message",
            modelVersion=f"xgboost-message-tfidf-{artifact.name}",
            featureVersion=str(manifest.get("feature_version", "message-tfidf-1")),
            probability=probability,
            calibrated=False,
            riskLevel=_risk_level(probability),
            topFeatures=top_features,
        )
    except Exception:
        return None


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    llm_aware = {
        "message": _artifact_uses_llm_features("message"),
        "url": _artifact_uses_llm_features("url"),
        "transaction": _artifact_uses_llm_features("transaction"),
    }
    ready = not REQUIRE_LLM_FEATURES or (llm_aware["message"] and llm_aware["url"])
    if not ready:
        raise HTTPException(status_code=503, detail={"message": "LLM-aware message and URL artifacts are required", "llmAware": llm_aware})
    return {
        "ok": True,
        "ready": ready,
        "requireLlmFeatures": REQUIRE_LLM_FEATURES,
        "llmAware": llm_aware,
        "service": "nexus-model-api",
        "messageModel": _latest_artifact("message") is not None,
        "messageTfidfModel": bool(sorted((ARTIFACT_ROOT / "message-tfidf").glob("*/model.json"))),
        "urlModel": _latest_artifact("url") is not None,
        "transactionModel": _latest_artifact("transaction") is not None,
    }


@app.post("/v1/predict", response_model=PredictResponse)
def predict(payload: PredictRequest, x_model_api_key: str | None = Header(default=None)) -> PredictResponse:
    _check_secret(x_model_api_key)
    message = None
    if payload.text.strip():
        message = _predict_message_tfidf(payload.text, payload.llmAnalysis)
        if message is None:
            message = _predict(
                "message", message_feature_frame(pd.Series([payload.text])), payload.llmAnalysis
            )

    url_predictions: list[Prediction] = []
    for url in payload.urls:
        # Lexical head scores raw URLs directly; urlFeatures enrichment is
        # reserved for a future page-level head and is not required.
        prediction = _predict("url", url_lexical_frame(pd.Series([url])), payload.llmAnalysis)
        if prediction is not None and _is_known_safe_url(url):
            # The legacy lexical URL artifact overweights HTTP vs HTTPS. Keep
            # the prediction endpoint safe while the artifact is retrained;
            # deterministic host checks still explain suspicious lookalikes.
            prediction = prediction.copy(update={
                "probability": 0.0,
                "riskLevel": "LOW",
                "topFeatures": [],
            })
        if prediction is not None:
            url_predictions.append(prediction)

    transaction_prediction = None
    if payload.transaction:
        txn_frame = transaction_feature_frame(pd.DataFrame([payload.transaction]))
        transaction_prediction = _predict("transaction", txn_frame, payload.llmAnalysis)

    return PredictResponse(
        requestId=payload.requestId,
        message=message,
        urls=url_predictions,
        transaction=transaction_prediction,
    )
