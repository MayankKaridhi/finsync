'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Disable signature enforcement for these HTTP-shape tests (signature logic is
// covered separately). Must be set before requiring the app/config.
process.env.ENFORCE_SIGNATURE = 'false';
process.env.LOG_LEVEL = 'error';

const { createApp } = require('../src/app');

/** Boot the app on an ephemeral port and return { url, close }. */
function boot(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** Minimal JSON POST helper over the http module (no test deps). */
function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function validWebhook() {
  return {
    event_id: 'evt_http_1',
    event_type: 'payment.succeeded',
    created_at: '2026-01-15T10:30:00.000Z',
    data: {
      transaction_id: 'txn_http_1',
      amount: 4200,
      currency: 'eur',
      status: 'succeeded',
      customer: { id: 'cus_http_1', email: 'x@y.com' },
    },
  };
}

test('202 Accepted for a valid webhook, and pipeline is invoked', async () => {
  const processed = [];
  const fakePipeline = { process: async (wh, meta) => { processed.push({ wh, meta }); return { status: 'SYNCED', correlationId: meta.correlationId }; } };
  const app = createApp({ pipeline: fakePipeline });
  const { url, close } = await boot(app);
  try {
    const res = await post(`${url}/api/v1/webhooks/transactions`, validWebhook());
    assert.equal(res.status, 202);
    assert.equal(res.body.status, 'accepted');
    assert.ok(res.body.correlationId);
    // Give the after-ACK processing a tick to run.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(processed.length, 1);
    assert.equal(processed[0].wh.data.currency, 'EUR', 'schema transform applied before pipeline');
  } finally {
    await close();
  }
});

test('400 for a malformed payload, with field-level issues', async () => {
  const app = createApp({ pipeline: { process: async () => ({}) } });
  const { url, close } = await boot(app);
  try {
    const bad = validWebhook();
    bad.data.amount = 12.34; // float => invalid
    const res = await post(`${url}/api/v1/webhooks/transactions`, bad);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Payload validation failed');
    assert.ok(Array.isArray(res.body.issues) && res.body.issues.length > 0);
  } finally {
    await close();
  }
});

test('health endpoint returns ok', async () => {
  const app = createApp({ pipeline: { process: async () => ({}) } });
  const { url, close } = await boot(app);
  try {
    const res = await new Promise((resolve, reject) => {
      http.get(`${url}/api/v1/health`, (r) => {
        let raw = '';
        r.on('data', (c) => (raw += c));
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(raw) }));
      }).on('error', reject);
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  } finally {
    await close();
  }
});
