'use strict';

const { z } = require('zod');

/**
 * Inbound transaction-webhook schema.
 *
 * This is the trust boundary of the whole service: nothing downstream is
 * allowed to assume anything the schema does not guarantee. We model the shape a
 * payment provider (Stripe-style) would send for a transaction event.
 *
 * Design choices worth defending in an interview:
 *   - `amount` is an integer in the smallest currency unit (cents). This mirrors
 *     how real payment APIs represent money — floats are forbidden because
 *     0.1 + 0.2 !== 0.3 in IEEE-754 and you must never lose a cent.
 *   - `currency` is normalised to upper-case so "usd" and "USD" collapse.
 *   - Unknown top-level keys are stripped (Zod's default) so a malicious or
 *     sloppy sender cannot smuggle extra fields into the transform layer.
 */
const transactionWebhookSchema = z.object({
  event_id: z.string().min(1, 'event_id is required'),
  event_type: z.enum(['payment.succeeded', 'payment.failed', 'payment.refunded']),
  created_at: z
    .string()
    .datetime({ message: 'created_at must be an ISO-8601 timestamp' }),
  data: z.object({
    transaction_id: z.string().min(1),
    amount: z
      .number()
      .int('amount must be an integer number of cents')
      .nonnegative('amount cannot be negative'),
    currency: z
      .string()
      .length(3, 'currency must be a 3-letter ISO code')
      .transform((c) => c.toUpperCase()),
    status: z.enum(['succeeded', 'failed', 'refunded', 'pending']),
    customer: z.object({
      id: z.string().min(1),
      email: z.string().email().optional(),
      name: z.string().optional(),
    }),
    description: z.string().optional(),
  }),
});

/**
 * @typedef {z.infer<typeof transactionWebhookSchema>} TransactionWebhook
 */

module.exports = { transactionWebhookSchema };
