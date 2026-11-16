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

async function closeDedicatedRedisClient(rawClient) {
  if (!rawClient || !rawClient.isOpen) return;

  if (rawClient.isReady && typeof rawClient.close === "function") {
    await rawClient.close();
  } else if (typeof rawClient.destroy === "function") {
    rawClient.destroy();
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
} = {}) {
  let rawClient;
  let worker;
  let closing = false;

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

        return processReceipt(job);
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
          await closeDedicatedRedisClient(rawClient);
        } finally {
          try {
            await redisManager.closeRedis();
          } finally {
            await db.end();
          }
        }
      }
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
    };
  } catch (error) {
    if (rawClient && rawClient.isOpen && typeof rawClient.destroy === "function") {
      rawClient.destroy();
    }

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
