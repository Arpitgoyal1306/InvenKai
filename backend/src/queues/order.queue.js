const { Queue, createNodeRedisClient } = require("bullmq");
const redis = require("../config/redis");

const ORDER_QUEUE_NAME = "order-follow-up";
const ORDER_RECEIPT_JOB = "process-order";

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
        {
          orderId: String(orderId),
        },
        {
          jobId: `order-${orderId}`,
        },
      );
    }

    async function close() {
      try {
        // BullMQ Queue.close() closes the adapted connection.
        await queue.close();
      } finally {
        // The duplicated node-redis client belongs to this queue. Close it
        // explicitly only if the adapter left the underlying socket open.
        if (rawClient.isOpen) {
          if (rawClient.isReady && typeof rawClient.close === "function") {
            await rawClient.close();
          } else if (typeof rawClient.destroy === "function") {
            rawClient.destroy();
          }
        }
      }
    }

    return {
      queue,
      enqueueOrderReceipt,
      close,
    };
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
