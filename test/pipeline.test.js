'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { IntegrationPipeline } = require('../src/services/pipeline');

function sampleWebhook() {
  return {
    event_id: 'evt_p1',
    event_type: 'payment.succeeded',
    created_at: '2026-01-15T10:30:00.000Z',
    data: {
      transaction_id: 'txn_p1',
      amount: 2500,
      currency: 'USD',
      status: 'succeeded',
      customer: { id: 'cus_p1' },
    },
  };
}

test('marks an event SYNCED when the connector succeeds', async () => {
  const fakeConnector = {
    forward: async () => ({ ok: true, status: 201, data: {}, attempts: 1 }),
  };
  const captured = [];
  const fakeDlq = { write: (r) => captured.push(r) };

  const pipeline = new IntegrationPipeline({ connector: fakeConnector, deadLetter: fakeDlq });
  const result = await pipeline.process(sampleWebhook(), { correlationId: 'cid_p1' });

  assert.equal(result.status, 'SYNCED');
  assert.equal(captured.length, 0, 'nothing should be dead-lettered on success');
});

test('dead-letters an event when the connector exhausts retries', async () => {
  const err = new Error('permanently down');
  err.attempts = 3;
  err.lastStatus = 503;
  const fakeConnector = {
    forward: async () => {
      throw err;
    },
  };
  const captured = [];
  const fakeDlq = { write: (r) => captured.push(r) };

  const pipeline = new IntegrationPipeline({ connector: fakeConnector, deadLetter: fakeDlq });
  const result = await pipeline.process(sampleWebhook(), { correlationId: 'cid_p2' });

  assert.equal(result.status, 'DEAD_LETTERED');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].correlationId, 'cid_p2');
  assert.equal(captured[0].lastStatus, 503);
  // The DLQ record must retain BOTH the original payload and the transformed body
  // so the event can be replayed later.
  assert.equal(captured[0].payload.event_id, 'evt_p1');
  assert.equal(captured[0].transformed.idempotency_key, 'evt_p1');
});
