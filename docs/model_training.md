# NEXUS Model Training Runbook

This document defines how NEXUS should collect data, create features, train XGBoost models, evaluate them honestly, and introduce them into production. The product and architecture plan is in `dream-build.md`. The broader model design is in `model_information.md`.

## 1. Current Boundary

The current application already performs deterministic fraud analysis and can optionally use AI provider for explanation. XGBoost is the next machine-learning phase. It must be trained, evaluated, calibrated, versioned, and tested in shadow mode before it changes production decisions.

AI provider is not the fraud classifier. It explains structured evidence and drafts a safe response. It must not be the source of a numeric risk score.

## 2. Recommended Model Suite

### Message fraud classifier

```text
Input: message text, extracted indicators, URLs, channel, context
Algorithm: XGBoost binary classifier
Target: benign = 0, suspicious/fraud = 1
Output: raw probability, calibrated probability, feature evidence
```

This is the primary model for WhatsApp, SMS, email, and portal submissions.

### URL and domain risk classifier

```text
Input: URL lexical, host, DNS/TLS, redirect, reputation, brand features
Algorithm: XGBoost binary classifier
Target: benign = 0, phishing/malicious = 1
Output: URL probability, domain risk, feature explanation
```

Keep this separate from the message model because URLs have a different data distribution and feature set.

### Fraud category classifier

Use multi-label targets because one message may contain several behaviors:

```text
credential_phishing, otp_theft, payment_scam
bank_impersonation, government_impersonation, delivery_scam
job_scam, investment_scam, romance_scam
account_takeover, malware_distribution, social_engineering
```

Begin with deterministic labels and officer-reviewed corrections. Do not use an LLM-generated category as ground truth without review.

### Risk and escalation models

Initially derive `LOW`, `MEDIUM`, `HIGH`, and `CRITICAL` using calibrated probability, deterministic score, hard rules, and policy thresholds. Train a separate risk-level model only after enough officer-adjudicated labels exist. A later escalation model can predict `NORMAL`, `PRIORITY`, `URGENT`, and `EMERGENCY`.

## 3. Dataset Plan

Do not train production models from one Kaggle CSV. Kaggle is useful for a reproducible baseline, but NEXUS needs multiple sources and eventually officer-reviewed cases.

### URL sources

- Start with the [PhiUSIIL Phishing URL Dataset](https://www.kaggle.com/datasets/ndarvind/phiusiil-phishing-url-dataset) and record its [UCI source](https://archive.ics.uci.edu/dataset/967/phiusiil+phishing+url+dataset), license, and download date.
- Add fresh positive examples from [PhishTank](https://phishtank.org/developer_info.php). Record feed timestamp and source ID; treat it as threat intelligence, not perfect ground truth.
- Use [Tranco](https://tranco-list.eu/) as a source of likely-benign domains. A Tranco domain is not a permanent safety guarantee.

### Message sources

- Use the [UCI SMS Spam Collection](https://archive.ics.uci.edu/dataset/228/sms) for the first text baseline.
- Add the [Kaggle SMS Phishing Dataset](https://www.kaggle.com/datasets/fadlifatih/sms-phishing-dataset) after manual label review.
- Add NEXUS WhatsApp and portal cases after officer adjudication and privacy redaction.

Spam, advertising, and phishing are not identical. Map source labels deliberately instead of mapping every `spam` row to fraud.

### NEXUS feedback schema

Store or export these fields through an approved privacy process:

```text
case_id, source_channel, protected_message_reference
normalized_urls, normalized_domains, initial_rule_output
officer_label, fraud_categories, risk_level, officer_decision
label_confidence, review_timestamp, reviewer_reference
```

Redact OTPs, passwords, payment-card numbers, government IDs, phone numbers, and unnecessary personal data before creating training copies.

### Dataset manifest

Every run must record dataset version, source IDs, download timestamps, licenses, row counts, cleaning actions, label mapping, deduplication method, feature version, split strategy, random seed, code commit, model configuration, and metrics.

## 4. Canonical Record

Normalize every source before feature extraction:

```json
{
  "sample_id": "stable-id",
  "source": "kaggle|uci|phishtank|tranco|nexus_officer",
  "source_record_id": "provider-id",
  "observed_at": "2026-08-14T00:00:00Z",
  "channel": "WEB|WHATSAPP|SMS|EMAIL",
  "text": "redacted message text",
  "urls": ["https://example.test/login"],
  "label_fraud": 0,
  "fraud_categories": [],
  "label_confidence": 1.0,
  "domain_group": "example.test",
  "campaign_group": "campaign-hash",
  "label_provenance": "officer|feed|manual|weak"
}
```

Never split duplicate text, duplicate URLs, the same domain, or the same campaign across train and test.

## 5. Feature Engineering

Feature extraction must be reusable, versioned, and covered by test fixtures. Store the feature values needed to reproduce explanations.

### Message and social-engineering features

```text
message_length, word_count, sentence_count, url_count
domain_count, phone_count, email_count, digit_count
uppercase_ratio, special_character_ratio, emoji_count
urgency_terms, threat_terms, secrecy_terms, authority_claim_terms
reward_terms, suspension_terms, verification_terms, channel_switch_terms
```

### Sensitive-data and financial requests

```text
asks_for_otp, asks_for_password, asks_for_pin
asks_for_card_data, asks_for_bank_data, asks_for_identity_document
asks_for_payment, asks_to_install_app, asks_to_open_attachment
```

Never store the secret value that was requested. Store only the boolean or signal code.

### URL and domain features

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

Context features must be available at inference time. Never leak the final officer decision into the model input.

## 6. Labels and Cleaning

Use this controlled label hierarchy:

```text
fraud: 0/1
category: one or more controlled category codes
risk: low/medium/high/critical
action: safe/monitor/block/escalate
```

Prefer labels in this order: officer-adjudicated, confirmed threat-intelligence, two-reviewer manual, single-reviewer manual, weak external label. Weak labels may establish a baseline but should be down-weighted or excluded from the final test set.

Cleaning steps:

1. Normalize Unicode and whitespace.
2. Canonicalize URLs while preserving originals separately.
3. Remove exact duplicate rows.
4. Deduplicate normalized text and domains.
5. Detect near-duplicate campaigns.
6. Validate labels, timestamps, and provenance.
7. Redact sensitive data in training exports.
8. Record every removal in the dataset report.

The main leakage risks are shared domains, repeated phishing templates, post-event threat intelligence, and features derived from labels.

## 7. Splitting Strategy

Use a time-aware grouped split:

```text
Train: 70%
Validation: 15%
Test: 15%
```

Test data should be later than training data where possible. Domains and campaign groups must not cross splits. Freeze the final test set. Maintain a stress set containing new templates, short URLs, multilingual text, lookalike domains, and obfuscated messages.

Do not report a random row split as the only result because it commonly overstates phishing performance.

## 8. XGBoost Baseline

Start with this binary baseline after the feature pipeline is correct:

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

For imbalance, calculate the class ratio from the training split and consider `scale_pos_weight`. Use early stopping on validation data. Save feature list, preprocessing settings, library versions, seed, and parameters with the artifact.

## 9. Evaluation and Calibration

Report PR-AUC, ROC-AUC, precision at the review threshold, recall at the high-risk threshold, false-positive rate, false-negative rate, F1 as a secondary metric, Brier score, calibration curves, confusion matrix, latency, and failure rate.

Slice results by channel, language, URL presence, domain age, fraud category, message length, and source. Optimize for missed-fraud cost and officer workload rather than accuracy alone.

Calibrate raw tree probabilities using Platt scaling or isotonic calibration on validation data only. Evaluate calibration on the frozen test set.

Initial policy:

```text
LOW       -> low probability and no hard rule
MEDIUM    -> suspicious evidence; warn and monitor
HIGH      -> strong evidence; warn and create officer case
CRITICAL  -> hard evidence or very high probability; urgent review
```

Hard deterministic rules may raise a risk level. The model must not lower a level imposed by a critical rule. Store deterministic score, raw probability, calibrated probability, and final policy result separately.

## 10. Explainability and Registry

Persist model contributions and rule evidence separately:

```json
{
  "modelVersion": "message-xgb-2026-08-001",
  "featureVersion": "features-2026-08-001",
  "topFeatures": [
    {"name": "asks_for_otp", "value": 1, "contribution": 0.82}
  ],
  "ruleEvidence": [
    {"code": "OTP_REQUEST", "severity": "high"}
  ]
}
```

SHAP shows model contribution; it is not proof of fraud. Every artifact needs model version, feature version, rule version, dataset version, code commit, library versions, metrics, calibration artifact, threshold policy, input schema, rollback predecessor, and approval status.

Suggested layout:

```text
artifacts/message-fraud/2026-08-001/
  model.json, calibration.json, manifest.json
  metrics.json, feature_schema.json
artifacts/url-risk/2026-08-001/
  ...
```

## 11. Inference Contract

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

```json
{
  "requestId": "analysis-id",
  "modelVersion": "message-fraud-2026-08-001",
  "rawProbability": 0.91,
  "calibratedProbability": 0.87,
  "predictedCategories": ["credential_phishing"],
  "topFeatures": [],
  "status": "SUCCESS",
  "failureCode": null
}
```

Model-service failure must not erase deterministic analysis. Return a controlled `UNAVAILABLE` status and apply the safe fallback policy.

## 12. NEXUS Integration

The stored result should retain or add:

```text
rawProbability, calibratedProbability, deterministicScore
modelVersion, featureVersion, ruleVersion
predictionStatus, inferenceLatencyMs, modelFailureCode
explanationVersion
```

The final score is a documented policy combination of deterministic evidence, calibrated probability, URL intelligence, and hard safety rules. AI provider receives that structured result and writes a safe explanation. It must not overwrite the numeric output. n8n persists the explanation and bot reply through `/api/n8n/analysis-result`.

## 13. Training Lifecycle

1. **Inventory:** download initial URL and message sources; record licenses, timestamps, and manifests.
2. **Features:** implement versioned feature functions and tests for OTP, payment, impersonation, short links, punycode, IP hosts, and benign messages.
3. **Baselines:** train message and URL models independently; save metrics and schemas.
4. **Validation:** run grouped/time-aware splits and the stress set; inspect false positives and negatives.
5. **Calibration:** choose thresholds using officer capacity and harm costs.
6. **Explainability:** compare SHAP explanations with deterministic evidence.
7. **Shadow deployment:** compare predictions, latency, disagreement, and drift without changing user-facing decisions.
8. **Officer approval:** review representative cases and unacceptable explanations.
9. **Canary:** enable model influence for a controlled segment with rollback criteria.
10. **Feedback:** export adjudicated cases, detect drift, retrain through review, and register a new version.

## 14. Monitoring and Rollback

Monitor prediction distributions, HIGH/CRITICAL percentage, officer feedback, calibration drift, new-domain and new-template rates, missing features, enrichment failures, latency, service failures, AI provider disagreement, queue volume, and time to review.

Rollback on severe false negatives, unexpected score shifts, feature incompatibility, unacceptable latency, or corrupted explanations. Rollback selects the previous approved artifact; it does not delete the new one.

## 15. First ML Release Checklist

- Dataset provenance, license, timestamp, and labels are documented.
- Data is deduplicated and split by time, domain, and campaign.
- Feature extraction is versioned and tested.
- Message and URL models have validation, test, and stress metrics.
- Class imbalance handling is documented.
- Probabilities are calibrated.
- Thresholds map to user and officer actions.
- SHAP evidence is persisted and understandable.
- Artifacts have manifests and approval status.
- Shadow inference does not block deterministic analysis.
- NEXUS stores model, feature, and rule versions.
- AI provider explains but does not override the score.
- Officers can review disagreement cases.
- Monitoring and rollback have been tested.

## Related Documents

- `docs/dream-build.md` - product, architecture, operations, and delivery plan.
- `docs/model_information.md` - model responsibilities, feature catalog, and inference design.
- `docs/n8n/README.md` - WhatsApp automation and AI provider workflow.
