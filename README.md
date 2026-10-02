# NEXUS Fraud Detection

Explainable AI-based phishing and digital-fraud safety platform. A person can
submit a suspicious message, link, email, or WhatsApp conversation. NEXUS
preserves the conversation, extracts indicators, evaluates fraud risk with a
deterministic rule engine (optionally explained by an AI provider), explains the
evidence, gives safe next steps, and lets the user escalate the case to an
authorized officer who investigates it in a dedicated portal.

## Feature map

**User platform**
- Email/password registration and login with HTTP-only JWT sessions
- Dashboard with summary strip (total / high-risk / reported / awaiting analysis),
  search, and source/risk filters
- New-analysis intake with privacy note and processing state
- Conversation detail with chat transcript, extracted URLs, and an evidence-led
  risk card: risk level, score, confidence, evidence with severity, recommended
  next steps, limitations, model/rule versions, and re-analysis
- Report-to-officer escalation with duplicate-report protection

**Fraud-detection engine**
- Layer 1: deterministic signal extraction (OTP/credential requests, payments,
  urgency, impersonation, prizes, channel switching, suspicious attachments,
  secrecy pressure, punctuation/caps)
- Layer 3: versioned rule engine — clamped 0-100 score → LOW/MEDIUM/HIGH/CRITICAL,
  provider-backed reputation rules, brand/host mismatch, punycode/lookalike/IP hosts
- Layer 4: optional AI explanation (OpenCode Go gateway) — explains and recommends review but
  never overrides the deterministic score; material model-rule disagreement escalates
- Layer 5: automatic escalation of HIGH/CRITICAL cases into the officer queue
- Idempotent analysis jobs keyed by provider message ID

**WhatsApp channel (via n8n)**
- `POST /api/n8n/whatsapp` ingest — shared-secret + optional HMAC auth, replay
  protection, dedupe by Meta message ID, phone-based user linking, non-text
  fallback replies
- `POST /api/n8n/analysis-result` — AI explanation + approved BOT reply
- `POST /api/n8n/officer-notification` — workflow-failure alerts to officers
- Importable workflow: `docs/n8n/nexus-fraud-whatsapp-ai.json`

**Officer + admin portal**
- `/officer/login` → case queue (filters: status/risk/source/assignee/search)
- `/officer/incidents/[id]` — investigation workspace: conversation, URLs,
  analysis card, internal notes, assignment, status workflow (terminal
  transitions require a reason)
- `/officer/notifications` — operational alert feed
- `/admin` — system overview, officer directory, audit-log browser
- Edge-safe middleware guards + server-side role checks on every mutation;
  officer sessions are revocable and DB-backed

**Security & ops**
- Rate limiting (auth 10/15 min, ingest 60/min, analysis 20/min)
- Security audit log (actor/action/target, IP hashes only — never raw secrets)
- Secret redaction helper for logs; provider secrets stay in n8n credentials
- Optional Redis URL hook for distributed limits (REDIS_URL)

## Tech Stack

- Next.js App Router (16), TypeScript
- Prisma ORM + MySQL 8
- jose JWT sessions with HTTP-only cookies, bcryptjs
- Zod validation, Nodemailer SMTP
- Vitest for unit tests
- n8n for the WhatsApp automation layer (external)

## Local Setup

```bash
npm install
cp .env.example .env   # fill DATABASE_URL, AUTH_SECRET
docker compose up -d mysql
npx prisma generate
npx prisma migrate dev
npm run dev            # http://localhost:3000
```

### Required environment variables

```text
DATABASE_URL
AUTH_SECRET
NEXT_PUBLIC_APP_NAME
WHATSAPP_INGEST_SECRET        # shared secret for POST /api/n8n/*
```

Optional: `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` (OpenCode gateway; lets the
pipeline explain results directly), `REDIS_URL`.

### XGBoost model API

The website can call the internal FastAPI model service when `MODEL_API_URL` is
configured. The service loads approved artifacts from `ml/artifacts` and exposes
`POST /v1/predict`. NEXUS stores the response under `providerResults.xgboost`
while keeping deterministic rules authoritative for the final score. If the
service is unavailable, analysis completes with deterministic evidence and marks
the model prediction unavailable.

For local model API setup, install `ml/requirements.txt`, train the message and
URL artifacts, then run:

```powershell
$env:MODEL_API_SECRET="replace-with-a-long-random-secret"
python -m uvicorn ml.service:app --host 127.0.0.1 --port 8001
```

Set `MODEL_API_URL=http://localhost:8001` and the same secret in the NEXUS
`.env`. The Docker Compose stack builds the model API automatically and mounts
`ml/artifacts` read-only.

### Seeding an officer account

Officers are provisioned, not self-registered:

```bash
OFFICER_EMAIL=officer@nexus.local OFFICER_PASSWORD='a-strong-password' \
OFFICER_NAME="Aarav Sharma" OFFICER_ROLE=ADMIN npm run seed:officer
```

The authority account is seeded without storing its password in Git:

```bash
AUTHORITY_PASSWORD='your-authority-password' npm run seed:authority
```

## Tests

```bash
npm test          # unit tests: rule engine, signal extraction, phone normalization
npm run typecheck
npm run lint
```

## WhatsApp / n8n setup

See `docs/n8n/README.md`. Key contract for the normalized payload:

```json
{
  "event": "message",
  "from": { "phone": "919876543210", "name": "Rishit" },
  "message": {
    "id": "wamid.HBg...",
    "type": "text",
    "text": { "body": "..." },
    "timestamp": "1720000000"
  },
  "phoneNumberId": "1234567890"
}
```

## Deployment (Docker + Cloudflare tunnel)

The production stack runs the app in Docker behind a Cloudflare tunnel:

- **MySQL**: external `mysql-server` container (mysql:8.0) on host port 3306 —
  holds the live data and is not managed by this compose file.
- **Redis**: `nexus-redis` (redis:7-alpine) on host port 6381; the app's rate
  limiters use it via `REDIS_URL` and fall back to in-memory when unavailable.
- **App**: `nexus-app` — multi-stage Docker build (Next.js standalone output),
  runs `prisma migrate deploy` on start, listens on port 3002.

```bash
docker compose up -d --build     # redis + app
docker compose logs -f app
```

The public URL `https://nexus.rishitcodes.in` is served by the `nexus`
Cloudflare tunnel (`~/.cloudflared/nexus.yml`, pm2 process `nexus-tunnel`)
routing to `http://127.0.0.1:3002`.

### Prisma/MySQL notes

- The `nexus` DB user has full privileges (including `CREATE` for Prisma's
  shadow database), so `npx prisma migrate dev` works on the host.
- Containers run `npx prisma migrate deploy` at startup — no shadow database
  is needed for that, and it keeps the DB in sync automatically.
- Migration history was reconciled with the live database
  (`20260808000200_unique_platform_message_id` reconstructed + checksums
  fixed) — `prisma migrate status` reports "Database schema is up to date!".

## API surface (summary)

- User: `/api/auth/register`, `/api/auth/login`, `/api/auth/logout`,
  `/api/auth/me`, `/api/conversations`, `/api/conversations/:id`,
  `/api/conversations/:id/messages`, `/api/conversations/:id/report`
- Analysis: `/api/analysis` (POST), `/api/analysis/:id`, `/api/analysis/:id/retry`
- Officer: `/api/officer/auth/login|logout`, `/api/officer/me`,
  `/api/officer/incidents` (+ `/:id`, `/assign`, `/status`, `/notes`),
  `/api/officer/notifications`, `/api/officer/audit-log` (admin),
  `/api/officer/officers`
- Admin: `/api/admin/overview`
- Automation (shared secret): `/api/n8n/whatsapp` (GET/POST),
  `/api/n8n/analysis-result`, `/api/n8n/officer-notification`

## Definition of done

- Verified user can register, log in, and submit suspicious content.
- WhatsApp messages flow Meta → n8n → NEXUS without provider secrets in NEXUS.
- The same conversation is visible in the portal when the phone is linked.
- Deterministic rules (and the AI provider when configured) produce a numeric score,
  risk level, evidence, confidence, and limitations — all persisted.
- HIGH/CRITICAL cases enter the officer queue automatically.
- Officers can authenticate, investigate, add notes, assign, and resolve cases.
- Replayed provider messages never duplicate conversations or reports.
- Sensitive actions are authorized and audit-logged.
