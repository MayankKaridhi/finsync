'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { transactionWebhookSchema } = require('../src/schemas/transactionWebhook');

function valid() {
  return {
    event_id: 'evt_1',
    event_type: 'payment.succeeded',
    created_at: '2026-01-15T10:30:00.000Z',
    data: {
      transaction_id: 'txn_1',
      amount: 500,
      currency: 'usd',
      status: 'succeeded',
      customer: { id: 'cus_1' },
    },
  };
}

test('accepts a well-formed payload and upper-cases currency', () => {
  const r = transactionWebhookSchema.safeParse(valid());
  assert.equal(r.success, true);
  assert.equal(r.data.data.currency, 'USD');
});

test('rejects a non-integer (float) amount', () => {
  const bad = valid();
  bad.data.amount = 19.99;
  const r = transactionWebhookSchema.safeParse(bad);
  assert.equal(r.success, false);
});

test('rejects a negative amount', () => {
  const bad = valid();
  bad.data.amount = -5;
  assert.equal(transactionWebhookSchema.safeParse(bad).success, false);
});

test('rejects an unknown event_type', () => {
  const bad = valid();
  bad.event_type = 'payment.exploded';
  assert.equal(transactionWebhookSchema.safeParse(bad).success, false);
});

test('rejects a malformed timestamp', () => {
  const bad = valid();
  bad.created_at = 'last tuesday';
  assert.equal(transactionWebhookSchema.safeParse(bad).success, false);
});

test('rejects a bad currency length', () => {
  const bad = valid();
  bad.data.currency = 'DOLLARS';
  assert.equal(transactionWebhookSchema.safeParse(bad).success, false);
});

test('rejects an invalid customer email', () => {
  const bad = valid();
  bad.data.customer.email = 'not-an-email';
  assert.equal(transactionWebhookSchema.safeParse(bad).success, false);
});
