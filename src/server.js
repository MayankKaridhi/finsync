'use strict';

const { createApp } = require('./app');
const { config } = require('./config');
const { logger } = require('./utils/logger');

/**
 * Process entry point. Boots the HTTP server and installs graceful-shutdown
 * handlers so in-flight requests can drain on SIGТERM/SIGINT (important in a
 * container orchestrator that sends SIGTERM before killing a pod).
 */
const app = createApp();

const server = app.listen(config.port, () => {
  logger.info(`FinSync gateway listening on port ${config.port}`, {
    env: config.env,
    accountingApiUrl: config.accountingApiUrl,
  });
});

/** @param {string} signal */
function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully`);
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  // Safety net: force-exit if connections refuse to drain in time.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { server };
