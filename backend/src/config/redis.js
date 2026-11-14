const { createClient } = require("redis");
require("dotenv").config();

function createRedisManager({
  url = process.env.REDIS_URL,
  createClientFn = createClient,
  logger = console,
} = {}) {
  let client = null;
  let connectPromise = null;
  let closePromise = null;

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

    if (closePromise) {
      return closePromise.then(() => connectRedis());
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

    const currentClient = client;

    let attempt;

    attempt = (async () => {
      try {
        await currentClient.connect();

        // Ignore a connection that completed after shutdown/replacement.
        if (client !== currentClient) {
          if (currentClient.isOpen) {
            currentClient.destroy();
          }

          return false;
        }

        return currentClient.isReady === true;
      } catch (error) {
        logger.error("[Redis] Initial connection failed:", error.message);

        return false;
      } finally {
        if (connectPromise === attempt) {
          connectPromise = null;
        }
      }
    })();

    connectPromise = attempt;

    return attempt;
  }

  function closeRedis() {
    if (closePromise) {
      return closePromise;
    }

    const currentClient = client;
    const pendingConnection = connectPromise;

    client = null;
    connectPromise = null;

    if (!currentClient) {
      return Promise.resolve();
    }

    closePromise = (async () => {
      try {
        if (pendingConnection) {
          // Abort a connection attempt that has not settled yet.
          currentClient.destroy();
        } else if (currentClient.isOpen && currentClient.isReady) {
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

      if (pendingConnection) {
        await pendingConnection.catch(() => false);
      }
    })().finally(() => {
      closePromise = null;
    });

    return closePromise;
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
