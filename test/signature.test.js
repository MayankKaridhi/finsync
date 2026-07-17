'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Enforce signatures for this suite specifically.
process.env.ENFORCE_SIGNATURE = 'true';
process.env.WEBHOOK_SECRET = 'test_secret';
process.env.LOG_LEVEL = 'error';

const { createApp } = require('../src/app');
const { signPayload } = require('../src/middleware/verifySignature');

function boot(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function rawPost(port, path, rawBody, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawBody), ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
      },
    );
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

const payload = JSON.stringify({
  event_id: 'evt_sig_1',
  event_type: 'payment.succeeded',
  created_at: '2026-01-15T10:30:00.000Z',
  data: { transaction_id: 'txn_sig', amount: 100, currency: 'USD', status: 'succeeded', customer: { id: 'c' } },
});

test('rejects a request with no signature (401)', async () => {
  const app = createApp({ pipeline: { process: async () => ({}) } });
  const { port, close } = await boot(app);
  try {
    const res = await rawPost(port, '/api/v1/webhooks/transactions', payload, {});
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test('rejects a request with a wrong signature (401)', async () => {
  const app = createApp({ pipeline: { process: async () => ({}) } });
  const { port, close } = await boot(app);
  try {
    const res = await rawPost(port, '/api/v1/webhooks/transactions', payload, { 'X-FinSync-Signature': 'deadbeef' });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test('accepts a correctly-signed request (202)', async () => {
  const app = createApp({ pipeline: { process: async () => ({ status: 'SYNCED' }) } });
  const { port, close } = await boot(app);
  try {
    const sig = signPayload(payload, 'test_secret');
    const res = await rawPost(port, '/api/v1/webhooks/transactions', payload, { 'X-FinSync-Signature': sig });
    assert.equal(res.status, 202);
  } finally {
    await close();
  }
});
