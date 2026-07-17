'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { AccountingConnector, isRetryable } = require('../src/services/connector');

/** Build a fake Axios-like client whose .post is scripted per call. */
function fakeClient(responses) {
  let i = 0;
  return {
    calls: 0,
    async post() {
      this.calls += 1;
      const step = responses[Math.min(i, responses.length - 1)];
      i += 1;
      if (step.throw) throw step.throw;
      return step;
    },
  };
}

/** An axios-style error with an optional HTTP response. */
function axiosError(message, status) {
  const e = new Error(message);
  if (status !== undefined) e.response = { status };
  return e;
}

const noSleep = async () => {};

test('isRetryable: network errors and 5xx/429 are retryable, 4xx is not', () => {
  assert.equal(isRetryable(axiosError('ECONNRESET')), true);
  assert.equal(isRetryable(axiosError('boom', 503)), true);
  assert.equal(isRetryable(axiosError('rate', 429)), true);
  assert.equal(isRetryable(axiosError('bad', 400)), false);
  assert.equal(isRetryable(axiosError('dup', 409)), false);
});

test('succeeds on first attempt', async () => {
  const client = fakeClient([{ status: 201, data: { id: 'je_1' } }]);
  const connector = new AccountingConnector({ client, sleepFn: noSleep });
  const res = await connector.forward({ ok: true }, { correlationId: 'c1' });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 1);
  assert.equal(client.calls, 1);
});

test('retries a transient 503 and then succeeds', async () => {
  const client = fakeClient([
    { throw: axiosError('unavailable', 503) },
    { throw: axiosError('unavailable', 503) },
    { status: 201, data: { id: 'je_2' } },
  ]);
  const connector = new AccountingConnector({ client, sleepFn: noSleep });
  const res = await connector.forward({ ok: true }, { correlationId: 'c2' });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 3);
  assert.equal(client.calls, 3);
});

test('does NOT retry a permanent 400', async () => {
  const client = fakeClient([{ throw: axiosError('bad request', 400) }]);
  const connector = new AccountingConnector({ client, sleepFn: noSleep });
  await assert.rejects(() => connector.forward({}, { correlationId: 'c3' }), (err) => {
    assert.equal(err.lastStatus, 400);
    return true;
  });
  assert.equal(client.calls, 1, 'permanent error must not be retried');
});

test('gives up after max attempts on persistent failure', async () => {
  const client = fakeClient([{ throw: axiosError('down', 503) }]);
  const connector = new AccountingConnector({ client, sleepFn: noSleep });
  await assert.rejects(() => connector.forward({}, { correlationId: 'c4' }), (err) => {
    assert.equal(err.attempts, 3);
    assert.equal(err.lastStatus, 503);
    return true;
  });
  assert.equal(client.calls, 3);
});
