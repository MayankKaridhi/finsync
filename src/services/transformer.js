'use strict';

/**
 * Data-transformation layer.
 *
 * Maps a validated inbound payment webhook into the target accounting system's
 * "journal entry" schema. This is the heart of an integration service: two
 * systems that were never designed to talk to each other are reconciled here,
 * field by field.
 *
 * The function is intentionally *pure* — same input always yields the same
 * output, no I/O, no clock reads beyond the derived timestamp passed in. Pure
 * transforms are trivially unit-testable and free of hidden side effects, which
 * is exactly why the mapping logic lives in its own module rather than inline in
 * the controller.
 */

/**
 * Map the provider's transaction status to the accounting system's ledger
 * vocabulary. Keeping this as an explicit table (not a string passthrough)
 * means an unexpected upstream status can't silently corrupt the ledger.
 * @type {Record<string, string>}
 */
const STATUS_TO_LEDGER = Object.freeze({
  succeeded: 'POSTED',
  refunded: 'REVERSED',
  failed: 'VOID',
  pending: 'DRAFT',
});

/**
 * Map an event type to a double-entry accounting direction. A successful
 * payment is a CREDIT to revenue; a refund is a DEBIT (money going back out).
 * @type {Record<string, 'CREDIT' | 'DEBIT'>}
 */
const EVENT_TO_DIRECTION = Object.freeze({
  'payment.succeeded': 'CREDIT',
  'payment.refunded': 'DEBIT',
  'payment.failed': 'CREDIT', // recorded as a voided credit for audit trail
});

/**
 * Convert an integer amount in minor units (cents) to a fixed-2 decimal string.
 * We return a STRING, not a float, so no precision is lost between here and the
 * accounting system's decimal/BigInt column. "$19.99" must never become 19.99000001.
 *
 * @param {number} minorUnits e.g. 1999
 * @returns {string} e.g. "19.99"
 */
function minorUnitsToDecimalString(minorUnits) {
  const sign = minorUnits < 0 ? '-' : '';
  const abs = Math.abs(minorUnits);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${frac}`;
}

/**
 * Transform a validated webhook into a target journal entry.
 *
 * @param {import('../schemas/transactionWebhook').TransactionWebhook} webhook
 * @param {object} [meta]
 * @param {string} [meta.correlationId]
 * @returns {object} the accounting-system-shaped journal entry
 */
function toJournalEntry(webhook, meta = {}) {
  const { event_id, event_type, created_at, data } = webhook;

  return {
    // Idempotency key: the accounting system uses this to reject duplicates if
    // the same webhook is delivered twice (webhooks are at-least-once).
    idempotency_key: event_id,
    source_system: 'finsync',
    correlation_id: meta.correlationId || null,

    entry: {
      reference: data.transaction_id,
      direction: EVENT_TO_DIRECTION[event_type] || 'CREDIT',
      status: STATUS_TO_LEDGER[data.status] || 'DRAFT',
      amount: minorUnitsToDecimalString(data.amount),
      currency: data.currency, // already upper-cased by the schema
      memo: data.description || `${event_type} for ${data.transaction_id}`,
      occurred_at: created_at,
    },

    counterparty: {
      external_id: data.customer.id,
      email: data.customer.email || null,
      display_name: data.customer.name || null,
    },
  };
}

module.exports = {
  toJournalEntry,
  minorUnitsToDecimalString,
  STATUS_TO_LEDGER,
  EVENT_TO_DIRECTION,
};
