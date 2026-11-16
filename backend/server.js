const http = require("node:http");

const app = require("./src/app");
const pool = require("./src/config/database");
const redis = require("./src/config/redis");

const { connectRedis, closeRedis } = redis;
const { createWebSocketService } = require("./src/services/websocket.service");

const PORT = process.env.PORT || 5001;

let httpServer = null;
let isShuttingDown = false;
let redisInitializationPromise = null;

const websocketService = createWebSocketService();

function initializeRedisFeatures() {
  if (isShuttingDown) {
    return Promise.resolve(false);
  }

  if (redisInitializationPromise) {
    return redisInitializationPromise;
  }

  redisInitializationPromise = (async () => {
    try {
      const connected = await connectRedis();

      // Shutdown may have started while Redis was connecting.
      if (isShuttingDown) {
        return false;
      }

      // No REDIS_URL means no client exists.
      if (!redis.client) {
        console.warn(
          "[WebSocket] Redis unavailable. Live inventory updates are disabled.",
        );
        return false;
      }

      // Start the subscriber even if the initial connection failed.
      // It can attach to publisher ready/end events and retry.
      const subscriberStarted = await websocketService.startSubscriber();

      if (!connected) {
        console.warn(
          "[WebSocket] Redis is not ready. Waiting for connection recovery.",
        );
      }

      if (!subscriberStarted) {
        console.warn(
          "[WebSocket] Subscriber is not ready. Automatic recovery is enabled.",
        );
      }

      return subscriberStarted;
    } catch (error) {
      console.error("[WebSocket] Redis initialization failed:", error.message);

      return false;
    } finally {
      redisInitializationPromise = null;
    }
  })();

  return redisInitializationPromise;
}

async function startServer() {
  try {
    // PostgreSQL is mandatory.
    await pool.query("SELECT NOW()");

    if (isShuttingDown) {
      return;
    }

    console.log("PostgreSQL connected successfully");

    httpServer = http.createServer(app);

    websocketService.attach(httpServer);

    httpServer.on("error", (error) => {
      console.error("HTTP server error:", error.message);
      process.exitCode = 1;
      void shutdown("HTTP server error");
    });

    httpServer.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);

      // HTTP remains available even if Redis is unavailable.
      void initializeRedisFeatures();
    });
  } catch (error) {
    console.error("Database connection failed:", error.message);

    try {
      await websocketService.close();
    } catch (shutdownError) {
      console.error("WebSocket shutdown failed:", shutdownError.message);
    }

    try {
      await closeRedis();
    } catch (shutdownError) {
      console.error("Redis shutdown failed:", shutdownError.message);
    }

    try {
      await pool.end();
    } catch (shutdownError) {
      console.error("PostgreSQL shutdown failed:", shutdownError.message);
    }

    process.exitCode = 1;
  }
}

async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  console.log(`\n${signal} received. Shutting down gracefully...`);

  // Stop WebSocket upgrades, clients, retries and subscriber activity.
  try {
    await websocketService.close();
    console.log("WebSocket service closed.");
  } catch (error) {
    console.error("WebSocket shutdown failed:", error.message);
    process.exitCode = 1;
  }

  // Stop accepting new HTTP connections and wait for active requests.
  if (httpServer?.listening) {
    await new Promise((resolve) => {
      httpServer.close((error) => {
        if (error) {
          console.error("HTTP server shutdown failed:", error.message);
          process.exitCode = 1;
        } else {
          console.log("HTTP server closed.");
        }

        resolve();
      });
    });
  }

  // Destroy or close the shared Redis connection.
  try {
    await closeRedis();
    console.log("Redis connection closed.");
  } catch (error) {
    console.error("Redis shutdown failed:", error.message);
    process.exitCode = 1;
  }

  // Wait for the initialization flow to observe shutdown and settle.
  if (redisInitializationPromise) {
    try {
      await redisInitializationPromise;
    } catch (error) {
      console.error("Redis initialization cleanup failed:", error.message);
      process.exitCode = 1;
    }
  }

  try {
    await pool.end();
    console.log("PostgreSQL connection pool closed.");
  } catch (error) {
    console.error("PostgreSQL shutdown failed:", error.message);
    process.exitCode = 1;
  }

  console.log("Shutdown complete.");
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

startServer();
