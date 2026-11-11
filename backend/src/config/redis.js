const { createClient } = require("redis");
require("dotenv").config();

function createRedisManager({
  url = process.env.REDIS_URL,
  createClientFn = createClient,
  logger = console,
} = {}) {
  let client = null;
  let connectPromise = null;

  function isRedisReady() {
    return client?.isReady === true;
  }

  function connectRedis() {
    if (!url) {
      logger.warn(
        "[Redis] REDIS_URL is not configured. Continuing without Redis.",
      );
      return Promise.resolve(false);
    }

    if (isRedisReady()) {
      return Promise.resolve(true);
    }

    if (connectPromise) {
      return connectPromise;
    }

    try {
      if (!client) {
        client = createClientFn({
          url,
          socket: {
            reconnectStrategy(retries) {
              const delay = Math.min(1000 * 2 ** retries, 30000);

              logger.warn(
                `[Redis] Reconnecting in ${delay}ms (attempt ${retries + 1})`,
              );

              return delay;
            },
          },
        });

        client.on("error", (error) => {
          logger.error("[Redis] Client error:", error.message);
        });

        client.on("ready", () => {
          logger.info("[Redis] Connected and ready.");
        });

        client.on("reconnecting", () => {
          logger.warn("[Redis] Reconnecting...");
        });

        client.on("end", () => {
          logger.warn("[Redis] Connection closed.");
        });
      }
    } catch (error) {
      logger.error("[Redis] Client initialization failed:", error.message);
      client = null;
      return Promise.resolve(false);
    }

    connectPromise = client
      .connect()
      .then(() => {
        logger.info("[Redis] Connection established.");
        return true;
      })
      .catch((error) => {
        logger.error("[Redis] Initial connection failed:", error.message);
        return false;
      })
      .finally(() => {
        connectPromise = null;
      });

    return connectPromise;
  }

  async function closeRedis() {
    if (!client) {
      return;
    }

    const currentClient = client;
    client = null;
    connectPromise = null;

    try {
      if (currentClient.isOpen && currentClient.isReady) {
        await currentClient.close();
      } else if (currentClient.isOpen) {
        currentClient.destroy();
      }
    } catch (error) {
      logger.error("[Redis] Error during shutdown:", error.message);

      if (currentClient.isOpen) {
        currentClient.destroy();
      }
    }
  }

  return {
    get client() {
      return client;
    },
    connectRedis,
    isRedisReady,
    closeRedis,
  };
}

const redisManager = createRedisManager();

module.exports = {
  get client() {
    return redisManager.client;
  },
  connectRedis: redisManager.connectRedis,
  isRedisReady: redisManager.isRedisReady,
  closeRedis: redisManager.closeRedis,
  createRedisManager,
};
