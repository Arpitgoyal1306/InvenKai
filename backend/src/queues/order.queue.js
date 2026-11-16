const { Queue, createNodeRedisClient } = require("bullmq");
const redis = require("../config/redis");

const ORDER_QUEUE_NAME = "order-follow-up";
const ORDER_RECEIPT_JOB = "process-order";

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: false,
};

async function createOrderQueue({ QueueClass = Queue } = {}) {
  if (!redis.client || !redis.isRedisReady()) {
    throw new Error("Redis is not ready");
  }

  // Duplicate the shared publisher. BullMQ's adapter uses duplicate()
  // internally for blocking commands; it must not use the Pub/Sub subscriber.
  const rawClient = redis.client.duplicate();
  rawClient.on("error", (error) => {
    console.error("[Order Queue] Redis error:", error.message);
  });
  await rawClient.connect();

  const connection = createNodeRedisClient(rawClient);
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
    await queue.close();
    // Close the adapter-owned duplicate only; the shared publisher remains
    // available to the API and inventory event publisher.
    if (typeof connection.quit === "function") await connection.quit();
    else if (typeof connection.disconnect === "function") connection.disconnect();
  }

  return { queue, enqueueOrderReceipt, close };
}

module.exports = {
  ORDER_QUEUE_NAME,
  ORDER_RECEIPT_JOB,
  defaultJobOptions,
  createOrderQueue,
};
