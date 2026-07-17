# FinSync — Automated Payment Integration Pipeline

**FinSync** is an event-driven backend microservice that acts as a secured **API middleware gateway** between a payment provider and a downstream accounting system. It receives real-time transaction **webhooks**, verifies and validates them, transforms the JSON into the accounting system's schema, and reliably forwards it — with **retry/backoff** and **dead-lettering** so no financial event is ever silently lost.

> Built as a focused, production-shaped reference for integration-engineering patterns: webhook ingestion, schema validation at the trust boundary, data transformation, resilient outbound delivery, and full observability.

---

## 🏗️ Architecture

```
                                        FINSYNC GATEWAY  (Node.js + Express)
 ┌───────────────┐  webhook POST   ┌────────────────────────────────────────────────┐
 │ Payment Source│  (signed JSON)  │  1. Helmet + correlation-id tagging              │
 │  transaction  │ ───────────────►│  2. HMAC-SHA256 signature verification  ──► 401  │
 │    alerts     │                 │  3. Zod schema validation               ──► 400  │
 └───────────────┘                 │  4. ACK fast ─────────────────────────► 202      │
                                    │        │ (process after the ACK)                 │
                                    │        ▼                                         │
                                    │  5. Transform (cents→decimal, status/dir map)    │
                                    │        ▼                                         │
                                    │  6. Connector: Axios POST                        │──► ┌──────────────┐
                                    │        ├─ retry transient 5xx/429 w/ backoff      │    │ Mock         │
                                    │        └─ on exhaustion ► dead-letter (NDJSON)    │    │ Accounting   │
                                    │  7. Structured logging (Winston) throughout      │    │ System       │
                                    └────────────────────────────────────────────────┘    └──────────────┘
```

### Design principles
1. **Acknowledge fast.** The webhook is validated and answered `202 Accepted` immediately; the transform + forward work runs after the ACK so a slow downstream never causes the provider to time out and retry-storm the gateway.
2. **Never trust the payload.** Every request is HMAC-verified and then validated against a strict Zod schema at the boundary. Malformed input is rejected with `400` and field-level detail; it never reaches the transform layer.
3. **Assume the downstream fails.** The connector retries transient faults (network errors, `5xx`, `429`) with exponential backoff + jitter, and refuses to retry permanent `4xx` errors. Anything that still fails is **dead-lettered**, never dropped.

---

## 🧰 Tech Stack

| Concern | Choice |
| --- | --- |
| Runtime | **Node.js** (v18+) |
| Web framework | **Express.js** (middleware pipeline) |
| HTTP client | **Axios** (outbound connector with retry/backoff) |
| Validation | **Zod** (declarative schema at the trust boundary) |
| Logging | **Winston** (structured JSON logs + correlation IDs) |
| Security | **Helmet** + **HMAC-SHA256** webhook signature verification |
| Config | **dotenv** |
| Testing | **`node:test`** (25 unit/HTTP tests) + a full **E2E runner** |

---

## 📁 Project Structure

```
finsync/
├── src/
│   ├── config/            # Validated env-driven configuration
│   ├── schemas/           # Zod inbound webhook schema (trust boundary)
│   ├── middleware/        # HMAC signature verify, central error handler
│   ├── services/          # transformer, connector (retry), dead-letter, pipeline
│   ├── controllers/       # webhook controller (validate → ACK → process)
│   ├── routes/            # route table (/api/v1/...)
│   ├── utils/             # logger, correlation-id
│   ├── app.js             # Express app factory (DI-friendly)
│   └── server.js          # process entry + graceful shutdown
├── mock/
│   └── accountingServer.js# runnable downstream (idempotent, failure injection)
├── test/                  # unit + HTTP tests, plus e2e.runner.js
└── package.json
```

---

## 🚀 Getting Started

```bash
npm install
cp .env.example .env

# Terminal 1 — start the mock downstream accounting system
npm run mock

# Terminal 2 — start the FinSync gateway
npm start
```

### Send a signed test webhook
Because the endpoint enforces HMAC signatures, compute one over the exact body:

```bash
SECRET="finsync_dev_secret_change_me"
BODY='{"event_id":"evt_1","event_type":"payment.succeeded","created_at":"2026-01-15T10:30:00.000Z","data":{"transaction_id":"txn_1","amount":1999,"currency":"usd","status":"succeeded","customer":{"id":"cus_1","email":"a@b.com"}}}'
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','$SECRET').update(process.argv[1]).digest('hex'))" "$BODY")

curl -X POST http://localhost:4000/api/v1/webhooks/transactions \
  -H "Content-Type: application/json" \
  -H "X-FinSync-Signature: $SIG" \
  -d "$BODY"
# → 202 { "status": "accepted", "correlationId": "fs_...", "eventId": "evt_1" }
```

Then inspect the downstream ledger:
```bash
curl http://localhost:4100/api/v1/journal-entries
```

---

## 🔄 Data Transformation

| Inbound (payment webhook) | → | Outbound (journal entry) |
| --- | --- | --- |
| `event_id` | → | `idempotency_key` (dedupes at-least-once delivery) |
| `data.amount` = `1999` (cents, int) | → | `entry.amount` = `"19.99"` (decimal string, no float drift) |
| `data.currency` = `"usd"` | → | `entry.currency` = `"USD"` (normalised) |
| `data.status` = `"succeeded"` | → | `entry.status` = `"POSTED"` (ledger vocabulary) |
| `event_type` = `payment.refunded` | → | `entry.direction` = `"DEBIT"` |
| `data.customer.*` | → | `counterparty.*` |

Money is carried as an **integer number of cents** end-to-end and only rendered to a `"19.99"` **string** at the edge — floats are never used, so no cent is ever lost to IEEE-754 rounding.

---

## 🧪 Testing

```bash
npm test     # 25 unit + HTTP tests (node:test)
npm run e2e  # boots both servers, drives a signed webhook through the full pipeline
```

The E2E run injects two `503`s into the mock so you can watch the connector's retry/backoff recover, verifies the transformed entry lands downstream, and asserts idempotency on replay.

```
E2E PASSED: full webhook → transform → retry → downstream sync verified.
```

---

## 🔐 Configuration

All configuration is environment-driven (see `.env.example`). Key values:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | Gateway listen port |
| `ACCOUNTING_API_URL` | `http://localhost:4100/...` | Downstream endpoint |
| `WEBHOOK_SECRET` | `finsync_dev_secret_change_me` | HMAC signing secret |
| `ENFORCE_SIGNATURE` | `true` | Toggle signature verification |
| `RETRY_MAX_ATTEMPTS` | `3` | Outbound retry ceiling |
| `RETRY_BASE_DELAY_MS` | `200` | Backoff base |
| `DEAD_LETTER_PATH` | `logs/dead-letter.log` | Where exhausted events land |

---

## 🛡️ Production Notes

- The gateway is stateless; scale it horizontally behind a load balancer.
- In a scaled deployment the controller would **enqueue** the event (SQS/Kafka) and a worker pool would run the `IntegrationPipeline`, turning the file-based dead-letter into a real DLQ. The pipeline code is written to that seam already.
- Provision `WEBHOOK_SECRET` from a secrets manager, never commit it.
- Correlation IDs are emitted on every log line and returned in the `X-Correlation-Id` response header for end-to-end tracing.

---

## 📜 License

MIT © Mayank Karidhi
