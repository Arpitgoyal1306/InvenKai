
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
      await queue.close();
    }

    return {
      queue,
      enqueueOrderReceipt,
      close,
    };
  } catch (error) {
    rawClient.destroy();
    throw error;
  }
}

module.exports = {
  ORDER_QUEUE_NAME,
  ORDER_RECEIPT_JOB,
  defaultJobOptions,
  createOrderQueue,
};
