'use strict';

const crypto = require('crypto');
const { config } = require('../config');
const { logger } = require('../utils/logger');

/**
 * HMAC-SHA256 webhook signature verification.
 *
 * A public webhook endpoint is, by definition, reachable by anyone on the
 * internet. Without authentication, an attacker could POST forged "payment
 * succeeded" events and poison the downstream accounting system. Payment
 * providers therefore sign each request with a shared secret; we recompute the
 * signature over the *raw* request body and compare.
 *
 * Two details that matter:
 *   1. We hash the RAW bytes, not the parsed object — re-serialising JSON can
 *      reorder keys and change whitespace, breaking the comparison. The raw body
 *      is captured by a `verify` hook on the JSON body parser (see app.js).
 *   2. Comparison uses `crypto.timingSafeEqual` to avoid a timing side-channel
 *      that a naive `===` would leak.
 *
 * @type {import('express').RequestHandler}
 */
function verifySignature(req, res, next) {
  if (!config.enforceSignature) return next();

  const provided = req.headers['x-finsync-signature'];
  const raw = req.rawBody;

  if (!provided || typeof provided !== 'string') {
    logger.warn('Rejected webhook: missing signature header', {
      correlationId: req.correlationId,
    });
    return res.status(401).json({ error: 'Missing X-FinSync-Signature header' });
  }

  if (!raw || raw.length === 0) {
    return res.status(400).json({ error: 'Empty request body' });
  }

  const expected = crypto
    .createHmac('sha256', config.webhookSecret)
    .update(raw)
    .digest('hex');

  // timingSafeEqual throws if buffers differ in length, so guard first.
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!valid) {
    logger.warn('Rejected webhook: invalid signature', {
      correlationId: req.correlationId,
    });
    return res.status(401).json({ error: 'Invalid signature' });
  }

  return next();
}

/**
 * Helper (exported for tooling/tests) that produces a valid signature for a
 * given raw body — the same computation a legitimate sender would perform.
 * @param {string} rawBody
 * @param {string} [secret]
 * @returns {string} hex-encoded HMAC-SHA256
 */
function signPayload(rawBody, secret = config.webhookSecret) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

module.exports = { verifySignature, signPayload };
