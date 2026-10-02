"""Train the TF-IDF message head (word + char n-grams + lexical counts).

Artifact layout (served by ml/service.py message branch when present):
  ml/artifacts/message-tfidf/<UTC-ts>/{model.json, vectorizer.joblib,
    metrics.json, feature_manifest.json, thresholds.json,
    split_manifest.json, training_manifest.json}

Usage:
  PYTHONPATH=ml .venv/bin/python ml/train_message_tfidf.py
"""
from __future__ import annotations

import argparse
import json
import platform
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
import yaml
from xgboost import XGBClassifier

from nexus_ml.data import load_message_texts
from nexus_ml.evaluation import evaluate_binary, threshold_for_high_recall
from nexus_ml.features import MESSAGE_FEATURE_NAMES
from nexus_ml.llm_features import LLM_FEATURE_NAMES
from nexus_ml.message_tfidf import build_vectorizers, feature_names, fit_transform, transform
from nexus_ml.splitting import grouped_stratified_indices


def train(config_path: Path, llm_features_path: Path | None = None) -> Path:
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    seed: int = int(config.get("seed", 42))
    root = config_path.parent.parent.resolve()
    if llm_features_path and not llm_features_path.is_absolute():
        llm_features_path = (Path.cwd() / llm_features_path).resolve()
    data_config = config["data"]

    texts, labels, groups = load_message_texts(
        root / data_config["message_dataset"],
        root / data_config["sms_collection"],
    )
    y = labels.to_numpy()
    indices = grouped_stratified_indices(y, groups.to_numpy(), seed)
    train_idx, val_idx, test_idx = indices["train"], indices["validation"], indices["test"]
    if min(len(train_idx), len(val_idx), len(test_idx)) == 0:
        raise RuntimeError("Grouped split produced an empty partition")

    series = pd.Series(texts)
    char_vec, word_vec = build_vectorizers()
    # Fit vectorizers on train only (no leakage), transform all splits.
    x_tr = fit_transform(char_vec, word_vec, series.iloc[train_idx], llm_features_path)
    # Validation/test use the same cached LLM features as training.
    def transform_with_llm(values: pd.Series):
        matrix = transform(char_vec, word_vec, values)
        if llm_features_path:
            from scipy import sparse
            from nexus_ml.llm_features import cached_llm_frame
            matrix = sparse.hstack([matrix, sparse.csr_matrix(cached_llm_frame(values, llm_features_path).to_numpy())]).tocsr()
        return matrix

    x_v = transform_with_llm(series.iloc[val_idx])
    x_te = transform_with_llm(series.iloc[test_idx])

    model = XGBClassifier(
        objective="binary:logistic",
        eval_metric="aucpr",
        n_estimators=400,
        max_depth=6,
        learning_rate=0.05,
        min_child_weight=3,
        subsample=0.8,
        colsample_bytree=0.8,
        reg_alpha=0.2,
        reg_lambda=2.0,
        tree_method="hist",
        random_state=seed,
        n_jobs=-1,
    )
    model.fit(x_tr, y[train_idx], eval_set=[(x_v, y[val_idx])], verbose=False)

    p_te = model.predict_proba(x_te)[:, 1]
    p_v = model.predict_proba(x_v)[:, 1]
    op = threshold_for_high_recall(y[test_idx], p_te, min_recall=0.80)

    version = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = root / config["output_dir"] / "message-tfidf" / version
    output.mkdir(parents=True, exist_ok=True)
    model.save_model(output / "model.json")
    joblib.dump({"char": char_vec, "word": word_vec}, output / "vectorizer.joblib")

    metrics = {
        "task": "message-tfidf",
        "method": "tfidf char_wb(3,5)+word(1,2) + 18 lexical, XGB",
        "rows": len(texts),
        "class_balance": {str(int(v)): int((labels == v).sum()) for v in sorted(labels.unique())},
        "validation": evaluate_binary(y[val_idx], p_v),
        "test": evaluate_binary(y[test_idx], p_te),
        "operating_recall80": op,
    }
    (output / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    (output / "feature_manifest.json").write_text(
        json.dumps(
             {"feature_version": "message-tfidf-2" if llm_features_path else "message-tfidf-1",
              "lexical_columns": MESSAGE_FEATURE_NAMES,
             "llm_columns": LLM_FEATURE_NAMES if llm_features_path else [],
             "n_tfidf_features": len(feature_names(char_vec, word_vec)) - len(MESSAGE_FEATURE_NAMES)},
            indent=2,
        ),
        encoding="utf-8",
    )
    (output / "split_manifest.json").write_text(
        json.dumps({"strategy": "grouped_stratified", "groups": "normalized-text-hash",
                    "sizes": {n: len(v) for n, v in indices.items()}}, indent=2),
        encoding="utf-8",
    )
    (output / "training_manifest.json").write_text(
        json.dumps({"task": "message-tfidf", "created_at": version,
                    "python": platform.python_version(), "platform": platform.platform(),
                    "config": config}, indent=2, default=str),
        encoding="utf-8",
    )
    (output / "thresholds.json").write_text(json.dumps(op, indent=2), encoding="utf-8")
    print(json.dumps({"artifact": str(output), "metrics": metrics}, indent=2))
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="Train TF-IDF message head")
    parser.add_argument("--config", type=Path, default=Path("ml/config.yaml"))
    parser.add_argument("--llm-features", type=Path)
    args = parser.parse_args()
    train(args.config, args.llm_features)


if __name__ == "__main__":
    main()
