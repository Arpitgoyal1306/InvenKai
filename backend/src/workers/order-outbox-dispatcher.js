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
const REDIS_CLOSE_TIMEOUT_MS = 2000;
const DATABASE_CLOSE_TIMEOUT_MS = 3000;

async function startDispatcher({
  db = pool,
  redisManager = redis,
  createDispatcher = (options) => createOrderOutboxDispatcher(options),
  pollIntervalMs = POLL_INTERVAL_MS,
  shutdownGraceMs = SHUTDOWN_GRACE_MS,
  queueCloseTimeoutMs = QUEUE_CLOSE_TIMEOUT_MS,
  redisCloseTimeoutMs = REDIS_CLOSE_TIMEOUT_MS,
  databaseCloseTimeoutMs = DATABASE_CLOSE_TIMEOUT_MS,
  terminateProcess = (exitCode) => process.exit(exitCode),
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

  function shutdown(signal = "shutdown") {
    // Return the exact same promise to every caller. Repeated signals cannot
    // start duplicate cleanup operations.
    if (shutdownPromise) return shutdownPromise;

    stopping = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    logger.info("[Outbox Dispatcher] " + signal + "; shutting down...");

    shutdownPromise = (async () => {
      let shutdownIncomplete = false;

      try {
        try {
          dispatcher.stop?.();
        } catch (error) {
          shutdownIncomplete = true;
          logger.error("[Outbox Dispatcher] Could not stop dispatcher polling:", error.message);
        }

        if (activePoll) {
          try {
            await withTimeout(
              activePoll,
              shutdownGraceMs,
              "Outbox dispatch did not stop within the shutdown grace period",
            );
          } catch (error) {
            shutdownIncomplete = true;
            logger.error(
              "[Outbox Dispatcher] Active poll exceeded its shutdown grace period:",
              error.message,
            );
          }
        }
      } finally {
        // Queue close has its own service-level timeout. Keep an outer bound
        // as well so injected/adapted dispatcher implementations cannot
        // leave SIGTERM waiting indefinitely.
        try {
          await withTimeout(
            Promise.resolve().then(() =>
              dispatcher.close({ timeoutMs: queueCloseTimeoutMs }),
            ),
            queueCloseTimeoutMs,
            "Timed out closing the dispatcher queue after " + queueCloseTimeoutMs + "ms",
          );
        } catch (error) {
          shutdownIncomplete = true;
          logger.error("[Outbox Dispatcher] Queue cleanup failed:", error.message);
        } finally {
          // Each resource close is started once and independently bounded.
          // A Redis timeout/rejection must never skip PostgreSQL cleanup.
          try {
            await withTimeout(
              Promise.resolve().then(() => redisManager.closeRedis()),
              redisCloseTimeoutMs,
              "Timed out closing Redis after " + redisCloseTimeoutMs + "ms",
            );
          } catch (error) {
            shutdownIncomplete = true;
            logger.error("[Outbox Dispatcher] Redis cleanup failed:", error.message);
          } finally {
            try {
              await withTimeout(
                Promise.resolve().then(() => db.end()),
                databaseCloseTimeoutMs,
                "Timed out closing PostgreSQL after " + databaseCloseTimeoutMs + "ms",
              );
            } catch (error) {
              shutdownIncomplete = true;
              logger.error("[Outbox Dispatcher] PostgreSQL cleanup failed:", error.message);
            } finally {
              if (shutdownIncomplete) {
                // A timed-out poll/close may still have work pending. Do not
                // claim graceful shutdown or leave the process alive against
                // resources that may already be closed. Exiting releases the
                // process; unprocessed outbox claims remain recoverable when
                // their 60-second leases expire.
                logger.error(
                  "[Outbox Dispatcher] Shutdown was incomplete; terminating with exit code 1. " +
                  "Unprocessed outbox claims will be recovered after lease expiry.",
                );
                terminateProcess(1);
              } else {
                logger.info("[Outbox Dispatcher] Shutdown completed gracefully.");
              }
            }
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

    let cleanupFailed = false;

    try {
      await withTimeout(
        Promise.resolve().then(() => redis.closeRedis()),
        REDIS_CLOSE_TIMEOUT_MS,
        "Timed out closing Redis after " + REDIS_CLOSE_TIMEOUT_MS + "ms during startup cleanup",
      );
    } catch (cleanupError) {
      cleanupFailed = true;
      console.error("[Outbox Dispatcher] Startup Redis cleanup failed:", cleanupError.message);
    } finally {
      try {
        await withTimeout(
          Promise.resolve().then(() => pool.end()),
          DATABASE_CLOSE_TIMEOUT_MS,
          "Timed out closing PostgreSQL after " + DATABASE_CLOSE_TIMEOUT_MS + "ms during startup cleanup",
        );
      } catch (cleanupError) {
        cleanupFailed = true;
        console.error("[Outbox Dispatcher] Startup PostgreSQL cleanup failed:", cleanupError.message);
      } finally {
        if (cleanupFailed) {
          console.error("[Outbox Dispatcher] Startup cleanup was incomplete; terminating.");
          process.exit(1);
        } else {
          process.exitCode = 1;
        }
      }
    }
  });
}

module.exports = {
  startDispatcher,
  REDIS_CLOSE_TIMEOUT_MS,
  DATABASE_CLOSE_TIMEOUT_MS,
};