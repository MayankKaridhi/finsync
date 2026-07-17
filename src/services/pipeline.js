'use strict';

const { toJournalEntry } = require('./transformer');
const { AccountingConnector } = require('./connector');
const { DeadLetterStore } = require('./deadLetter');
const { logger } = require('../utils/logger');

/**
 * The processing pipeline: transform -> forward -> (dead-letter on failure).
 *
 * This orchestrator is deliberately separated from the HTTP controller. The
 * controller's job ends once it has acknowledged the webhook; the actual work of
 * syncing the event runs here, "after the ACK". Keeping it in its own class also
 * means the pipeline can be unit-tested with injected fakes (connector, DLQ)
 * and, later, driven by a queue consumer instead of an HTTP handler with zero
 * changes to this logic.
 */
class IntegrationPipeline {
  /**
   * @param {object} [deps]
   * @param {AccountingConnector} [deps.connector]
   * @param {DeadLetterStore} [deps.deadLetter]
   */
  constructor(deps = {}) {
    this._connector = deps.connector || new AccountingConnector();
    this._deadLetter = deps.deadLetter || new DeadLetterStore();
  }

  /**
   * Process one validated webhook end-to-end.
   *
   * Returns a result object rather than throwing, because a downstream failure
   * is an expected operational outcome (it's dead-lettered), not an exception
   * the caller must handle. Only a truly unexpected bug propagates.
   *
   * @param {import('../schemas/transactionWebhook').TransactionWebhook} webhook
   * @param {object} meta
   * @param {string} meta.correlationId
   * @returns {Promise<{ status: 'SYNCED' | 'DEAD_LETTERED', correlationId: string, attempts?: number }>}
   */
  async process(webhook, meta) {
    const { correlationId } = meta;

    // 1) Transform (pure, cannot fail on valid input).
    const journalEntry = toJournalEntry(webhook, { correlationId });
    logger.debug('Transformed payload', { correlationId, idempotencyKey: journalEntry.idempotency_key });

    // 2) Forward with retry/backoff.
    try {
      const result = await this._connector.forward(journalEntry, { correlationId });
      logger.info('Event synced', { correlationId, attempts: result.attempts });
      return { status: 'SYNCED', correlationId, attempts: result.attempts };
    } catch (err) {
      // 3) Exhausted retries — never drop the event; dead-letter it.
      this._deadLetter.write({
        correlationId,
        reason: err.message,
        lastStatus: err.lastStatus || null,
        payload: webhook,
        transformed: journalEntry,
        failedAt: new Date().toISOString(),
      });
      return { status: 'DEAD_LETTERED', correlationId, attempts: err.attempts };
    }
  }
}

module.exports = { IntegrationPipeline };
