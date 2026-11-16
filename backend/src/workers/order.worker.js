require("dotenv").config();

const { Worker, createNodeRedisClient } = require("bullmq");
const pool = require("../config/database");
const redis = require("../config/redis");

const {
  ORDER_QUEUE_NAME,
  ORDER_RECEIPT_JOB,
} = require("../queues/order.queue");

const {
  createOrderReceiptProcessor,
} = require("./order-receipt.processor");

// Shutdown policy:
// - stop fetching new jobs immediately;
// - give active receipt processors 20 seconds to finish;
// - close BullMQ normally after they drain;
// - if they do not drain, force-close BullMQ, tear down connections with
//   bounded waits, and terminate this worker process. The OS then aborts any
//   remaining processor code, while BullMQ's stalled-job mechanism makes the
//   interrupted job eligible for another worker after its lock expires.
const GRACEFUL_SHUTDOWN_MS = 20000;
const WORKER_PAUSE_TIMEOUT_MS = 3000;
const WORKER_CLOSE_TIMEOUT_MS = 5000;
const DEDICATED_REDIS_CLOSE_TIMEOUT_MS = 2000;
const SHARED_REDIS_CLOSE_TIMEOUT_MS = 2000;
const DATABASE_CLOSE_TIMEOUT_MS = 3000;

function withTimeout(operation, timeoutMs, message) {
  let timer;
  const operationPromise = Promise.resolve().then(operation);
  operationPromise.catch(() => {});

  return Promise.race([
    operationPromise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function destroyClient(client, logger, label) {
  if (!client || !client.isOpen || typeof client.destroy !== "function") {
    return;
  }

  try {
    client.destroy();
  } catch (error) {
    logger.error(`[Order Worker] ${label} destroy failed:`, error.message);
  }
}

async function closeDedicatedRedisClient(
  rawClient,
  {
    timeoutMs = DEDICATED_REDIS_CLOSE_TIMEOUT_MS,
    logger = console,
  } = {},
) {
  if (!rawClient || !rawClient.isOpen) return true;

  if (!rawClient.isReady || typeof rawClient.close !== "function") {
    destroyClient(rawClient, logger, "Dedicated Redis");
    return !rawClient.isOpen;
  }

  try {
    await withTimeout(
      () => rawClient.close(),
      timeoutMs,
      "Timed out closing the dedicated worker Redis client",
    );
  } catch (error) {
    logger.error("[Order Worker] Dedicated Redis close failed:", error.message);
    destroyClient(rawClient, logger, "Dedicated Redis");
    return false;
  }

  // Some adapters leave their underlying node-redis socket open after close.
  if (rawClient.isOpen) {
    destroyClient(rawClient, logger, "Dedicated Redis");
  }

  return !rawClient.isOpen;
}

async function closeSharedRedis(
  redisManager,
  {
    timeoutMs = SHARED_REDIS_CLOSE_TIMEOUT_MS,
    logger = console,
  } = {},
) {
  const sharedClient = redisManager.client;

  try {
    await withTimeout(
      () => redisManager.closeRedis(),
      timeoutMs,
      "Timed out closing the shared Redis client",
    );
    return true;
  } catch (error) {
    logger.error("[Order Worker] Shared Redis close failed:", error.message);
    destroyClient(sharedClient, logger, "Shared Redis");
    return false;
  }
}

async function closeDatabase(
  db,
  {
    timeoutMs = DATABASE_CLOSE_TIMEOUT_MS,
    logger = console,
  } = {},
) {
  try {
    await withTimeout(
      () => db.end(),
      timeoutMs,
      "Timed out closing the PostgreSQL pool",
    );
    return true;
  } catch (error) {
    logger.error("[Order Worker] PostgreSQL pool close failed:", error.message);
    return false;
  }
}

async function startOrderWorker({
  redisManager = redis,
  db = pool,
  WorkerClass = Worker,
  createReceiptProcessor = createOrderReceiptProcessor,
  createRedisConnection = createNodeRedisClient,
  logger = console,
  registerSignals = true,
  gracefulShutdownMs = GRACEFUL_SHUTDOWN_MS,
  workerPauseTimeoutMs = WORKER_PAUSE_TIMEOUT_MS,
  workerCloseTimeoutMs = WORKER_CLOSE_TIMEOUT_MS,
  dedicatedRedisCloseTimeoutMs = DEDICATED_REDIS_CLOSE_TIMEOUT_MS,
  sharedRedisCloseTimeoutMs = SHARED_REDIS_CLOSE_TIMEOUT_MS,
  databaseCloseTimeoutMs = DATABASE_CLOSE_TIMEOUT_MS,
  terminateProcess = (exitCode) => process.exit(exitCode),
} = {}) {
  let rawClient;
  let worker;
  let shutdownPromise = null;

  // We track the actual processor promises, not just BullMQ's Worker.close()
  // promise. This tells shutdown whether receipt code may still be using PG.
  const activeProcessorIds = new Set();
  const activeDrainWaiters = [];

  function waitForActiveProcessors() {
    if (activeProcessorIds.size === 0) return Promise.resolve();

    return new Promise((resolve) => {
      activeDrainWaiters.push(resolve);
    });
  }

  function notifyActiveProcessorsDrained() {
    if (activeProcessorIds.size !== 0) return;

    while (activeDrainWaiters.length > 0) {
      activeDrainWaiters.shift()();
    }
  }

  async function runReceiptProcessor(job, processReceipt) {
    const processorId = String(job.id || job.data?.orderId || "unknown");
    activeProcessorIds.add(processorId);

    try {
      return await processReceipt(job);
    } finally {
      activeProcessorIds.delete(processorId);
      notifyActiveProcessorsDrained();
    }
  }

  async function cleanupStartupFailure() {
    try {
      await closeDedicatedRedisClient(rawClient, { timeoutMs: dedicatedRedisCloseTimeoutMs, logger });
    } finally {
      try {
        await closeSharedRedis(redisManager, { timeoutMs: sharedRedisCloseTimeoutMs, logger });
      } finally {
        await closeDatabase(db, { timeoutMs: databaseCloseTimeoutMs, logger });
      }
    }
  }

  try {
    const connected = await redisManager.connectRedis();

    if (!connected || !redisManager.client) {
      throw new Error("Redis is unavailable");
    }

    rawClient = redisManager.client.duplicate();

    rawClient.on("error", (error) => {
      logger.error("[Order Worker] Redis error:", error.message);
    });

    await rawClient.connect();

    const connection = createRedisConnection(rawClient);
    const processReceipt = createReceiptProcessor();

    worker = new WorkerClass(
      ORDER_QUEUE_NAME,
      async (job) => {
        if (job.name !== ORDER_RECEIPT_JOB) {
          throw new Error(`Unsupported job: ${job.name}`);
        }

        return runReceiptProcessor(job, processReceipt);
      },
      {
        connection,
        concurrency: 5,
      },
    );

    worker.on("completed", (job) => {
      logger.info(`[Order Worker] Job ${job.id} completed.`);
    });

    worker.on("failed", (job, error) => {
      logger.error(
        `[Order Worker] Job ${job?.id || "unknown"} failed:`,
        error.message,
      );
    });

    worker.on("error", (error) => {
      logger.error("[Order Worker] Error:", error.message);
    });

    function shutdown(signal = "shutdown") {
      // Return the exact same promise to every caller. A second SIGTERM/SIGINT
      // waits for the original cleanup instead of returning early.
      if (shutdownPromise) return shutdownPromise;

      shutdownPromise = (async () => {
        logger.info(
          `[Order Worker] ${signal}; stopping new jobs and draining active receipts...`,
        );

        let hardTerminationRequired = false;
        let activeProcessorsDrained = true;

        try {
          if (worker) {
            try {
              // BullMQ pause(true) stops fetching new jobs and returns without
              // waiting for active processors. We wait using our own tracker.
              await withTimeout(
                () => worker.pause(true),
                workerPauseTimeoutMs,
                "Timed out pausing the BullMQ order worker",
              );
            } catch (error) {
              activeProcessorsDrained = false;
              hardTerminationRequired = true;
              logger.error("[Order Worker] Worker pause failed:", error.message);
            }

            if (activeProcessorsDrained) {
              try {
                await withTimeout(
                  () => waitForActiveProcessors(),
                  gracefulShutdownMs,
                  `Active receipt jobs did not finish within ${gracefulShutdownMs}ms`,
                );
              } catch (error) {
                activeProcessorsDrained = false;
                hardTerminationRequired = true;
                logger.error(
                  "[Order Worker] Graceful drain deadline reached:",
                  error.message,
                );
              }
            }

            try {
              // Normal close is used only after our active processor tracker
              // is empty. Otherwise force close releases BullMQ's lock
              // renewal connection so another worker can recover the job
              // after its lock expires.
              await withTimeout(
                () => worker.close(!activeProcessorsDrained),
                workerCloseTimeoutMs,
                `BullMQ worker close exceeded ${workerCloseTimeoutMs}ms`,
              );
            } catch (error) {
              hardTerminationRequired = true;
              logger.error("[Order Worker] BullMQ worker close failed:", error.message);
              destroyClient(rawClient, logger, "Dedicated Redis");
            }
          }
        } finally {
          try {
            const dedicatedClosed = await closeDedicatedRedisClient(rawClient, {
              timeoutMs: dedicatedRedisCloseTimeoutMs,
              logger,
            });
            if (!dedicatedClosed) hardTerminationRequired = true;
          } finally {
            try {
              const sharedClosed = await closeSharedRedis(redisManager, {
                timeoutMs: sharedRedisCloseTimeoutMs,
                logger,
              });
              if (!sharedClosed) hardTerminationRequired = true;
            } finally {
              try {
                const databaseClosed = await closeDatabase(db, {
                  timeoutMs: databaseCloseTimeoutMs,
                  logger,
                });
                if (!databaseClosed) hardTerminationRequired = true;
              } finally {
                if (!activeProcessorsDrained || activeProcessorIds.size > 0) {
                  hardTerminationRequired = true;
                  logger.error(
                    "[Order Worker] Active receipt processing was interrupted. " +
                    "The worker process must exit so no processor can continue " +
                    "against a closed PostgreSQL pool; BullMQ can recover the " +
                    "stalled job after its lock expires.",
                  );
                }

                if (hardTerminationRequired) {
                  terminateProcess(1);
                }
              }
            }
          }
        }

        logger.info("[Order Worker] Shutdown completed.");
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

    logger.info("[Order Worker] Started successfully.");

    return {
      worker,
      shutdown,
      get activeProcessorCount() {
        return activeProcessorIds.size;
      },
    };
  } catch (error) {
    try {
      await cleanupStartupFailure();
    } catch (cleanupError) {
      logger.error("[Order Worker] Startup cleanup failed:", cleanupError.message);
    }

    throw error;
  }
}

if (require.main === module) {
  startOrderWorker().catch((error) => {
    console.error("[Order Worker] Startup failed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  startOrderWorker,
  closeDedicatedRedisClient,
  closeSharedRedis,
  closeDatabase,
  withTimeout,
  GRACEFUL_SHUTDOWN_MS,
};
