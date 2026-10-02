# NEXUS ML Training

This pipeline trains reproducible URL-risk and message-fraud baselines from the downloaded local datasets. It does not invent transaction features because the current Prisma schema contains conversations, messages, URLs, analysis results, and officer outcomes, not financial transactions.

## Setup

From the repository root:

```powershell
python -m venv .venv-ml
.\.venv-ml\Scripts\Activate.ps1
python -m pip install -r ml/requirements.txt
```

The repository's dataset files are intentionally ignored by Git. Place them at the repository root or update `ml/config.yaml`.

## Train

```powershell
python ml/train.py --task url --config ml/config.yaml
python ml/train.py --task message --config ml/config.yaml
```

## LLM-aware retraining

The production model can consume a fixed numeric projection of the preceding
LLM result. Raw LLM prose is never passed to XGBoost. First generate a
resumable JSONL cache (using the same provider configuration as the app), then
train an artifact whose feature manifest includes `llm-features-1`:

```powershell
python ml/enrich_llm_features.py --task message --config ml/config.yaml
python ml/enrich_llm_features.py --task url --config ml/config.yaml
python ml/train_message_tfidf.py --config ml/config.yaml --llm-features ml/artifacts/llm-features-message.jsonl
python ml/train.py --task url --config ml/config.yaml --llm-features ml/artifacts/llm-features-url.jsonl
```

Enrich the complete training corpus before production retraining. A partial
cache is useful for experiments but causes missing rows to receive default
LLM values and must not be treated as a production-quality model.

The features are `llm_proposed_score`, `llm_confidence`, one-hot risk level,
and `llm_disagreement`. At inference, the application sends the LLM result to
the model service and the service converts it to the same schema. Older model
artifacts without these columns continue to work and simply ignore the extra
context. For local experiments with legacy artifacts only, explicitly set
`REQUIRE_LLM_FEATURES=false`; production should leave the default enabled.

Artifacts are written to `ml/artifacts/<task>/<version>/` and include the XGBoost model, feature manifest, metrics, split manifest, and training manifest. The output directory is ignored by Git.

## Data boundaries

- `PhiUSIIL_Phishing_URL_Dataset.csv`: URL baseline; label `0` is phishing and `1` is benign, verified against representative rows.
- `verified_online.csv`: PhishTank positive URL candidates; labels are mapped to phishing.
- `top-1m.csv`: Tranco benign-domain candidates; used only as a source for future lexical examples.
- `Dataset_5971.csv`: labeled SMS/message dataset.
- `SMSSpamCollection`: UCI SMS baseline, with `spam` mapped to suspicious and `ham` to benign.

The current Prisma schema has no training-table contract. NEXUS officer outcomes should be exported into the canonical schema described in `docs/model_training.md` after privacy review, then added as a versioned data source.

## Model API

Run the internal API after artifacts exist:

```powershell
$env:MODEL_API_SECRET="replace-with-a-long-random-secret"
python -m uvicorn service:app --app-dir ml --host 127.0.0.1 --port 8001
```

`POST /v1/predict` accepts message text and returns the message-model
probability. URL predictions are intentionally returned only when the caller
supplies the complete page-level feature payload expected by the URL artifact;
a raw URL alone is not enough for a trustworthy prediction. `GET /healthz`
reports whether message and URL artifacts are mounted.

## Limitations

The first pipeline uses engineered numeric features and does not claim production accuracy. It must be evaluated on time/domain/campaign-separated data, calibrated, compared with the deterministic NEXUS rules, and shadow-deployed before it changes user-facing decisions.
