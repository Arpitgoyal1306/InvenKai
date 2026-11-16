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

// Startup connections are bounded independently. The shared connection is
// attempted before the dedicated BullMQ connection.
const SHARED_REDIS_CONNECT_TIMEOUT_MS = 5000;
const DEDICATED_REDIS_CONNECT_TIMEOUT_MS = 5000;

// Shutdown policy:
// - signal handlers are installed before the first external connection;
// - a signal moves the shared lifecycle out of "starting" synchronously;
// - active receipt processors get 20 seconds to finish;
// - BullMQ is closed normally after they drain, or force-closed at the deadline;
// - dedicated Redis, shared Redis, and PostgreSQL cleanup are each bounded;
// - an incomplete cleanup or interrupted processor escalates to process exit.
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
      timer = setTimeout(() => {
        const error = new Error(message);
        error.code = "WORKER_OPERATION_TIMEOUT";
        reject(error);
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function destroyClient(client, logger, label, force = false) {
  if (
    !client ||
    typeof client.destroy !== "function" ||
    (!force && !client.isOpen && !client.isReady)
  ) {
    return false;
  }

  try {
    client.destroy();
    return true;
  } catch (error) {
    logger.error("[Order Worker] " + label + " destroy failed:", error.message);
    return false;
  }
}

async function closeDedicatedRedisClient(
  rawClient,
  {
    timeoutMs = DEDICATED_REDIS_CLOSE_TIMEOUT_MS,
    logger = console,
    forceDestroy = false,
  } = {},
) {
  if (!rawClient) return true;

  if (forceDestroy) {
    if (rawClient.isOpen || rawClient.isReady) {
      destroyClient(rawClient, logger, "Dedicated Redis", true);
    } else {
      // destroy() also aborts a node-redis connect() that has not opened its
      // socket yet. This is required on startup timeout or early SIGTERM.
      destroyClient(rawClient, logger, "Dedicated Redis", true);
    }
    return !rawClient.isOpen && !rawClient.isReady;
  }

  if (!rawClient.isOpen && !rawClient.isReady) return true;

  if (!rawClient.isReady || typeof rawClient.close !== "function") {
    destroyClient(rawClient, logger, "Dedicated Redis", true);
    return !rawClient.isOpen && !rawClient.isReady;
  }

  try {
    await withTimeout(
      () => rawClient.close(),
      timeoutMs,
      "Timed out closing the dedicated worker Redis client",
    );
  } catch (error) {
    logger.error("[Order Worker] Dedicated Redis close failed:", error.message);
    destroyClient(rawClient, logger, "Dedicated Redis", true);
    return false;
  }

  // Some adapters leave their underlying node-redis socket open after close.
  if (rawClient.isOpen || rawClient.isReady) {
    destroyClient(rawClient, logger, "Dedicated Redis", true);
  }

  return !rawClient.isOpen && !rawClient.isReady;
}

async function closeSharedRedis(
  redisManager,
  {
    timeoutMs = SHARED_REDIS_CLOSE_TIMEOUT_MS,
    logger = console,
    forceDestroy = false,
    sharedClient = redisManager.client,
  } = {},
) {
  try {
    await withTimeout(
      () => redisManager.closeRedis(),
      timeoutMs,
      "Timed out closing the shared Redis client",
    );
  } catch (error) {
    logger.error("[Order Worker] Shared Redis close failed:", error.message);
    // A pending connect may not yet have set isOpen. Force destroy aborts
    // that connection attempt rather than relying on socket state.
    destroyClient(sharedClient, logger, "Shared Redis", forceDestroy);
    return false;
  }

  // closeRedis() normally destroys pending connections itself. If a test
  // adapter or alternate manager leaves a late socket open, close that exact
  // client reference instead of invoking closeRedis() a second time.
  if (sharedClient && (sharedClient.isOpen || sharedClient.isReady)) {
    destroyClient(sharedClient, logger, "Shared Redis", true);
  }

  return !sharedClient || (!sharedClient.isOpen && !sharedClient.isReady);
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

function createStartupTimeoutError(label, timeoutMs) {
  const error = new Error(
    "Timed out connecting the " + label + " Redis client after " + timeoutMs + "ms",
  );
  error.code = "WORKER_STARTUP_CONNECT_TIMEOUT";
  return error;
}

async function startOrderWorker({
  redisManager = redis,
  db = pool,
  WorkerClass = Worker,
  createReceiptProcessor = createOrderReceiptProcessor,
  createRedisConnection = createNodeRedisClient,
  logger = console,
  registerSignals = true,
  signalSource = process,
  sharedRedisConnectTimeoutMs = SHARED_REDIS_CONNECT_TIMEOUT_MS,
  dedicatedRedisConnectTimeoutMs = DEDICATED_REDIS_CONNECT_TIMEOUT_MS,
  gracefulShutdownMs = GRACEFUL_SHUTDOWN_MS,
  workerPauseTimeoutMs = WORKER_PAUSE_TIMEOUT_MS,
  workerCloseTimeoutMs = WORKER_CLOSE_TIMEOUT_MS,
  dedicatedRedisCloseTimeoutMs = DEDICATED_REDIS_CLOSE_TIMEOUT_MS,
  sharedRedisCloseTimeoutMs = SHARED_REDIS_CLOSE_TIMEOUT_MS,
  databaseCloseTimeoutMs = DATABASE_CLOSE_TIMEOUT_MS,
  terminateProcess = (exitCode) => process.exit(exitCode),
} = {}) {
  let lifecycleState = "starting";
  let rawClient = null;
  let sharedClientForAttempt = null;
  let worker = null;
  let shutdownPromise = null;
  let sharedConnectPending = false;
  let dedicatedConnectPending = false;
  let sharedConnectTimedOut = false;
  let dedicatedConnectTimedOut = false;
  let signalHandlersInstalled = false;

  // We track the actual processor promises, not just BullMQ's Worker.close()
  // promise. This tells shutdown whether receipt code may still be using PG.
  const activeProcessorIds = new Set();
  const activeDrainWaiters = [];

  function assertStartupActive() {
    if (lifecycleState !== "starting") {
      const error = new Error("Order worker startup was interrupted by shutdown");
      error.code = "WORKER_STARTUP_ABORTED";
      throw error;
    }
  }

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

  function removeSignalHandlers() {
    if (!signalHandlersInstalled) return;
    signalHandlersInstalled = false;

    if (typeof signalSource.removeListener === "function") {
      signalSource.removeListener("SIGINT", onSigint);
      signalSource.removeListener("SIGTERM", onSigterm);
    }
  }

  function onSigint() {
    void shutdown("SIGINT").catch((error) => {
      logger.error("[Order Worker] SIGINT shutdown failed:", error.message);
    });
  }

  function onSigterm() {
    void shutdown("SIGTERM").catch((error) => {
      logger.error("[Order Worker] SIGTERM shutdown failed:", error.message);
    });
  }

  if (registerSignals) {
    // This must happen before calling either Redis connection method.
    signalSource.once("SIGINT", onSigint);
    signalSource.once("SIGTERM", onSigterm);
    signalHandlersInstalled = true;
  }

  async function performShutdown(signal) {
    logger.info(
      "[Order Worker] " + signal +
      "; stopping startup/job intake and cleaning up resources...",
    );

    let hardTerminationRequired = false;
    let activeProcessorsDrained = true;

    try {
      if (worker) {
        try {
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
              "Active receipt jobs did not finish within " + gracefulShutdownMs + "ms",
            );
          } catch (error) {
            activeProcessorsDrained = false;
            hardTerminationRequired = true;
            logger.error("[Order Worker] Graceful drain deadline reached:", error.message);
          }
        }

        try {
          await withTimeout(
            () => worker.close(!activeProcessorsDrained),
            workerCloseTimeoutMs,
            "BullMQ worker close exceeded " + workerCloseTimeoutMs + "ms",
          );
        } catch (error) {
          hardTerminationRequired = true;
          logger.error("[Order Worker] BullMQ worker close failed:", error.message);
          destroyClient(rawClient, logger, "Dedicated Redis", true);
        }
      }
    } finally {
      try {
        const dedicatedClosed = await closeDedicatedRedisClient(rawClient, {
          timeoutMs: dedicatedRedisCloseTimeoutMs,
          logger,
          forceDestroy: dedicatedConnectPending,
        });
        if (!dedicatedClosed) hardTerminationRequired = true;
      } finally {
        try {
          const sharedClosed = await closeSharedRedis(redisManager, {
            timeoutMs: sharedRedisCloseTimeoutMs,
            logger,
            forceDestroy: sharedConnectPending,
            sharedClient: sharedClientForAttempt || redisManager.client,
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
            if (worker && (!activeProcessorsDrained || activeProcessorIds.size > 0)) {
              hardTerminationRequired = true;
              logger.error(
                "[Order Worker] Active receipt processing was interrupted. " +
                "The worker process must exit so no processor can continue " +
                "against a closed PostgreSQL pool; BullMQ can recover the " +
                "stalled job after its lock expires.",
              );
            }

            removeSignalHandlers();

            if (hardTerminationRequired) {
              lifecycleState = "failed";
              logger.error(
                "[Order Worker] Shutdown was incomplete; terminating with exit code 1.",
              );
              terminateProcess(1);
            } else {
              lifecycleState = "stopped";
              logger.info("[Order Worker] Shutdown completed.");
            }
          }
        }
      }
    }
  }

  function shutdown(signal = "shutdown") {
    if (shutdownPromise) return shutdownPromise;

    // State transition is synchronous. A startup continuation can no longer
    // construct a Worker after this line, even if Redis resolves immediately.
    lifecycleState = "stopping";
    removeSignalHandlers();

    shutdownPromise = performShutdown(signal);
    return shutdownPromise;
  }

  function destroyLateClientIfNeeded(client, label, shouldDestroy) {
    if (!shouldDestroy || !client) return;

    if (client.isOpen || client.isReady) {
      destroyClient(client, logger, label, true);
    }
  }

  async function connectSharedRedis() {
    sharedConnectPending = true;

    let connectionResult;
    try {
      // connectRedis() creates its shared client synchronously before returning
      // its promise, so retain this exact object for late-settlement cleanup.
      connectionResult = redisManager.connectRedis();
      sharedClientForAttempt = redisManager.client;
    } catch (error) {
      sharedConnectPending = false;
      throw error;
    }

    const connectionPromise = Promise.resolve(connectionResult);
    connectionPromise.catch(() => {});

    void connectionPromise.then(
      () => {
        sharedConnectPending = false;
        destroyLateClientIfNeeded(
          sharedClientForAttempt,
          "Shared Redis",
          sharedConnectTimedOut || lifecycleState !== "starting",
        );
      },
      () => {
        sharedConnectPending = false;
        destroyLateClientIfNeeded(
          sharedClientForAttempt,
          "Shared Redis",
          sharedConnectTimedOut || lifecycleState !== "starting",
        );
      },
    );

    let connected;
    try {
      connected = await withTimeout(
        () => connectionPromise,
        sharedRedisConnectTimeoutMs,
        "Timed out connecting the shared Redis client",
      );
    } catch (error) {
      sharedConnectTimedOut = error.code === "WORKER_OPERATION_TIMEOUT";
      if (sharedConnectTimedOut) {
        const timeoutError = createStartupTimeoutError(
          "shared",
          sharedRedisConnectTimeoutMs,
        );
        throw timeoutError;
      }
      throw error;
    }

    sharedConnectPending = false;
    assertStartupActive();

    if (!connected || !redisManager.client) {
      throw new Error("Redis is unavailable");
    }

    return true;
  }

  async function connectDedicatedRedis() {
    assertStartupActive();

    rawClient = redisManager.client.duplicate();
    rawClient.on("error", (error) => {
      logger.error("[Order Worker] Redis error:", error.message);
    });

    dedicatedConnectPending = true;

    let connectionResult;
    try {
      connectionResult = rawClient.connect();
    } catch (error) {
      dedicatedConnectPending = false;
      throw error;
    }

    const connectionPromise = Promise.resolve(connectionResult);
    connectionPromise.catch(() => {});

    void connectionPromise.then(
      () => {
        dedicatedConnectPending = false;
        destroyLateClientIfNeeded(
          rawClient,
          "Dedicated Redis",
          dedicatedConnectTimedOut || lifecycleState !== "starting",
        );
      },
      () => {
        dedicatedConnectPending = false;
        destroyLateClientIfNeeded(
          rawClient,
          "Dedicated Redis",
          dedicatedConnectTimedOut || lifecycleState !== "starting",
        );
      },
    );

    try {
      await withTimeout(
        () => connectionPromise,
        dedicatedRedisConnectTimeoutMs,
        "Timed out connecting the dedicated worker Redis client",
      );
    } catch (error) {
      dedicatedConnectTimedOut = error.code === "WORKER_OPERATION_TIMEOUT";
      if (dedicatedConnectTimedOut) {
        const timeoutError = createStartupTimeoutError(
          "dedicated worker",
          dedicatedRedisConnectTimeoutMs,
        );
        throw timeoutError;
      }
      throw error;
    }

    dedicatedConnectPending = false;
    assertStartupActive();

    if (!rawClient.isReady) {
      throw new Error("Dedicated worker Redis connection is not ready");
    }
  }

  try {
    assertStartupActive();
    await connectSharedRedis();
    assertStartupActive();

    await connectDedicatedRedis();
    assertStartupActive();

    const connection = createRedisConnection(rawClient);
    const processReceipt = createReceiptProcessor();
    assertStartupActive();

    worker = new WorkerClass(
      ORDER_QUEUE_NAME,
      async (job) => {
        if (job.name !== ORDER_RECEIPT_JOB) {
          throw new Error("Unsupported job: " + job.name);
        }

        return runReceiptProcessor(job, processReceipt);
      },
      {
        connection,
        concurrency: 5,
      },
    );

    worker.on("completed", (job) => {
      logger.info("[Order Worker] Job " + job.id + " completed.");
    });

    worker.on("failed", (job, error) => {
      logger.error(
        "[Order Worker] Job " + (job?.id || "unknown") + " failed:",
        error.message,
      );
    });

    worker.on("error", (error) => {
      logger.error("[Order Worker] Error:", error.message);
    });

    // No await occurs between the last state check, construction, listener
    // registration, and transition to running, so a signal cannot interleave.
    assertStartupActive();
    lifecycleState = "running";
    logger.info("[Order Worker] Started successfully.");

    return {
      worker,
      shutdown,
      get activeProcessorCount() {
        return activeProcessorIds.size;
      },
      get lifecycleState() {
        return lifecycleState;
      },
    };
  } catch (error) {
    try {
      await shutdown("startup failure");
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
  SHARED_REDIS_CONNECT_TIMEOUT_MS,
  DEDICATED_REDIS_CONNECT_TIMEOUT_MS,
};