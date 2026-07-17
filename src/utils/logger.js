'use strict';

const winston = require('winston');
const { config } = require('../config');

/**
 * Structured, levelled application logger.
 *
 * Logs are emitted as JSON so that a log aggregator (CloudWatch, Datadog, Loki)
 * can index fields like `correlationId` and `event` without brittle regex
 * parsing. In development we also print a colourised, human-readable line to the
 * console. A dedicated `error` file keeps failures easy to grep in a pinch.
 */
const logger = winston.createLogger({
  level: config.logLevel,
  defaultMeta: { service: 'finsync' },
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

// Human-friendly console output outside of production.
if (config.env !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          const rest = Object.keys(meta).filter((k) => k !== 'service');
          const tail = rest.length ? ` ${JSON.stringify(pick(meta, rest))}` : '';
          return `${timestamp} ${level}: ${message}${tail}`;
        }),
      ),
    }),
  );
}

/** @param {object} obj @param {string[]} keys */
function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

module.exports = { logger };
