'use strict';

const crypto = require('crypto');

/**
 * Correlation-ID helpers.
 *
 * Every inbound webhook is tagged with a unique correlation ID the moment it
 * arrives. That ID is threaded through validation, transformation, the outbound
 * call, and every log line, so a single failed sync can be traced end-to-end
 * across the pipeline — the first thing anyone debugging a distributed system
 * asks for. If the caller already supplied an `X-Correlation-Id`, we honour it
 * so traces join up across service boundaries.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function resolveCorrelationId(req) {
  const incoming = req.headers['x-correlation-id'];
  if (typeof incoming === 'string' && incoming.trim().length > 0) {
    return incoming.trim();
  }
  return `fs_${crypto.randomUUID()}`;
}

module.exports = { resolveCorrelationId };
