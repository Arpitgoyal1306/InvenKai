const app = require("./src/app");
const pool = require("./src/config/database");
const { connectRedis, closeRedis } = require("./src/config/redis");

const PORT = process.env.PORT || 5001;

let httpServer = null;
let isShuttingDown = false;

async function startServer() {
  try {
    // PostgreSQL is mandatory.
    await pool.query("SELECT NOW()");

    console.log("PostgreSQL connected successfully");

    httpServer = app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);

      // Redis is optional. Do not block HTTP startup.
      void connectRedis();
    });

    httpServer.on("error", (error) => {
      console.error("HTTP server error:", error.message);
      process.exitCode = 1;
      void shutdown("HTTP server error");
    });
  } catch (error) {
    console.error("Database connection failed:", error.message);

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

  // Stop accepting new HTTP requests and wait for active requests.
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

  // Close Redis, even if HTTP shutdown encountered an error.
  try {
    await closeRedis();
    console.log("Redis connection closed.");
  } catch (error) {
    console.error("Redis shutdown failed:", error.message);
    process.exitCode = 1;
  }

  // PostgreSQL must also be closed.
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
