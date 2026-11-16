const { randomUUID } = require("node:crypto");
const pool = require("../config/database");
const { createOrderQueue } = require("../queues/order.queue");
const redis = require("../config/redis");

const BATCH_SIZE = 25;
const LEASE_SECONDS = 60;
const ENQUEUE_TIMEOUT_MS = 5000;
const QUEUE_CLOSE_TIMEOUT_MS = 4000;

function withTimeout(promise, timeoutMs, message) {
  let timer;

  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function createOrderOutboxDispatcher({
  db = pool,
  createQueue = createOrderQueue,
  redisManager = redis,
  batchSize = BATCH_SIZE,
  leaseSeconds = LEASE_SECONDS,
  enqueueTimeoutMs = ENQUEUE_TIMEOUT_MS,
  queueCloseTimeoutMs = QUEUE_CLOSE_TIMEOUT_MS,
  logger = console,
} = {}) {
  let queueResources = null;
  let stopped = false;

  async function ensureQueue() {
    if (stopped) {
      throw new Error("Outbox dispatcher is stopping");
    }

    if (!redisManager.isRedisReady()) {
      const connected = await withTimeout(
        redisManager.connectRedis(),
        enqueueTimeoutMs,
        "Timed out connecting the outbox dispatcher to Redis",
      );

      if (!connected) {
        throw new Error("Redis is unavailable. Outbox event will be retried.");
      }
    }

    if (!queueResources) {
      const resources = await withTimeout(
        createQueue(),
        enqueueTimeoutMs,
        "Timed out creating the BullMQ order queue",
      );

      // close() may have been called while createQueue() was pending.
      if (stopped) {
        await resources.close().catch((error) => {
          logger.error("[Outbox Dispatcher] Late queue cleanup failed:", error.message);
        });
        throw new Error("Outbox dispatcher stopped while creating the queue");
      }

      queueResources = resources;
    }

    return queueResources;
  }

  async function claimPendingEvents() {
    const claimToken = randomUUID();
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
           claim_token = $3::uuid,
           updated_at = CURRENT_TIMESTAMP
       FROM candidates
       WHERE events.id = candidates.id
       RETURNING events.id, events.order_id, events.payload,
                 events.attempts, events.claim_token`,
      [batchSize, leaseSeconds, claimToken],
    );

    return result.rows;
  }

  async function markDispatched(event) {
    const result = await db.query(
      `UPDATE order_outbox
       SET status = 'dispatched',
           dispatched_at = CURRENT_TIMESTAMP,
           locked_until = NULL,
           claim_token = NULL,
           last_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND status = 'processing'
         AND claim_token = $2::uuid`,
      [event.id, event.claim_token],
    );

    if (result.rowCount === 0) {
      const error = new Error("Outbox lease was reclaimed before dispatch completed");
      error.code = "OUTBOX_LEASE_LOST";
      throw error;
    }
  }

  async function releaseForRetry(event, error) {
    await db.query(
      `UPDATE order_outbox
       SET status = 'pending',
           available_at = CURRENT_TIMESTAMP + LEAST(POWER(2, attempts), 60) * INTERVAL '1 second',
           locked_until = NULL,
           claim_token = NULL,
           last_error = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND status = 'processing'
         AND claim_token = $3::uuid`,
      [event.id, String(error.message || error).slice(0, 2000), event.claim_token],
    );
  }

  async function closeQueueResources() {
    if (!queueResources) return;

    const resources = queueResources;
    queueResources = null;

    await withTimeout(
      resources.close(),
      queueCloseTimeoutMs,
      "Timed out closing the BullMQ order queue",
    );
  }

  async function dispatchBatch() {
    if (stopped) return { claimed: 0, dispatched: 0, failed: 0 };

    const events = await claimPendingEvents();
    if (events.length === 0) return { claimed: 0, dispatched: 0, failed: 0 };

    let dispatched = 0;
    let failed = 0;

    for (const event of events) {
      // Rows already claimed but not started remain processing until their
      // lease expires. A later dispatcher can safely reclaim them.
      if (stopped) break;

      try {
        const queue = await ensureQueue();

        // A timed-out enqueue may have reached Redis before its response was
        // lost. The deterministic job ID makes a later enqueue safe.
        await withTimeout(
          queue.enqueueOrderReceipt(event.order_id),
          enqueueTimeoutMs,
          `Timed out enqueueing receipt job for outbox event ${event.id}`,
        );

        await withTimeout(
          markDispatched(event),
          enqueueTimeoutMs,
          `Timed out marking outbox event ${event.id} as dispatched`,
        );

        dispatched += 1;
      } catch (error) {
        failed += 1;

        // A stale claim must never release or overwrite the current owner's
        // lease. For other errors, release is best effort; lease expiry is the
        // recovery path if PostgreSQL is unavailable too.
        if (error.code !== "OUTBOX_LEASE_LOST") {
          try {
            await withTimeout(
              releaseForRetry(event, error),
              enqueueTimeoutMs,
              `Timed out releasing outbox event ${event.id} for retry`,
            );
          } catch (releaseError) {
            logger.error(
              `[Outbox Dispatcher] Could not release event ${event.id}; lease expiry will recover it:`,
              releaseError.message,
            );
          }

          try {
            await closeQueueResources();
          } catch (closeError) {
            logger.error(
              `[Outbox Dispatcher] Queue cleanup after event ${event.id} failed:`,
              closeError.message,
            );
          }
        } else {
          logger.warn(
            `[Outbox Dispatcher] Lost lease for event ${event.id}; another dispatcher owns it now.`,
          );
        }
      }
    }

    return { claimed: events.length, dispatched, failed };
  }

  async function close() {
    stopped = true;
    await closeQueueResources();
  }

  function stop() {
    stopped = true;
  }

  return { dispatchBatch, stop, close };
}

module.exports = {
  createOrderOutboxDispatcher,
  withTimeout,
};
