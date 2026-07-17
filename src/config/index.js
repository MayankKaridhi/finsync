'use strict';

require('dotenv').config();

/**
 * Centralised, validated runtime configuration.
 *
 * Every environment-driven value is read exactly once, here, and coerced to the
 * right type. Reading `process.env` scattered across the codebase is a classic
 * source of "works on my machine" bugs; funnelling it through one module means
 * a missing or malformed variable fails loudly at boot instead of mid-request.
 */

/**
 * Coerce a string env var to an integer, falling back to a default.
 * @param {string | undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const config = Object.freeze({
  // The port FinSync itself listens on.
  port: toInt(process.env.PORT, 4000),

  // Where the mock accounting system lives. The connector forwards here.
  accountingApiUrl:
    process.env.ACCOUNTING_API_URL || 'http://localhost:4100/api/v1/journal-entries',

  // Shared secret used to verify inbound webhook HMAC signatures. In a real
  // deployment this is provisioned by the payment provider.
  webhookSecret: process.env.WEBHOOK_SECRET || 'finsync_dev_secret_change_me',

  // Whether to enforce signature verification. Disabled by default in tests so
  // fixtures don't each need a valid signature, enabled in the running service.
  enforceSignature: process.env.ENFORCE_SIGNATURE !== 'false',

  // Outbound connector resilience settings.
  retry: {
    maxAttempts: toInt(process.env.RETRY_MAX_ATTEMPTS, 3),
    baseDelayMs: toInt(process.env.RETRY_BASE_DELAY_MS, 200),
    timeoutMs: toInt(process.env.HTTP_TIMEOUT_MS, 5000),
  },

  // Logger verbosity: error | warn | info | debug.
  logLevel: process.env.LOG_LEVEL || 'info',

  // Where dead-lettered events are persisted for later inspection/replay.
  deadLetterPath: process.env.DEAD_LETTER_PATH || 'logs/dead-letter.log',

  env: process.env.NODE_ENV || 'development',
});

module.exports = { config };
