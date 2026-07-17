'use strict';

const { logger } = require('../utils/logger');

/**
 * A domain error that carries an HTTP status code, so service-layer code can
 * throw meaningfully and the central handler can translate it into a response
 * without leaking stack traces to the client.
 */
class AppError extends Error {
  /** @param {string} message @param {number} [statusCode=500] @param {object} [details] */
  constructor(message, statusCode = 500, details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

/**
 * Terminal Express error-handling middleware (must have arity 4).
 *
 * Centralising error handling keeps every route free of repetitive try/catch
 * response plumbing and guarantees a single, consistent error envelope. We log
 * the full error server-side (with the correlation ID) but return only a safe,
 * client-appropriate message.
 *
 * @type {import('express').ErrorRequestHandler}
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const statusCode = err instanceof AppError ? err.statusCode : 500;
  const correlationId = req.correlationId;

  logger.error('Request failed', {
    correlationId,
    statusCode,
    message: err.message,
    stack: err.stack,
    details: err.details,
  });

  res.status(statusCode).json({
    error: statusCode >= 500 ? 'Internal Server Error' : err.message,
    correlationId,
  });
}

module.exports = { AppError, errorHandler };
