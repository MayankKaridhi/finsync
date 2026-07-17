'use strict';

/**
 * End-to-end smoke test driven as a standalone script (`npm run e2e`).
 *
 * Boots the REAL mock accounting server and the REAL FinSync app in-process,
 * then fires a correctly-signed webhook through the entire pipeline and asserts
 * that a journal entry actually lands in the downstream ledger. This is the
 * "does the whole thing actually work together" check, distinct from the unit
 * tests which isolate each layer.
 *
 * It also exercises the retry path by pre-failing the mock N times.
 */

const http = require('node:http');
const crypto = require('node:crypto');

const SECRET = 'e2e_secret';
process.env.WEBHOOK_SECRET = SECRET;
process.env.ENFORCE_SIGNATURE = 'true';
process.env.LOG_LEVEL = 'error';
process.env.RETRY_BASE_DELAY_MS = '20';
process.env.ACCOUNTING_API_URL = 'http://127.0.0.1:4199/api/v1/journal-entries';

const { app: mockApp } = require('../mock/accountingServer');
const { createApp } = require('../src/app');

function listen(app, port) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => resolve(server));
  });
}

function request(method, port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sign(raw) {
  return crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

async function main() {
  // Force the mock to fail the first 2 calls so we can watch retry recover.
  process.env.FAIL_TIMES = '2';
  const mockServer = await listen(mockApp, 4199);
  const finsync = await listen(createApp(), 4200);

  try {
    console.log('E2E: signed webhook through the full pipeline (with 2 injected 503s)');

    const payload = {
      event_id: 'evt_e2e_1',
      event_type: 'payment.succeeded',
      created_at: '2026-01-15T10:30:00.000Z',
      data: {
        transaction_id: 'txn_e2e_1',
        amount: 1999,
        currency: 'usd',
        status: 'succeeded',
        customer: { id: 'cus_e2e', email: 'e2e@example.com', name: 'E2E' },
        description: 'E2E test charge',
      },
    };
    const raw = JSON.stringify(payload);

    const ack = await request('POST', 4200, '/api/v1/webhooks/transactions', payload, {
      'X-FinSync-Signature': sign(raw),
    });
    assert(ack.status === 202, `gateway acknowledged with 202 (got ${ack.status})`);
    assert(!!ack.body.correlationId, 'response carried a correlation id');

    // Let the after-ACK pipeline (with 2 retries + backoff) finish.
    await sleep(500);

    const ledger = await request('GET', 4199, '/api/v1/journal-entries');
    assert(ledger.body.count === 1, `exactly one journal entry landed downstream (got ${ledger.body.count})`);
    const entry = ledger.body.entries[0];
    assert(entry.idempotency_key === 'evt_e2e_1', 'idempotency key preserved end-to-end');
    assert(entry.entry.amount === '19.99', `amount transformed cents->decimal correctly (got ${entry.entry.amount})`);
    assert(entry.entry.currency === 'USD', 'currency normalised to upper-case');
    assert(entry.entry.direction === 'CREDIT', 'succeeded payment mapped to CREDIT');
    assert(entry.entry.status === 'POSTED', 'status mapped to POSTED');

    // Idempotency: replay the same event, ledger count must NOT grow.
    const replay = await request('POST', 4200, '/api/v1/webhooks/transactions', payload, {
      'X-FinSync-Signature': sign(raw),
    });
    assert(replay.status === 202, 'replay acknowledged');
    await sleep(200);
    const ledger2 = await request('GET', 4199, '/api/v1/journal-entries');
    assert(ledger2.body.count === 1, 'duplicate event did not create a second entry (idempotent)');

    // Bad payload -> 400, nothing forwarded.
    const bad = await request('POST', 4200, '/api/v1/webhooks/transactions', { event_id: 'x' }, {
      'X-FinSync-Signature': sign(JSON.stringify({ event_id: 'x' })),
    });
    assert(bad.status === 400, `malformed payload rejected with 400 (got ${bad.status})`);
  } finally {
    mockServer.close();
    finsync.close();
  }

  if (failures > 0) {
    console.error(`\nE2E FAILED: ${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log('\nE2E PASSED: full webhook → transform → retry → downstream sync verified.');
  process.exit(0);
}

main().catch((err) => {
  console.error('E2E crashed:', err);
  process.exit(1);
});
