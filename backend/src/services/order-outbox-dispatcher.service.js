const pool = require("../config/database");
const { createOrderQueue } = require("../queues/order.queue");
const redis = require("../config/redis");

const BATCH_SIZE = 25;
const LEASE_SECONDS = 60;

function createOrderOutboxDispatcher({
  db = pool,
  createQueue = createOrderQueue,
  redisManager = redis,
} = {}) {
  let queueResources = null;

  async function ensureQueue() {
    if (!redisManager.isRedisReady()) {
      const connected = await redisManager.connectRedis();

      if (!connected) {
        throw new Error("Redis is unavailable. Outbox event will be retried.");
      }
    }

    if (!queueResources) {
      queueResources = await createQueue();
    }

    return queueResources;
  }

  async function claimPendingEvents() {
    const result = await db.query(
      `WITH candidates AS (
         SELECT id
         FROM order_outbox
         WHERE
           (status = 'pending' AND available_at <= CURRENT_TIMESTAMP)
           OR
           (status = 'processing' AND locked_until < CURRENT_TIMESTAMP)
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE order_outbox AS events
       SET status = 'processing',
           attempts = attempts + 1,
           locked_until = CURRENT_TIMESTAMP + ($2 * INTERVAL '1 second'),
           updated_at = CURRENT_TIMESTAMP
       FROM candidates
       WHERE events.id = candidates.id
       RETURNING events.id, events.order_id, events.payload, events.attempts`,
      [BATCH_SIZE, LEASE_SECONDS],
    );
    return result.rows;
  }

  async function markDispatched(eventId) {
    await db.query(
      `UPDATE order_outbox
       SET status = 'dispatched',
           dispatched_at = CURRENT_TIMESTAMP,
           locked_until = NULL,
           last_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [eventId],
    );
  }

  async function releaseForRetry(event, error) {
    await db.query(
      `UPDATE order_outbox
       SET status = 'pending',
           available_at = CURRENT_TIMESTAMP + LEAST(POWER(2, attempts), 60) * INTERVAL '1 second',
           locked_until = NULL,
           last_error = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [event.id, String(error.message || error).slice(0, 2000)],
    );
  }

  async function dispatchBatch() {
    const events = await claimPendingEvents();
    if (events.length === 0) return { claimed: 0, dispatched: 0, failed: 0 };

    let dispatched = 0;
    let failed = 0;

    for (const event of events) {
      try {
        const queue = await ensureQueue();
        // Stable job IDs make re-publishing after a dispatcher crash safe
        // while a BullMQ job remains retained. Receipt persistence is also
        // idempotent if BullMQ later redelivers an old job.
        await queue.enqueueOrderReceipt(event.order_id);
        await markDispatched(event.id);
        dispatched += 1;
      } catch (error) {
        failed += 1;
        await releaseForRetry(event, error);
        if (queueResources) {
          await queueResources.close().catch(() => {});
          queueResources = null;
        }
      }
    }

    return { claimed: events.length, dispatched, failed };
  }

  async function close() {
    if (queueResources) {
      await queueResources.close();
      queueResources = null;
    }
  }

  return { dispatchBatch, close };
}

module.exports = { createOrderOutboxDispatcher };
