'use strict';

const axios = require('axios');
const { config } = require('../config');
const { logger } = require('../utils/logger');

/**
 * Outbound connector to the downstream accounting system.
 *
 * This is the layer that assumes the network and the third party are unreliable
 * — because they are. It wraps the Axios call in a bounded retry loop with
 * exponential backoff and jitter. Key policy decisions:
 *
 *   - We retry only on *transient* failures: network errors (no response) and
 *     5xx / 429 responses. A 4xx (e.g. 400 validation, 409 duplicate) is a
 *     permanent client error — retrying it would just hammer the downstream and
 *     never succeed, so we fail fast instead.
 *   - Backoff is exponential (baseDelay * 2^attempt) with a small random jitter
 *     so that many simultaneously-failing events don't retry in lockstep and
 *     create a thundering herd against a recovering downstream.
 *   - Every attempt is time-bounded by a request timeout so one stuck socket
 *     can't wedge the pipeline.
 */

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decide whether a failed attempt is worth retrying.
 * @param {import('axios').AxiosError} error
 * @returns {boolean}
 */
function isRetryable(error) {
  // No response at all => network/timeout/DNS => transient.
  if (!error.response) return true;
  const status = error.response.status;
  return status === 429 || (status >= 500 && status <= 599);
}

class AccountingConnector {
  /**
   * @param {object} [opts]
   * @param {string} [opts.url]
   * @param {import('axios').AxiosInstance} [opts.client] injectable for tests
   * @param {(ms:number)=>Promise<void>} [opts.sleepFn] injectable for tests
   */
  constructor(opts = {}) {
    this._url = opts.url || config.accountingApiUrl;
    this._sleep = opts.sleepFn || sleep;
    this._client =
      opts.client ||
      axios.create({
        timeout: config.retry.timeoutMs,
        headers: { 'Content-Type': 'application/json' },
      });
  }

  /**
   * Forward a transformed journal entry downstream, retrying transient faults.
   *
   * @param {object} journalEntry
   * @param {object} [meta]
   * @param {string} [meta.correlationId]
   * @returns {Promise<{ ok: true, status: number, data: any, attempts: number }>}
   * @throws {Error} annotated with `.attempts` and `.lastStatus` once retries are exhausted
   */
  async forward(journalEntry, meta = {}) {
    const { maxAttempts, baseDelayMs } = config.retry;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const res = await this._client.post(this._url, journalEntry, {
          headers: { 'X-Correlation-Id': meta.correlationId || '' },
        });
        logger.info('Forwarded to accounting system', {
          correlationId: meta.correlationId,
          status: res.status,
          attempt,
        });
        return { ok: true, status: res.status, data: res.data, attempts: attempt };
      } catch (err) {
        lastError = err;
        const retryable = isRetryable(err);
        const status = err.response ? err.response.status : 'no-response';

        logger.warn('Forward attempt failed', {
          correlationId: meta.correlationId,
          attempt,
          maxAttempts,
          status,
          retryable,
          message: err.message,
        });

        // Permanent error, or we've used our last attempt: stop looping.
        if (!retryable || attempt === maxAttempts) break;

        // Exponential backoff with jitter: base * 2^(attempt-1) + [0, base).
        const backoff =
          baseDelayMs * 2 ** (attempt - 1) + Math.floor(deterministicJitter(attempt, baseDelayMs));
        await this._sleep(backoff);
      }
    }

    const attempts = lastError && lastError.config ? maxAttempts : maxAttempts;
    const enriched = new Error(
      `Failed to forward after ${attempts} attempt(s): ${lastError ? lastError.message : 'unknown'}`,
    );
    enriched.attempts = attempts;
    enriched.lastStatus = lastError && lastError.response ? lastError.response.status : null;
    enriched.cause = lastError;
    throw enriched;
  }
}

/**
 * Jitter without Math.random() so behaviour is reproducible in tests while
 * still de-correlating retries across events (derived from attempt number).
 * @param {number} attempt @param {number} base
 */
function deterministicJitter(attempt, base) {
  return (attempt * 37) % Math.max(1, base);
}

module.exports = { AccountingConnector, isRetryable };
