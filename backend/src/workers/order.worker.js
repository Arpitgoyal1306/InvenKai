require("dotenv").config();

const { Worker, createNodeRedisClient } = require("bullmq");
const pool = require("../config/database");
const redis = require("../config/redis");
const { ORDER_QUEUE_NAME, ORDER_RECEIPT_JOB } = require("../queues/order.queue");
const { createOrderReceiptProcessor } = require("./order-receipt.processor");

async function startOrderWorker() {
  const connected = await redis.connectRedis();
  if (!connected || !redis.client) throw new Error("Redis is unavailable");

  const rawClient = redis.client.duplicate();
  rawClient.on("error", (error) => console.error("[Order Worker] Redis error:", error.message));
  await rawClient.connect();
  const connection = createNodeRedisClient(rawClient);
  const processReceipt = createOrderReceiptProcessor();

  const worker = new Worker(
    ORDER_QUEUE_NAME,
    async (job) => {
      if (job.name !== ORDER_RECEIPT_JOB) throw new Error(`Unsupported job: ${job.name}`);
      return processReceipt(job);
    },
    { connection, concurrency: 5 },
  );

  worker.on("completed", (job) => console.info(`[Order Worker] Job ${job.id} completed.`));
  worker.on("failed", (job, error) => console.error(
    `[Order Worker] Job ${job?.id || "unknown"} failed:`, error.message,
  ));
  worker.on("error", (error) => console.error("[Order Worker] Error:", error.message));

  let closing = false;
  async function shutdown(signal = "shutdown") {
    if (closing) return;
    closing = true;
    console.info(`[Order Worker] ${signal}; closing...`);
    await worker.close();
    if (typeof connection.quit === "function") await connection.quit();
    else if (typeof connection.disconnect === "function") connection.disconnect();
    await redis.closeRedis();
    await pool.end();
  }
  process.once("SIGINT", () => void shutdown("SIGINT").catch(console.error));
  process.once("SIGTERM", () => void shutdown("SIGTERM").catch(console.error));
  return { worker, shutdown };
}

if (require.main === module) {
  startOrderWorker().catch(async (error) => {
    console.error("[Order Worker] Startup failed:", error.message);
    await redis.closeRedis();
    await pool.end();
    process.exitCode = 1;
  });
}

module.exports = { startOrderWorker };
