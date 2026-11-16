require("dotenv").config();

const redis = require("../config/redis");
const pool = require("../config/database");
const {
  createOrderOutboxDispatcher,
  withTimeout,
} = require("../services/order-outbox-dispatcher.service");

const POLL_INTERVAL_MS = 2000;
const SHUTDOWN_GRACE_MS = 12000;
const QUEUE_CLOSE_TIMEOUT_MS = 4000;

async function startDispatcher({
  db = pool,
  redisManager = redis,
  createDispatcher = (options) => createOrderOutboxDispatcher(options),
  pollIntervalMs = POLL_INTERVAL_MS,
  shutdownGraceMs = SHUTDOWN_GRACE_MS,
  queueCloseTimeoutMs = QUEUE_CLOSE_TIMEOUT_MS,
  logger = console,
  registerSignals = true,
} = {}) {
  const dispatcher = createDispatcher({
    db,
    redisManager,
    enqueueTimeoutMs: 5000,
    queueCloseTimeoutMs,
    logger,
  });

  let stopping = false;
  let timer = null;
  let running = false;
  let activePoll = null;
  let shutdownPromise = null;

  function poll() {
    if (stopping || running) return Promise.resolve();

    running = true;

    const currentPoll = (async () => {
      try {
        const result = await dispatcher.dispatchBatch();
        if (result.claimed > 0) {
          logger.info("[Outbox Dispatcher]", result);
        }
      } catch (error) {
        logger.error("[Outbox Dispatcher] Poll failed:", error.message);
      } finally {
        running = false;
        if (activePoll === currentPoll) activePoll = null;
      }
    })();

    activePoll = currentPoll;
    return currentPoll;
  }

  // Do not await the initial poll. This allows SIGTERM handlers and the
  // shutdown handle to be installed even if Redis/PostgreSQL is slow.
  void poll();
  timer = setInterval(() => void poll(), pollIntervalMs);

  async function shutdown(signal = "shutdown") {
    if (shutdownPromise) return shutdownPromise;

    stopping = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    dispatcher.stop?.();

    logger.info(`[Outbox Dispatcher] ${signal}; shutting down...`);

    shutdownPromise = (async () => {
      try {
        if (activePoll) {
          try {
            await withTimeout(
              activePoll,
              shutdownGraceMs,
              "Outbox dispatch did not stop within the shutdown grace period",
            );
          } catch (error) {
            logger.warn("[Outbox Dispatcher] Continuing bounded shutdown:", error.message);
          }
        }
      } finally {
        try {
          await dispatcher.close({ timeoutMs: queueCloseTimeoutMs });
        } finally {
          try {
            await redisManager.closeRedis();
          } finally {
            await db.end();
          }
        }
      }
    })();

    return shutdownPromise;
  }

  if (registerSignals) {
    process.once("SIGINT", () => {
      void shutdown("SIGINT").catch((error) => logger.error(error));
    });

    process.once("SIGTERM", () => {
      void shutdown("SIGTERM").catch((error) => logger.error(error));
    });
  }

  return { shutdown, poll };
}

if (require.main === module) {
  startDispatcher().catch(async (error) => {
    console.error("[Outbox Dispatcher] Startup failed:", error.message);

    try {
      await redis.closeRedis();
    } finally {
      await pool.end();
    }

    process.exitCode = 1;
  });
}

module.exports = { startDispatcher };
