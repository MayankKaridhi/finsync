'use strict';

const express = require('express');
const helmet = require('helmet');
const { buildRouter } = require('./routes');
const { errorHandler } = require('./middleware/errorHandler');
const { resolveCorrelationId } = require('./utils/correlation');

/**
 * Build the Express application.
 *
 * Factored out from server start-up so tests can obtain a fully-wired app and
 * drive it in-process (via Supertest / fetch) without binding a real port.
 *
 * Middleware order is significant and deliberate:
 *   1. helmet()          — security headers first, on every response.
 *   2. correlation tag   — assign an ID before anything logs.
 *   3. json() w/ verify  — parse the body AND capture the raw bytes so the
 *                          signature middleware can HMAC exactly what was sent.
 *   4. routes            — business logic.
 *   5. errorHandler      — terminal, arity-4 handler catches everything above.
 *
 * @param {object} [deps] forwarded to the router (dependency injection for tests)
 * @returns {import('express').Express}
 */
function createApp(deps = {}) {
  const app = express();

  app.use(helmet());

  // Tag every request with a correlation ID as early as possible.
  app.use((req, res, next) => {
    req.correlationId = resolveCorrelationId(req);
    res.setHeader('X-Correlation-Id', req.correlationId);
    next();
  });

  // Parse JSON, and stash the raw body for HMAC verification. Re-serialising a
  // parsed object would change bytes and break signature comparison, so we must
  // hash the original buffer captured here.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        req.rawBody = buf && buf.length ? buf.toString('utf8') : '';
      },
    }),
  );

  app.use('/api/v1', buildRouter(deps));

  // 404 fallback for unknown routes.
  app.use((req, res) => {
    res.status(404).json({ error: 'Not Found', path: req.originalUrl });
  });

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
