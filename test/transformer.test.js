'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  toJournalEntry,
  minorUnitsToDecimalString,
} = require('../src/services/transformer');

/** A canonical valid, already-parsed webhook. */
function sampleWebhook(overrides = {}) {
  const { data: dataOverrides, ...topOverrides } = overrides;
  return {
    event_id: 'evt_123',
    event_type: 'payment.succeeded',
    created_at: '2026-01-15T10:30:00.000Z',
    ...topOverrides,
    data: {
      transaction_id: 'txn_abc',
      amount: 1999,
      currency: 'USD',
      status: 'succeeded',
      customer: { id: 'cus_1', email: 'a@b.com', name: 'Ada' },
      description: 'Pro plan',
      ...dataOverrides,
    },
  };
}

test('minorUnitsToDecimalString preserves precision (no float drift)', () => {
  assert.equal(minorUnitsToDecimalString(1999), '19.99');
  assert.equal(minorUnitsToDecimalString(100), '1.00');
  assert.equal(minorUnitsToDecimalString(5), '0.05');
  assert.equal(minorUnitsToDecimalString(0), '0.00');
  assert.equal(minorUnitsToDecimalString(123456), '1234.56');
});

test('maps a successful payment to a POSTED credit', () => {
  const entry = toJournalEntry(sampleWebhook(), { correlationId: 'cid_1' });
  assert.equal(entry.idempotency_key, 'evt_123');
  assert.equal(entry.correlation_id, 'cid_1');
  assert.equal(entry.entry.direction, 'CREDIT');
  assert.equal(entry.entry.status, 'POSTED');
  assert.equal(entry.entry.amount, '19.99');
  assert.equal(entry.entry.currency, 'USD');
  assert.equal(entry.counterparty.external_id, 'cus_1');
});

test('maps a refund to a REVERSED debit', () => {
  const entry = toJournalEntry(
    sampleWebhook({ event_type: 'payment.refunded', data: { status: 'refunded' } }),
    {},
  );
  assert.equal(entry.entry.direction, 'DEBIT');
  assert.equal(entry.entry.status, 'REVERSED');
});

test('falls back to a generated memo when description is absent', () => {
  const wh = sampleWebhook();
  delete wh.data.description;
  const entry = toJournalEntry(wh, {});
  assert.match(entry.entry.memo, /payment\.succeeded for txn_abc/);
});

test('is a pure function (same input -> identical output)', () => {
  const wh = sampleWebhook();
  const a = toJournalEntry(wh, { correlationId: 'x' });
  const b = toJournalEntry(wh, { correlationId: 'x' });
  assert.deepEqual(a, b);
});
