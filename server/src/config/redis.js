const { createClient } = require("redis");
require("dotenv").config();

function redisEndpoint(value) {
  const { hostname, port } = new URL(value);
  return hostname.toLowerCase() + ":" + (port || "6379");
}

async function verifySeparateInstance(appUrl, testClient) {
  const appClient = createClient({
    url: appUrl,
    socket: { connectTimeout: 3000, reconnectStrategy: false },
  });
  appClient.on("error", () => {}); // Connection and command errors reject below.
  try {
    await appClient.connect();
    const signal = AbortSignal.timeout(3000);
    const ids = await Promise.all([appClient, testClient].map(async client => {
      const info = await client.withAbortSignal(signal).info("server");
      const id = /^run_id:([a-f0-9]{40})\r?$/m.exec(info)?.[1];
      if (!id) throw new Error("Redis INFO SERVER did not return an instance ID");
      return id;
    }));
    if (ids[0] === ids[1]) throw new Error("Application and test URLs point to the same Redis instance");
  } finally {
    if (appClient.isOpen) appClient.destroy();
  }
}

function createRedisManager({
  url = process.env.NODE_ENV === "test" ? process.env.TEST_REDIS_URL : process.env.REDIS_URL,
  createClientFn = createClient,
  logger = console,
} = {}) {
  const verifyIsolation = process.env.NODE_ENV === "test" && url && url === process.env.TEST_REDIS_URL;
  const appUrl = process.env.REDIS_URL;
  if (verifyIsolation) {
    if (!appUrl) throw new Error("REDIS_URL is required to verify test Redis isolation");
    if (redisEndpoint(url) === redisEndpoint(appUrl)) {
      throw new Error("Application and test URLs point to the same Redis endpoint; use separate instances");
    }
  }
  let verifiedClient = null;
  let client = null;
  let connectPromise = null;
  let closePromise = null;

  function isRedisReady() {
    return client?.isReady === true && (!verifyIsolation || verifiedClient === client);
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
      } catch (error) {
        logger.error("[Redis] Initial connection failed:", error.message);
        return false;
      }

      // Ignore a connection that completed after shutdown/replacement.
      if (client !== currentClient) {
        if (currentClient.isOpen) {
          currentClient.destroy();
        }

        return false;
      }

      if (verifyIsolation) {
        try {
          await verifySeparateInstance(appUrl, currentClient);
          if (client !== currentClient) return false;
          verifiedClient = currentClient;
        } catch (cause) {
          if (currentClient.isOpen) currentClient.destroy();
          if (client === currentClient) client = null;
          throw new Error("Test Redis isolation check failed", { cause });
        }
      }
      return currentClient.isReady === true;
    })().finally(() => {
      if (connectPromise === attempt) connectPromise = null;
    });

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
    verifiedClient = null;
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

      // Do not await the original connect promise here. With automatic
      // reconnection enabled, some failed initial connections can remain
      // pending even after destroy() has closed the socket. Waiting for that
      // promise would make shutdown hang. The connection attempt handles its
      // own eventual rejection and cannot replace this closed client.
    })().finally(() => {
      closePromise = null;
    });

    return closePromise;
  }

  return {
    get client() {
      return verifyIsolation && verifiedClient !== client ? null : client;
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
