# NEXUS Dream Build

## 1. Vision

NEXUS is an explainable phishing and digital-fraud safety platform. A user can submit a suspicious SMS, email, URL, web message, or WhatsApp conversation. NEXUS stores the evidence as a chat-like conversation, extracts indicators, evaluates risk, explains the evidence in plain language, and lets the user escalate the complete case to an authorized officer.

The human-in-the-loop architecture is:

```text
User or WhatsApp sender
        -> conversation and evidence store
        -> feature extraction and deterministic rules
        -> XGBoost models and threat intelligence
        -> SHAP evidence and AI provider explanation
        -> safe user response and officer escalation
        -> officer investigation and audited decision
```

The officer remains the final authority for serious or ambiguous cases. AI provider explains structured evidence and drafts a safe response; it must never invent facts or silently override the numeric policy result.

## 2. Current Repository Reality

The repository currently contains the following foundation:

- Next.js App Router with TypeScript.
- Prisma ORM with MySQL 8.
- Email/password registration with SMTP OTP verification.
- HTTP-only user sessions and protected routes.
- User dashboard with search, source filters, risk filters, and summary counts.
- Chat-like conversations for portal and WhatsApp-originated messages.
- Suspicious text, link, email, and WhatsApp submission flow.
- URL extraction and persisted analysis results.
- Deterministic signal extraction and versioned rules for urgency, OTP requests, credentials, payments, impersonation, prizes, secrecy, channel switching, suspicious hosts, punycode, and IP hosts.
- Optional AI provider explanation through n8n or the direct analysis pipeline.
- Report-to-officer escalation with duplicate protection.
- Officer login, incident queue, detail view, notes, assignments, status changes, and notifications.
- Admin overview, officer directory, and audit-log browser.
- Redis rate-limit hook with an in-memory fallback.
- Importable n8n workflow for Meta WhatsApp input, NEXUS ingest, AI provider explanation, persistence, and reply.

The important boundary is that the live fraud score is currently primarily deterministic. The XGBoost training program in `model_training.md` is the next ML phase and must not be described as live until trained artifacts are evaluated, registered, and verified in shadow mode.

## 3. Product Surfaces

### User portal

The user experience should provide:

1. Registration, OTP verification, login, logout, and session expiry handling.
2. Dashboard totals for conversations, high-risk cases, reported cases, and pending analysis.
3. New analysis intake for suspicious text, URL, email content, or copied WhatsApp content.
4. Conversation detail with transcript, extracted URLs, evidence, score, confidence, risk level, safe next steps, limitations, and version identifiers.
5. Retry for failed analysis.
6. Report-to-officer with clear confirmation and duplicate-report protection.
7. Privacy guidance telling users not to submit passwords, OTPs, payment-card data, or unnecessary personal information.

### WhatsApp channel

Meta WhatsApp Cloud API is connected through n8n:

```text
Meta webhook
  -> n8n WhatsApp Trigger
  -> normalize Meta payload
  -> POST /api/n8n/whatsapp
  -> create/link conversation and run NEXUS analysis
  -> AI provider explanation in n8n
  -> POST /api/n8n/analysis-result
  -> send approved reply through WhatsApp Cloud
```

The normalized payload must retain the Meta message ID, sender phone, profile name when available, timestamp, message type, text body, and phone-number ID. The Meta message ID is the idempotency key. Credentials stay in n8n; NEXUS receives only its shared ingest secret and optional HMAC signature.

Unsupported message types receive a bounded fallback response rather than entering the text-analysis path.

### Officer portal

The officer workspace should be operational and scan-friendly:

- Queue filters for status, risk, source, assignee, and search.
- Critical/high-risk cases first, then oldest unresolved case.
- Complete transcript and extracted URL list.
- Deterministic evidence and model evidence shown separately.
- Analysis history and model, feature, and rule versions.
- Assignment, internal notes, status transitions, and reasons for terminal decisions.
- Notifications for new incidents, workflow failures, and important changes.
- Audit trail for authentication, assignments, notes, status changes, and administration.

Recommended status flow:

```text
OPEN -> IN_REVIEW -> ACTION_REQUIRED -> RESOLVED
  |         |              |
  +---------+--------------+
            -> FALSE_POSITIVE
```

Terminal transitions require an officer reason. Authorization must be enforced on the server for every mutation.

### Admin portal

Admins manage officers, revoke sessions, inspect system health, review audit logs, inspect workflow failures, and view model, feature, and rule versions.

## 4. Fraud Detection Architecture

1. **Input normalization:** preserve original evidence, normalize Unicode, extract URLs, canonicalize hosts, and identify channel/message type.
2. **Feature extraction:** calculate versioned message, URL, domain, sender, and conversation features.
3. **Deterministic rules:** detect hard evidence such as OTP/password requests, payments, urgency, impersonation, suspicious URL structure, lookalike brands, punycode, IP hosts, shortened links, secrecy, and channel switching.
4. **XGBoost models:** produce calibrated probabilities for message fraud, URL risk, fraud category, and later officer priority.
5. **Threat intelligence:** enrich with timestamped reputation, DNS/TLS, domain-age, redirect, PhishTank, and benign-domain observations.
6. **Explainability:** expose model contributions and deterministic rules as separate evidence types.
7. **AI provider:** produce a user-safe summary, limitations, next steps, and draft reply from structured evidence.
8. **Human escalation:** route HIGH/CRITICAL results, disagreement, repeated reports, and uncertain high-impact cases to officers.

## 5. Data and Security

The shared data model keeps web and WhatsApp content in the same conversation system. Core entities include users, OTPs, sessions, conversations, messages, extracted URLs, analysis jobs, analysis results, URL checks, indicators, incident reports, assignments, notes, officers, notifications, and audit logs.

Each analysis should retain status, risk level, score, confidence, deterministic score, raw and calibrated probability, evidence, safe next steps, limitations, completion time, failure code, model version, feature version, and rule version.

Minimize sensitive data. Never log access tokens, SMTP passwords, Meta credentials, raw OTPs, payment details, or unnecessary personal identifiers. Redact or hash identifiers in audit logs where possible.

Security requirements:

- Store provider credentials only in n8n credentials or server environment variables.
- Protect `/api/n8n/*` with a strong secret and optional HMAC.
- Validate all external payloads.
- Reject stale timestamps and duplicate provider message IDs.
- Rate-limit authentication, ingest, analysis, and officer actions.
- Use secure HTTP-only cookies in production.
- Enforce officer authorization server-side.
- Audit sensitive mutations.
- Use bounded retries with exponential backoff.
- Keep a deterministic result and safe fallback when AI provider or enrichment is unavailable.

## 6. Deployment

```text
Internet
  -> Cloudflare / public HTTPS
  -> Next.js NEXUS container
       -> MySQL 8
       -> Redis 7
       -> internal XGBoost model API
       -> n8n automation service
  -> Meta WhatsApp Cloud API
```

Production steps:

1. Configure the public HTTPS NEXUS URL.
2. Set MySQL, auth, SMTP, and ingest-secret environment variables.
3. Start Redis and verify connectivity.
4. Apply Prisma migrations.
5. Provision an admin officer securely.
6. Import and configure the n8n workflow.
7. Configure Meta WhatsApp Business Platform and subscribe to `messages`.
8. Test Meta -> n8n -> NEXUS -> AI provider -> WhatsApp end to end.
9. Confirm the linked sender sees the same conversation in the portal.
10. Monitor logs, failed jobs, notifications, and audit records.

The model API is an internal FastAPI service. It must be reachable only from
the NEXUS application network, require `MODEL_API_SECRET` in production, mount
approved model artifacts read-only, and expose `/healthz` and `/v1/predict`.
The application must continue to complete deterministic analysis when the model
service is unavailable.

## 7. Delivery Phases

### Phase 1: Foundation

Authentication, SMTP OTP, conversation storage, submission form, dashboard, deterministic analysis, and reporting.

### Phase 2: Operations

Officer authentication, case queue, investigation workspace, notes, assignment, notifications, audit logging, rate limiting, and secure deployment.

### Phase 3: WhatsApp automation

Meta setup, n8n credentials, normalized webhook, idempotent ingest, safe reply, failure alerts, and portal visibility.

### Phase 4: ML training

Dataset collection, feature engineering, XGBoost baselines, time-aware evaluation, calibration, SHAP artifacts, model registry, and shadow inference.

### Phase 5: Production intelligence

Fresh threat feeds, drift monitoring, officer feedback labels, active learning, retraining approval, canary releases, and rollback.

## 8. Definition of Done

- A verified user can submit evidence and see a persistent conversation.
- WhatsApp messages flow through n8n into NEXUS and receive a safe reply.
- Replay cannot duplicate messages or incidents.
- URL, message, deterministic, and model evidence are versioned and persisted.
- High-risk cases enter the officer queue automatically.
- Officers can investigate, assign, add notes, resolve, and audit cases.
- Models are evaluated on time-separated and campaign-separated data.
- AI provider failure never blocks deterministic analysis.
- Secrets are absent from source control and logs.
- Build, tests, migrations, health checks, and rollback procedures are verified.

## Related Documents

- `docs/model_training.md` - dataset, features, training, evaluation, and deployment runbook.
- `docs/model_information.md` - model suite and inference design.
- `docs/n8n/README.md` - WhatsApp and n8n configuration.
- `docs/n8n/nexus-fraud-whatsapp-ai.json` - importable workflow.
- `README.md` - current setup, API surface, and deployment notes.
