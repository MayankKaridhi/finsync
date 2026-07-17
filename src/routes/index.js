'use strict';

const express = require('express');
const { makeWebhookHandler } = require('../controllers/webhookController');
const { verifySignature } = require('../middleware/verifySignature');

/**
 * Route table.
 *
 * Kept in its own module so the URL surface of the service is documented in one
 * place and the app wiring stays declarative. The webhook route composes two
 * middleware in a deliberate order: signature verification runs BEFORE the
 * handler, so an unauthenticated request is rejected before we spend any effort
 * parsing or validating it.
 *
 * @param {object} [deps] forwarded to the controller factory (test injection)
 * @returns {import('express').Router}
 */
function buildRouter(deps = {}) {
  const router = express.Router();

  // Liveness/readiness probe for load balancers and uptime monitors.
  router.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'finsync', uptime: process.uptime() });
  });

  // The core webhook listener.
  router.post('/webhooks/transactions', verifySignature, makeWebhookHandler(deps));

  return router;
}

module.exports = { buildRouter };
