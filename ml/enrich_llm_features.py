"""Generate cached numeric LLM features for model retraining.

This intentionally stores only the structured numeric contract, never the
LLM prose. It is resumable and safe to stop/restart.

Examples:
  python ml/enrich_llm_features.py --task message --limit 20000
  python ml/enrich_llm_features.py --task url --limit 20000

The resulting JSONL cache is passed to train.py with --llm-features.
"""
from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import pandas as pd
import yaml

from nexus_ml.data import _augment_benign_with_paths, load_message_texts
from nexus_ml.llm_features import input_hash, llm_feature_values


PROMPT = """Classify this input for phishing risk. Return JSON only:
{"riskLevel":"LOW|MEDIUM|HIGH|CRITICAL|UNKNOWN","score":0,"confidence":0.0}
The score must be 0-100 and confidence 0-1. Do not invent facts.
Input: """


def call_llm(base_url: str, api_key: str, model: str, value: str) -> dict[str, Any]:
    payload = {
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": "You are a phishing-risk feature extractor."},
            {"role": "user", "content": PROMPT + value[:8000]},
        ],
    }
    request = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        body = json.loads(response.read().decode("utf-8"))
    content = body["choices"][0]["message"]["content"].strip()
    start, end = content.find("{"), content.rfind("}")
    if start < 0 or end < start:
        raise ValueError("LLM did not return JSON")
    parsed = json.loads(content[start : end + 1])
    return {
        "proposedRiskLevel": parsed.get("riskLevel", "UNKNOWN"),
        "proposedScore": parsed.get("score", 0),
        "confidence": parsed.get("confidence", 0),
    }


def values_for_task(root: Path, config: dict[str, Any], task: str) -> list[str]:
    data = config["data"]
    if task == "message":
        texts, _, _ = load_message_texts(
            root / data["message_dataset"], root / data["sms_collection"]
        )
        return texts
    frame = pd.read_csv(root / data["url_dataset"], encoding_errors="replace")
    # Match load_url_data exactly, including benign path augmentation, so a
    # complete cache aligns with the rows used by train.py.
    frame = _augment_benign_with_paths(frame)
    return frame["URL"].fillna("").astype(str).tolist()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", choices=["message", "url"], required=True)
    parser.add_argument("--config", type=Path, default=Path("ml/config.yaml"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--sleep", type=float, default=0.0)
    args = parser.parse_args()

    config = yaml.safe_load(args.config.read_text(encoding="utf-8"))
    root = args.config.parent.parent.resolve()
    output = args.output or root / "ml" / "artifacts" / f"llm-features-{args.task}.jsonl"
    output.parent.mkdir(parents=True, exist_ok=True)
    cache: dict[str, dict[str, Any]] = {}
    if output.exists():
        for line in output.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                cache[row["input_hash"]] = row

    values = values_for_task(root, config, args.task)
    if args.limit:
        values = values[: args.limit]
    base_url = os.environ.get("AI_BASE_URL", "https://api.openai.com/v1")
    api_key = os.environ.get("AI_API_KEY", "")
    model = os.environ.get("AI_MODEL", "gpt-4o-mini")
    if not api_key:
        raise SystemExit("AI_API_KEY is required")

    with output.open("a", encoding="utf-8") as handle:
        for index, value in enumerate(values, start=1):
            key = input_hash(value)
            if key in cache:
                continue
            try:
                analysis = call_llm(base_url, api_key, model, value)
                row = {"input_hash": key, "task": args.task, **llm_feature_values(analysis)}
            except (OSError, ValueError, KeyError, json.JSONDecodeError, urllib.error.HTTPError) as error:
                print(f"failed row {index}: {type(error).__name__}")
                continue
            handle.write(json.dumps(row) + "\n")
            handle.flush()
            cache[key] = row
            if args.sleep:
                time.sleep(args.sleep)
    print(json.dumps({"task": args.task, "rows_seen": len(values), "cached": len(cache), "output": str(output)}))


if __name__ == "__main__":
    main()
