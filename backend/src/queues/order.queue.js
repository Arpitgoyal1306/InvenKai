const { Queue, createNodeRedisClient } = require("bullmq");
const redis = require("../config/redis");

const ORDER_QUEUE_NAME = "order-follow-up";
const ORDER_RECEIPT_JOB = "process-order";
const QUEUE_CLOSE_TIMEOUT_MS = 3000;
const REDIS_CONNECT_TIMEOUT_MS = 4000;
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

function createDedicatedClientLifecycle(rawClient) {
  let destroyInFlight = null;
  let destroyedWhileClosed = false;

  // A destroy is issued once for each live socket. If a connect operation
  // unusually completes after the first destroy and reopens the client, the
  // late-settlement handler can destroy that newly-open socket as well.
  function destroy() {
    if (destroyInFlight) return destroyInFlight;

    if (destroyedWhileClosed && !rawClient.isOpen && !rawClient.isReady) {
      return Promise.resolve();
    }

    destroyInFlight = Promise.resolve()
      .then(() => {
        if (typeof rawClient.destroy === "function") {
          rawClient.destroy();
        } else if (typeof rawClient.disconnect === "function") {
          return rawClient.disconnect();
        }
      })
      .finally(() => {
        destroyedWhileClosed = !rawClient.isOpen && !rawClient.isReady;
        destroyInFlight = null;
      });

    return destroyInFlight;
  }

  async function close() {
    if (!rawClient.isOpen) return;

    if (!rawClient.isReady || typeof rawClient.close !== "function") {
      await destroy();
      return;
    }

    try {
      await withTimeout(
        Promise.resolve().then(() => rawClient.close()),
        REDIS_CLOSE_TIMEOUT_MS,
        "Timed out closing the dedicated queue Redis client",
      );
    } catch {
      if (rawClient.isOpen || rawClient.isReady) {
        await destroy();
      }
    }

    if (rawClient.isOpen || rawClient.isReady) {
      await destroy();
    }
  }

  return { destroy, close };
}

async function createOrderQueue({
  QueueClass = Queue,
  redisManager = redis,
  createRedisConnection = createNodeRedisClient,
  connectionTimeoutMs = REDIS_CONNECT_TIMEOUT_MS,
} = {}) {
  if (!redisManager.client || !redisManager.isRedisReady()) {
    throw new Error("Redis is not ready");
  }

  const rawClient = redisManager.client.duplicate();
  const clientLifecycle = createDedicatedClientLifecycle(rawClient);

  rawClient.on("error", (error) => {
    console.error("[Order Queue] Redis error:", error.message);
  });

  let connectTimedOut = false;

  const connectPromise = Promise.resolve().then(() => rawClient.connect());
  // A timeout does not cancel a promise. Attach a handler now, then inspect
  // the socket again if the connect operation settles after our timeout.
  connectPromise.catch(() => {});
  connectPromise.then(
    () => {
      if (connectTimedOut && (rawClient.isOpen || rawClient.isReady)) {
        void clientLifecycle.destroy().catch((error) => {
          console.error("[Order Queue] Late Redis connection cleanup failed:", error.message);
        });
      }
    },
    () => {
      if (connectTimedOut && (rawClient.isOpen || rawClient.isReady)) {
        void clientLifecycle.destroy().catch((error) => {
          console.error("[Order Queue] Late Redis connection cleanup failed:", error.message);
        });
      }
    },
  );

  try {
    try {
      await withTimeout(
        connectPromise,
        connectionTimeoutMs,
        "Timed out connecting the dedicated queue Redis client",
      );
    } catch (error) {
      connectTimedOut = error.message.includes("Timed out connecting");
      await clientLifecycle.destroy().catch((cleanupError) => {
        console.error("[Order Queue] Redis connection cleanup failed:", cleanupError.message);
      });
      throw error;
    }

    // Cover the narrow race where connect resolved at the timeout boundary.
    if (connectTimedOut) {
      await clientLifecycle.destroy();
      throw new Error("Dedicated queue Redis connection timed out");
    }

    const connection = createRedisConnection(rawClient);
    const queue = new QueueClass(ORDER_QUEUE_NAME, {
      connection,
      defaultJobOptions,
    });

    async function enqueueOrderReceipt(orderId) {
      return queue.add(
        ORDER_RECEIPT_JOB,
        { orderId: String(orderId) },
        { jobId: "order-" + orderId },
      );
    }

    let closePromise = null;
    function close() {
      if (closePromise) return closePromise;

      closePromise = (async () => {
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
          await clientLifecycle.close();
        }

        if (closeError) throw closeError;
      })();

      return closePromise;
    }

    return { queue, enqueueOrderReceipt, close };
  } catch (error) {
    await clientLifecycle.destroy().catch((cleanupError) => {
      console.error("[Order Queue] Dedicated Redis cleanup failed:", cleanupError.message);
    });
    throw error;
  }
}

module.exports = {
  ORDER_QUEUE_NAME,
  ORDER_RECEIPT_JOB,
  defaultJobOptions,
  createOrderQueue,
  withTimeout,
  REDIS_CONNECT_TIMEOUT_MS,
  createDedicatedClientLifecycle,
};