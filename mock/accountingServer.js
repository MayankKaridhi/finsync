'use strict';

/**
 * Mock downstream accounting system.
 *
 * Stands in for a real ERP/accounting API (Xero, QuickBooks, NetSuite, etc.) so
 * the entire FinSync pipeline runs end-to-end with zero external accounts or
 * secrets. It intentionally models the behaviours an integration must cope with:
 *
 *   - Idempotency: a repeated `idempotency_key` returns 200 with `duplicate:true`
 *     instead of creating a second ledger entry (webhooks are at-least-once).
 *   - Transient failure injection: set FAIL_TIMES=N to make the first N calls
 *     return 503, so you can watch FinSync's retry/backoff recover.
 *   - Validation: a missing amount/currency yields 400 (a permanent error that
 *     FinSync must NOT retry).
 */

const express = require('express');

const app = express();
app.use(express.json());

/** @type {Map<string, object>} */
const ledger = new Map();
let remainingForcedFailures = Number.parseInt(process.env.FAIL_TIMES || '0', 10);

app.post('/api/v1/journal-entries', (req, res) => {
  const correlationId = req.headers['x-correlation-id'] || null;
  const body = req.body || {};

  // Inject transient 503s to exercise the connector's retry path.
  if (remainingForcedFailures > 0) {
    remainingForcedFailures -= 1;
    return res.status(503).json({ error: 'Service temporarily unavailable (injected)' });
  }

  // Permanent validation error (must not be retried by FinSync).
  if (!body.entry || body.entry.amount === undefined || !body.entry.currency) {
    return res.status(400).json({ error: 'Invalid journal entry: amount and currency required' });
  }

  // Idempotent create.
  const key = body.idempotency_key;
  if (key && ledger.has(key)) {
    return res.status(200).json({ id: ledger.get(key).id, duplicate: true, correlationId });
  }

  const id = `je_${ledger.size + 1}`;
  ledger.set(key || id, { id, ...body });
  return res.status(201).json({ id, duplicate: false, correlationId });
});

// Introspection endpoint so tests/humans can see what was posted.
app.get('/api/v1/journal-entries', (req, res) => {
  res.json({ count: ledger.size, entries: [...ledger.values()] });
});

const port = Number.parseInt(process.env.MOCK_PORT || '4100', 10);
if (require.main === module) {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Mock accounting system listening on http://localhost:${port}`);
  });
}

module.exports = { app };
