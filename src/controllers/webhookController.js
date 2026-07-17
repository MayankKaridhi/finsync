'use strict';

const { transactionWebhookSchema } = require('../schemas/transactionWebhook');
const { IntegrationPipeline } = require('../services/pipeline');
const { logger } = require('../utils/logger');

/**
 * Webhook controller.
 *
 * Responsibilities, in order:
 *   1. Validate the (already signature-verified) body against the Zod schema.
 *      A malformed payload is rejected with 400 + field-level detail and never
 *      reaches the pipeline.
 *   2. Acknowledge the event promptly with 202 Accepted. We do NOT block the
 *      HTTP response on the downstream sync — a slow accounting API must not
 *      cause the payment provider to time out and redeliver. This is the
 *      "accept fast, process after the ACK" pattern.
 *   3. Kick off pipeline processing. In this single-process reference build the
 *      processing is awaited-then-reported via logs; in a scaled deployment the
 *      controller would enqueue the event and a worker would run the pipeline.
 */

// One pipeline instance is reused across requests (its connector holds a
// keep-alive Axios client). Exposed via factory so tests can inject fakes.
const defaultPipeline = new IntegrationPipeline();

/**
 * @param {object} [deps]
 * @param {IntegrationPipeline} [deps.pipeline]
 * @returns {import('express').RequestHandler}
 */
function makeWebhookHandler(deps = {}) {
  const pipeline = deps.pipeline || defaultPipeline;

  return async function handleWebhook(req, res, next) {
    const { correlationId } = req;

    // 1) Schema validation at the trust boundary.
    const parsed = transactionWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn('Webhook validation failed', {
        correlationId,
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return res.status(400).json({
        error: 'Payload validation failed',
        correlationId,
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    // 2) Acknowledge fast.
    res.status(202).json({ status: 'accepted', correlationId, eventId: parsed.data.event_id });

    // 3) Process after the ACK. Errors here are already handled inside the
    //    pipeline (dead-lettering); we guard once more so an unexpected bug is
    //    logged rather than becoming an unhandled rejection.
    try {
      const result = await pipeline.process(parsed.data, { correlationId });
      logger.info('Pipeline complete', { correlationId, result: result.status });
    } catch (err) {
      logger.error('Unexpected pipeline error', { correlationId, error: err.message, stack: err.stack });
    }
  };
}

module.exports = { makeWebhookHandler, defaultPipeline };
