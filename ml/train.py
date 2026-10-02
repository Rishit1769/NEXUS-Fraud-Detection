from __future__ import annotations

import argparse
import json
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd
import yaml
from sklearn.linear_model import LogisticRegression
from xgboost import XGBClassifier

from nexus_ml.data import load_message_data, load_url_data
from nexus_ml.evaluation import evaluate_binary
from nexus_ml.splitting import grouped_stratified_indices


def load_config(path: Path) -> dict[str, Any]:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def train(task: str, config_path: Path, llm_features_path: Path | None = None) -> Path:
    config = load_config(config_path)
    root = config_path.parent.parent.resolve()
    if llm_features_path and not llm_features_path.is_absolute():
        llm_features_path = (Path.cwd() / llm_features_path).resolve()
    data_config = config["data"]
    if task == "url":
        features, labels, groups = load_url_data(
            root / data_config["url_dataset"], llm_features_path
        )
    else:
        features, labels, groups = load_message_data(
            root / data_config["message_dataset"],
            root / data_config["sms_collection"],
            llm_features_path,
        )

    indices = grouped_stratified_indices(labels.to_numpy(), groups.to_numpy(), config["seed"])
    train_idx, validation_idx, test_idx = indices["train"], indices["validation"], indices["test"]
    if min(len(train_idx), len(validation_idx), len(test_idx)) == 0:
        raise RuntimeError("Grouped split produced an empty partition")

    parameters = dict(config["model"])
    parameters.update(objective="binary:logistic", eval_metric="aucpr", random_state=config["seed"])
    model = XGBClassifier(**parameters)
    model.fit(
        features.iloc[train_idx],
        labels.iloc[train_idx],
        eval_set=[(features.iloc[validation_idx], labels.iloc[validation_idx])],
        verbose=False,
    )
    baseline = LogisticRegression(max_iter=300, class_weight="balanced", random_state=config["seed"])
    baseline.fit(features.iloc[train_idx], labels.iloc[train_idx])

    version = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = root / config["output_dir"] / task / version
    output.mkdir(parents=True, exist_ok=True)
    model.save_model(output / "model.json")

    metrics = {
        "task": task,
        "rows": len(features),
        "class_balance": {str(int(label)): int((labels == label).sum()) for label in sorted(labels.unique())},
        "train": evaluate_binary(labels.iloc[train_idx], model.predict_proba(features.iloc[train_idx])[:, 1]),
        "validation": evaluate_binary(labels.iloc[validation_idx], model.predict_proba(features.iloc[validation_idx])[:, 1]),
        "test": evaluate_binary(labels.iloc[test_idx], model.predict_proba(features.iloc[test_idx])[:, 1]),
        "baseline_logistic": {
            "validation": evaluate_binary(labels.iloc[validation_idx], baseline.predict_proba(features.iloc[validation_idx])[:, 1]),
            "test": evaluate_binary(labels.iloc[test_idx], baseline.predict_proba(features.iloc[test_idx])[:, 1]),
        },
    }
    (output / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    (output / "feature_manifest.json").write_text(
        json.dumps({"feature_version": f"{task}-features-2", "llm_feature_version": "llm-features-1" if llm_features_path else None, "columns": list(features.columns), "dtypes": {name: str(value) for name, value in features.dtypes.items()}}, indent=2),
        encoding="utf-8",
    )
    (output / "feature_defaults.json").write_text(
        json.dumps({name: float(value) for name, value in features.median(numeric_only=True).items()}, indent=2),
        encoding="utf-8",
    )
    (output / "split_manifest.json").write_text(
        json.dumps({"strategy": "grouped_stratified", "groups": "domain-or-normalized-text", "sizes": {name: len(value) for name, value in indices.items()}}, indent=2),
        encoding="utf-8",
    )
    (output / "training_manifest.json").write_text(
        json.dumps({"task": task, "created_at": version, "python": platform.python_version(), "platform": platform.platform(), "config": config}, indent=2, default=str),
        encoding="utf-8",
    )
    print(json.dumps({"artifact": str(output), "metrics": metrics}, indent=2))
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a NEXUS phishing model")
    parser.add_argument("--task", choices=["url", "message"], required=True)
    parser.add_argument("--config", type=Path, default=Path("ml/config.yaml"))
    parser.add_argument(
        "--llm-features",
        type=Path,
        help="JSONL cache produced by enrich_llm_features.py; required for LLM-aware retraining",
    )
    args = parser.parse_args()
    train(args.task, args.config, args.llm_features)


if __name__ == "__main__":
    main()
