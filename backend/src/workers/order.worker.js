
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

async function startOrderWorker({
  redisManager = redis,
  db = pool,
  WorkerClass = Worker,
  createReceiptProcessor = createOrderReceiptProcessor,
  createRedisConnection = createNodeRedisClient,
  logger = console,
  registerSignals = true,
} = {}) {
  let rawClient;
  let worker;
  let closing = false;

  try {
    // Connect the shared Redis manager.
    const connected = await redisManager.connectRedis();

    if (!connected || !redisManager.client) {
      throw new Error("Redis is unavailable");
    }

    // Create a dedicated Redis connection for BullMQ.
    rawClient = redisManager.client.duplicate();

    rawClient.on("error", (error) => {
      logger.error("[Order Worker] Redis error:", error.message);
    });

    await rawClient.connect();

    // Create BullMQ-compatible Redis connection.
    const connection = createRedisConnection(rawClient);

    // Create receipt processor.
    const processReceipt = createReceiptProcessor();

    // Start the BullMQ worker.
    worker = new WorkerClass(
      ORDER_QUEUE_NAME,
      async (job) => {
        if (job.name !== ORDER_RECEIPT_JOB) {
          throw new Error(`Unsupported job: ${job.name}`);
        }

        return processReceipt(job);
      },
      {
        connection,
        concurrency: 5,
      },
    );

    // Worker event listeners.
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

    // Graceful shutdown.
    async function shutdown(signal = "shutdown") {
      if (closing) return;

      closing = true;

      logger.info(`[Order Worker] ${signal}; closing...`);

      try {
        if (worker) {
          await worker.close();
        }
      } finally {
        try {
          await redisManager.closeRedis();
        } finally {
          await db.end();
        }
      }
    }

    // Register shutdown handlers.
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
    };
  } catch (error) {
    // Clean up the dedicated Redis connection if startup fails.
    if (rawClient) {
      rawClient.destroy();
    }

    // Clean up the shared Redis connection if startup fails.
    try {
      await redisManager.closeRedis();
    } catch (cleanupError) {
      logger.error(
        "[Order Worker] Redis cleanup failed:",
        cleanupError.message,
      );
    }

    throw error;
  }
}

// Start worker when executed directly.
if (require.main === module) {
  startOrderWorker().catch(async (error) => {
    console.error("[Order Worker] Startup failed:", error.message);

    try {
      await redis.closeRedis();
    } finally {
      await pool.end();
    }

    process.exitCode = 1;
  });
}

module.exports = { startOrderWorker };
