'use strict';

const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { logger } = require('../utils/logger');

/**
 * Dead-letter store.
 *
 * When an event exhausts every retry and still cannot be delivered downstream,
 * discarding it would mean silent financial data loss — unacceptable. Instead we
 * append the full context (original payload, transformed body, failure reason)
 * to a durable dead-letter log. In production this would be a Kafka DLQ or an
 * SQS dead-letter queue; a file is the local-runnable equivalent that preserves
 * the same semantics: nothing is ever dropped, everything can be replayed.
 *
 * Each record is written as one JSON object per line (JSON Lines / NDJSON) so
 * the file can be streamed and re-processed without loading it all into memory.
 */
class DeadLetterStore {
  /** @param {string} [filePath] */
  constructor(filePath = config.deadLetterPath) {
    this._filePath = filePath;
    const dir = path.dirname(filePath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * Persist a failed event for later inspection / replay.
   *
   * @param {object} record
   * @param {string} record.correlationId
   * @param {string} record.reason        human-readable failure summary
   * @param {object} record.payload       original inbound payload
   * @param {object} [record.transformed] transformed body we tried to send
   * @param {string} record.failedAt      ISO timestamp of final failure
   * @returns {void}
   */
  write(record) {
    const line = JSON.stringify(record) + '\n';
    try {
      fs.appendFileSync(this._filePath, line);
      logger.warn('Event dead-lettered', {
        correlationId: record.correlationId,
        reason: record.reason,
      });
    } catch (err) {
      // If even the DLQ write fails we must scream loudly — this is the last
      // line of defence and a silent failure here truly loses data.
      logger.error('CRITICAL: failed to write to dead-letter store', {
        correlationId: record.correlationId,
        error: err.message,
      });
    }
  }
}

module.exports = { DeadLetterStore };
