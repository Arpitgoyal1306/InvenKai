const { randomUUID } = require("node:crypto");
const pool = require("../config/database");
const { createOrderQueue } = require("../queues/order.queue");
const redis = require("../config/redis");

const BATCH_SIZE = 25;
const LEASE_SECONDS = 60;
const LEASE_RENEWAL_INTERVAL_MS = 20000;
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
  leaseRenewalIntervalMs = Math.min(LEASE_RENEWAL_INTERVAL_MS, Math.max(100, Math.floor(leaseSeconds * 1000 / 3))),
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
        Promise.resolve().then(() => redisManager.connectRedis()),
        enqueueTimeoutMs,
        "Timed out connecting the outbox dispatcher to Redis",
      );

      if (!connected) {
        throw new Error("Redis is unavailable. Outbox event will be retried.");
      }
    }

    if (!queueResources) {
      const resources = await withTimeout(
        Promise.resolve().then(() => createQueue()),
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

  async function renewClaimedEvents(events, claimToken) {
    if (events.length === 0) return new Set();

    const ids = events.map((event) => String(event.id));
    const result = await withTimeout(
      Promise.resolve().then(() => db.query(
        `UPDATE order_outbox
         SET locked_until = CURRENT_TIMESTAMP + ($1 * INTERVAL '1 second'),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($3::bigint[])
           AND status = 'processing'
           AND claim_token = $2::uuid
         RETURNING id`,
        [leaseSeconds, claimToken, ids],
      )),
      enqueueTimeoutMs,
      "Timed out renewing the outbox batch lease",
    );

    return new Set(result.rows.map((row) => String(row.id)));
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
      Promise.resolve().then(() => resources.close()),
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

    const claimToken = events[0].claim_token;
    const pendingEvents = new Map(events.map((event) => [String(event.id), event]));
    const finalizingEventIds = new Set();
    const lostEventIds = new Set();
    let renewalPromise = null;

    async function renewPendingClaims() {
      if (renewalPromise) return renewalPromise;

      const candidates = Array.from(pendingEvents.values()).filter(
        (event) => !finalizingEventIds.has(String(event.id)) &&
          !lostEventIds.has(String(event.id)),
      );
      if (candidates.length === 0) return;

      const currentRenewal = (async () => {
        let renewedIds;

        try {
          renewedIds = await renewClaimedEvents(candidates, claimToken);
        } catch (renewalError) {
          // A database timeout is not proof the claim still belongs to us.
          // Conservatively stop using every unconfirmed claim. Their lease
          // expiry is the recovery path if this was only a transient outage.
          for (const event of candidates) {
            const id = String(event.id);
            if (pendingEvents.has(id) && !finalizingEventIds.has(id)) {
              lostEventIds.add(id);
              pendingEvents.delete(id);
            }
          }

          renewalError.code = "OUTBOX_LEASE_UNCONFIRMED";
          throw renewalError;
        }

        for (const event of candidates) {
          const id = String(event.id);

          // An event may have completed while this renewal query was in flight.
          // Do not report a completed/finalizing event as a lost lease.
          if (
            pendingEvents.has(id) &&
            !finalizingEventIds.has(id) &&
            !renewedIds.has(id)
          ) {
            lostEventIds.add(id);
            pendingEvents.delete(id);
            logger.warn(
              "[Outbox Dispatcher] Lost claim for event " + id +
              "; it will not be marked or released by this dispatcher.",
            );
          }
        }
      })();

      renewalPromise = currentRenewal.finally(() => {
        renewalPromise = null;
      });
      return renewalPromise;
    }

    const renewalTimer = setInterval(() => {
      void renewPendingClaims().catch((error) => {
        logger.error(
          "[Outbox Dispatcher] Lease renewal failed; unconfirmed claims will not be started:",
          error.message,
        );
      });
    }, leaseRenewalIntervalMs);

    try {
      for (const event of events) {
        const eventId = String(event.id);

        // A row that another dispatcher reclaimed is removed from the
        // pending set by the token-guarded renewal. Never enqueue, mark, or
        // release that stale claim.
        if (!pendingEvents.has(eventId) || lostEventIds.has(eventId)) {
          failed += 1;
          continue;
        }
        if (stopped) break;

        try {
          // Renew the entire uncompleted portion before progressing. The
          // background heartbeat repeats this while a batch is in flight.
          await renewPendingClaims();

          if (!pendingEvents.has(eventId) || lostEventIds.has(eventId)) {
            failed += 1;
            continue;
          }

          const queue = await ensureQueue();

          if (!pendingEvents.has(eventId) || lostEventIds.has(eventId)) {
            throw Object.assign(
              new Error("Outbox claim was lost while preparing the queue"),
              { code: "OUTBOX_LEASE_LOST" },
            );
          }

          // A timed-out enqueue may have reached Redis before its response was
          // lost. The deterministic job ID makes a later enqueue safe.
          await withTimeout(
            Promise.resolve().then(() => queue.enqueueOrderReceipt(event.order_id)),
            enqueueTimeoutMs,
            "Timed out enqueueing receipt job for outbox event " + event.id,
          );

          if (!pendingEvents.has(eventId) || lostEventIds.has(eventId)) {
            throw Object.assign(
              new Error("Outbox claim was lost while enqueueing the job"),
              { code: "OUTBOX_LEASE_LOST" },
            );
          }

          // Exclude this event from lease renewal while its token-guarded
          // terminal update is in flight. All later batch rows keep renewing.
          finalizingEventIds.add(eventId);
          await withTimeout(
            Promise.resolve().then(() => markDispatched(event)),
            enqueueTimeoutMs,
            "Timed out marking outbox event " + event.id + " as dispatched",
          );

          dispatched += 1;
        } catch (error) {
          failed += 1;

          // A heartbeat may have observed that another dispatcher reclaimed
          // this row while an enqueue was in flight. The stable job ID makes
          // that enqueue replay-safe, but the old token must not mutate the
          // new owner's row.
          if (error.code !== "OUTBOX_LEASE_LOST" && !lostEventIds.has(eventId)) {
            finalizingEventIds.add(eventId);
            try {
              await withTimeout(
                Promise.resolve().then(() => releaseForRetry(event, error)),
                enqueueTimeoutMs,
                "Timed out releasing outbox event " + event.id + " for retry",
              );
            } catch (releaseError) {
              logger.error(
                "[Outbox Dispatcher] Could not release event " + event.id +
                "; lease expiry will recover it:",
                releaseError.message,
              );
            }

            try {
              await closeQueueResources();
            } catch (closeError) {
              logger.error(
                "[Outbox Dispatcher] Queue cleanup after event " + event.id + " failed:",
                closeError.message,
              );
            }
          } else if (error.code === "OUTBOX_LEASE_LOST") {
            logger.warn(
              "[Outbox Dispatcher] Skipping stale claim for event " + event.id +
              "; another dispatcher owns it now.",
            );
          } else {
            logger.warn(
              "[Outbox Dispatcher] Skipping event " + event.id +
              " because its claim could not be confirmed; lease expiry will recover it.",
            );
          }
        } finally {
          finalizingEventIds.add(eventId);
          pendingEvents.delete(eventId);
        }
      }
    } catch (error) {
      // If the database cannot confirm ownership, leave remaining rows in
      // processing. Their leases expire and a later dispatcher can reclaim
      // them; do not publish events with unconfirmed claims.
      failed += pendingEvents.size;
      logger.error(
        "[Outbox Dispatcher] Stopping this batch because claim ownership could not be renewed:",
        error.message,
      );
    } finally {
      clearInterval(renewalTimer);
      if (renewalPromise) {
        await renewalPromise.catch((error) => {
          logger.error("[Outbox Dispatcher] Final lease renewal did not settle:", error.message);
        });
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
  BATCH_SIZE,
  LEASE_SECONDS,
  LEASE_RENEWAL_INTERVAL_MS,
};