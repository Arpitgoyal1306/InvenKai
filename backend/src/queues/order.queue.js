const { Queue, createNodeRedisClient } = require("bullmq");
const redis = require("../config/redis");

const ORDER_QUEUE_NAME = "order-follow-up";
const ORDER_RECEIPT_JOB = "process-order";
const QUEUE_CLOSE_TIMEOUT_MS = 3000;
const REDIS_CLOSE_TIMEOUT_MS = 1500;

const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 2000,
  },
  removeOnComplete: {
    count: 1000,
  },
  removeOnFail: false,
};

function withTimeout(promise, timeoutMs, message) {
  let timer;

  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function closeDedicatedClient(rawClient) {
  if (!rawClient || !rawClient.isOpen) return;

  if (!rawClient.isReady || typeof rawClient.close !== "function") {
    rawClient.destroy?.();
    return;
  }

  try {
    await withTimeout(
      rawClient.close(),
      REDIS_CLOSE_TIMEOUT_MS,
      "Timed out closing the dedicated queue Redis client",
    );
  } catch {
    if (rawClient.isOpen) rawClient.destroy?.();
  }

  if (rawClient.isOpen) rawClient.destroy?.();
}

async function createOrderQueue({
  QueueClass = Queue,
  redisManager = redis,
  createRedisConnection = createNodeRedisClient,
} = {}) {
  if (!redisManager.client || !redisManager.isRedisReady()) {
    throw new Error("Redis is not ready");
  }

  const rawClient = redisManager.client.duplicate();

  rawClient.on("error", (error) => {
    console.error("[Order Queue] Redis error:", error.message);
  });

  try {
    await rawClient.connect();

    const connection = createRedisConnection(rawClient);

    const queue = new QueueClass(ORDER_QUEUE_NAME, {
      connection,
      defaultJobOptions,
    });

    async function enqueueOrderReceipt(orderId) {
      return queue.add(
        ORDER_RECEIPT_JOB,
        { orderId: String(orderId) },
        { jobId: `order-${orderId}` },
      );
    }

    async function close() {
      let closeError;

      // Attach a rejection handler before racing the timeout so a late
      // BullMQ rejection cannot become an unhandled promise rejection.
      const queueClosePromise = Promise.resolve().then(() => queue.close());
      queueClosePromise.catch(() => {});

      try {
        await withTimeout(
          queueClosePromise,
          QUEUE_CLOSE_TIMEOUT_MS,
          "Timed out closing the BullMQ order queue",
        );
      } catch (error) {
        closeError = error;
      } finally {
        await closeDedicatedClient(rawClient);
      }

      if (closeError) throw closeError;
    }

    return { queue, enqueueOrderReceipt, close };
  } catch (error) {
    if (rawClient.isOpen && typeof rawClient.destroy === "function") {
      rawClient.destroy();
    }
    throw error;
  }
}

module.exports = {
  ORDER_QUEUE_NAME,
  ORDER_RECEIPT_JOB,
  defaultJobOptions,
  createOrderQueue,
};
