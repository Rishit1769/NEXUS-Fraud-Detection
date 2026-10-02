# NEXUS Model Information

## 1. Purpose

NEXUS is an explainable phishing and digital-fraud safety platform. It accepts suspicious messages, URLs, emails, and WhatsApp conversations; extracts evidence; calculates risk; explains the result; and escalates serious cases to authorized officers.

The system must use separate responsibilities:

```text
Deterministic rules -> hard safety signals and policy constraints
XGBoost models      -> calibrated probability and classification
SHAP                -> local model contribution evidence
Threat intelligence -> external reputation and domain observations
AI provider            -> plain-language explanation and safe reply
Officer             -> final decision for serious or uncertain cases
```

AI provider must never be treated as the numeric fraud classifier or allowed to override a critical deterministic rule.

## 2. Current Implementation Boundary

The current NEXUS application already has a deterministic analysis pipeline, stored analysis results, URL extraction, user conversations, WhatsApp/n8n ingestion, AI provider explanation integration, officer incidents, notifications, and audit records.

The XGBoost models described below are the planned ML layer. They are not production-ready merely because a dataset has been downloaded. A model becomes production-ready only after training, grouped/time-aware testing, calibration, explainability checks, artifact registration, shadow deployment, and officer review.

## 3. Recommended Model Suite

### 3.1 Message fraud classifier

Binary XGBoost classifier for WhatsApp, SMS, email, and portal messages.

```text
Target: benign = 0, suspicious/fraudulent = 1
Input: text, extracted signals, URLs, channel, conversation context
Output: raw probability, calibrated probability, top features
```

### 3.2 URL and domain risk classifier

Binary XGBoost classifier dedicated to URL and domain evidence.

```text
Target: benign = 0, phishing/malicious = 1
Input: URL lexical, host, DNS/TLS, redirects, reputation, brand mismatch
Output: URL probability, domain risk, feature evidence
```

This must remain separate from the message model because URLs and natural-language messages have different distributions.

### 3.3 Fraud category classifier

Use multi-label classification because one case may involve multiple behaviors:

```text
credential_phishing, otp_theft, payment_scam
bank_impersonation, government_impersonation, delivery_scam
job_scam, investment_scam, romance_scam
account_takeover, malware_distribution, social_engineering
```

Categories should be based on controlled labels and officer-reviewed corrections, not unreviewed LLM output.

### 3.4 Risk and escalation policy

Initially derive `LOW`, `MEDIUM`, `HIGH`, and `CRITICAL` from calibrated probability, deterministic score, hard rules, and documented policy thresholds. A later model may predict officer priority such as `NORMAL`, `PRIORITY`, `URGENT`, and `EMERGENCY` after enough officer decisions are available.

## 4. Feature Catalog

### Message features

```text
message_length, word_count, sentence_count, url_count
domain_count, phone_count, email_count, digit_count
uppercase_ratio, special_character_ratio, emoji_count
language_hint, repeated_character_count
```

### Social-engineering signals

```text
urgency_terms, threat_terms, secrecy_terms, authority_claim_terms
reward_terms, account_suspension_terms, verification_terms
channel_switch_terms, call_now_terms
```

### Sensitive-data and payment signals

```text
asks_for_otp, asks_for_password, asks_for_pin
asks_for_card_data, asks_for_bank_data, asks_for_identity_document
asks_for_payment, asks_to_install_app, asks_to_open_attachment
```

Store only the signal and its location or evidence reference. Never store the requested secret itself.

### URL and domain signals

```text
url_length, host_length, path_length, query_length
subdomain_count, digit_count_in_host, hyphen_count_in_host, dot_count
has_ip_host, has_punycode, has_percent_encoding, has_at_symbol
has_nonstandard_port, uses_shortener, https_present
domain_age_days, dns_status, tls_status, redirect_count
final_host_differs, brand_host_mismatch, tranco_rank
phishtank_match, reputation_lookup_status
```

### Conversation context

```text
messages_in_conversation, sender_message_count, rapid_message_burst
new_domain_in_thread, repeated_urgency, user_clicked_or_replied
prior_report_count
```

Every feature must be versioned and available at inference time. Do not leak future officer decisions into the model input.

## 5. Deterministic Rules

Rules provide hard evidence and safety constraints. Important signals include:

- OTP, password, PIN, or credential requests.
- Payment, bank-transfer, gift-card, or cryptocurrency requests.
- Urgency, threats, secrecy, or pressure to act immediately.
- Impersonation of banks, government agencies, delivery companies, employers, or support teams.
- Punycode, lookalike hosts, raw IP hosts, suspicious ports, shortened links, and redirect chains.
- Requests to install software, open an attachment, or move the conversation to another channel.

Each rule result should contain a stable code, severity, description, evidence location, version, and contribution. A critical rule may raise the final risk level; the ML model must not lower it.

## 6. Data Sources

Use multiple sources and preserve provenance:

- **PhiUSIIL:** initial phishing URL training baseline.
- **PhishTank:** fresh phishing URL intelligence, with feed timestamp and provider status.
- **Tranco:** likely-benign domain candidates, not a permanent safety guarantee.
- **UCI SMS Spam Collection:** initial text-processing baseline.
- **SMS phishing dataset:** additional message examples after manual review.
- **NEXUS officer cases:** highest-value feedback after privacy redaction and adjudication.

Kaggle is suitable for experimentation but must not be the only source for production training.

## 7. Labels and Provenance

Canonical labels:

```text
fraud: 0/1
category: one or more controlled category codes
risk: low/medium/high/critical
action: safe/monitor/block/escalate
```

Prefer officer-adjudicated labels, then confirmed threat-intelligence labels, reviewed manual labels, and finally weak external labels. Keep `label_provenance` and `label_confidence` with every row. Weak labels should not be the only content in the final test set.

## 8. Training and Evaluation

Use a time-aware and grouped split:

```text
Train: 70%
Validation: 15%
Test: 15%
```

Do not share domains, URLs, duplicate templates, or campaign groups across splits. Maintain a frozen stress set for new templates, short URLs, multilingual messages, lookalike domains, and obfuscation.

The first XGBoost baseline can use:

```python
from xgboost import XGBClassifier

model = XGBClassifier(
    objective="binary:logistic",
    eval_metric="aucpr",
    n_estimators=600,
    max_depth=5,
    learning_rate=0.04,
    min_child_weight=3,
    subsample=0.85,
    colsample_bytree=0.85,
    reg_alpha=0.2,
    reg_lambda=2.0,
    tree_method="hist",
    random_state=42,
)
```

Report PR-AUC, ROC-AUC, precision and recall at operational thresholds, false-positive rate, false-negative rate, Brier score, calibration curves, slice metrics, latency, and failure rate. Calibrate probabilities with Platt scaling or isotonic regression using validation data only.

## 9. Explainability

Store model contributions separately from rule evidence:

```json
{
  "modelVersion": "message-xgb-2026-08-001",
  "featureVersion": "features-2026-08-001",
  "topFeatures": [
    {
      "name": "asks_for_otp",
      "value": 1,
      "contribution": 0.82,
      "direction": "risk_increasing"
    }
  ],
  "ruleEvidence": [
    {
      "code": "OTP_REQUEST",
      "severity": "high"
    }
  ]
}
```

SHAP shows model contribution; it is not proof of fraud. AI provider should receive structured evidence, score, limitations, and safe policy instructions. It must not invent URLs, provider results, or facts.

## 10. Model Registry

Each approved artifact needs:

```text
model_name, model_version, feature_version, rule_version
dataset_version, source_manifest, code_commit, library_versions
training_timestamp, metrics, calibration_artifact
threshold_policy, input_schema, rollback_predecessor, approval_status
```

Example layout:

```text
artifacts/
  message-fraud/2026-08-001/
    model.json
    calibration.json
    manifest.json
    metrics.json
    feature_schema.json
  url-risk/2026-08-001/
    ...
```

Only approved registry versions may be loaded by inference services.

## 11. NEXUS Inference Contract

Request:

```json
{
  "requestId": "analysis-id",
  "modelVersion": "message-fraud-2026-08-001",
  "featureVersion": "features-2026-08-001",
  "channel": "WHATSAPP",
  "text": "redacted message",
  "urls": ["https://example.test/login"],
  "context": {"conversationMessageCount": 3}
}
```

Response:

```json
{
  "requestId": "analysis-id",
  "rawProbability": 0.91,
  "calibratedProbability": 0.87,
  "predictedCategories": ["credential_phishing"],
  "topFeatures": [],
  "status": "SUCCESS",
  "failureCode": null
}
```

Persist `rawProbability`, `calibratedProbability`, `deterministicScore`, `modelVersion`, `featureVersion`, `ruleVersion`, prediction status, inference latency, failure code, and explanation version. If model inference fails, retain the deterministic result and return a controlled `UNAVAILABLE` state.

## 12. Production Lifecycle

1. Inventory datasets, licenses, timestamps, and labels.
2. Normalize and redact data.
3. Build versioned features with unit tests.
4. Train URL and message baselines independently.
5. Evaluate grouped/time-aware and stress-set performance.
6. Calibrate probabilities and document thresholds.
7. Generate SHAP explanations and compare them with rules.
8. Deploy in shadow mode without changing user decisions.
9. Obtain officer approval and run a controlled canary.
10. Monitor drift, feedback, latency, and queue impact.
11. Retrain only from reviewed, versioned data.
12. Roll back to the previous approved artifact when required.

## Related Documents

- `docs/dream-build.md` - product, architecture, operations, and delivery plan.
- `docs/model_training.md` - practical dataset, feature, training, and evaluation runbook.
- `docs/n8n/README.md` - WhatsApp automation and AI provider workflow.
