const http = require("node:http");
const marketLive = require("./src/services/market-live.service");

const app = require("./src/app");
const pool = require("./src/config/database");
const redis = require("./src/config/redis");

const { createWebSocketService } = require("./src/services/websocket.service");

const PORT = process.env.PORT || 5001;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

function createServerManager({
  port = PORT,
  db = pool,
  redisManager = redis,
  app: expressApp = app,
  httpModule = http,
  createWebSocketService: createWsService = createWebSocketService,
  websocketService: wsService,
  logger = console,
  setExitCode = (code) => {
    process.exitCode = code;
  },
  terminateProcess = null,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  startupTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  redisInitTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  websocketShutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  httpShutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  redisCloseTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  dbShutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
} = {}) {
  let httpServer = null;
  let startPromise = null;
  let shutdownPromise = null;
  let isShuttingDown = false;
  let redisInitializationPromise = null;
  let pendingListenCancel = null;
  let pendingRedisCancel = null;
  let dbClosed = false;

  const websocketService = wsService || createWsService();

  function initializeRedisFeatures() {
    if (isShuttingDown) {
      return Promise.resolve(false);
    }

    if (redisInitializationPromise) {
      return redisInitializationPromise;
    }

    let cancelPromise;
    const cancelPromiseInstance = new Promise((resolve) => {
      cancelPromise = resolve;
    });
    pendingRedisCancel = cancelPromise;

    redisInitializationPromise = (async () => {
      try {
        const connectOperation = Promise.resolve().then(() => redisManager.connectRedis());

        // If the connection succeeds later (e.g. after cancellation), ensure it is closed if shutting down
        connectOperation.then(async (connected) => {
          if (isShuttingDown && connected) {
            try {
              await redisManager.closeRedis();
            } catch {}
          }
        }).catch(() => {});

        const connected = await Promise.race([
          connectOperation,
          cancelPromiseInstance.then(() => false),
        ]);

        // Shutdown may have started while Redis was connecting.
        if (isShuttingDown) {
          try {
            let closeTimer = null;
            await Promise.race([
              redisManager.closeRedis(),
              new Promise((resolve) => {
                closeTimer = setTimeoutFn(resolve, redisCloseTimeoutMs);
                closeTimer?.unref?.();
              }),
            ]);
            if (closeTimer !== null) {
              clearTimeoutFn(closeTimer);
            }
          } catch (closeError) {
            logger.error("Redis shutdown cleanup failed:", closeError.message);
          }
          return false;
        }

        // No REDIS_URL means no client exists.
        if (!redisManager.client) {
          logger.warn(
            "[WebSocket] Redis unavailable. Live inventory updates are disabled.",
          );
          return false;
        }

        // Start the subscriber even if the initial connection failed.
        // It can attach to publisher ready/end events and retry.
        const subscriberOperation = Promise.resolve().then(() => websocketService.startSubscriber());

        const subscriberStarted = await Promise.race([
          subscriberOperation,
          cancelPromiseInstance.then(() => false),
        ]);

        // Shutdown may have started while the subscriber was starting.
        if (isShuttingDown) {
          try {
            let closeTimer = null;
            await Promise.race([
              redisManager.closeRedis(),
              new Promise((resolve) => {
                closeTimer = setTimeoutFn(resolve, redisCloseTimeoutMs);
                closeTimer?.unref?.();
              }),
            ]);
            if (closeTimer !== null) {
              clearTimeoutFn(closeTimer);
            }
          } catch {}
          return false;
        }

        if (!connected) {
          logger.warn(
            "[WebSocket] Redis is not ready. Waiting for connection recovery.",
          );
        }

        if (!subscriberStarted) {
          logger.warn(
            "[WebSocket] Subscriber is not ready. Automatic recovery is enabled.",
          );
        }

        return subscriberStarted;
      } catch (error) {
        logger.error("[WebSocket] Redis initialization failed:", error.message);

        return false;
      } finally {
        pendingRedisCancel = null;
        redisInitializationPromise = null;
      }
    })();

    return redisInitializationPromise;
  }

  async function closeHttpServer(server) {
    if (!server) return;
    await new Promise((resolve) => {
      if (!server.listening && typeof server.close !== "function") {
        resolve();
        return;
      }
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  async function startServer() {
    if (isShuttingDown) {
      return null;
    }

    if (httpServer) {
      return httpServer;
    }

    if (startPromise) {
      return startPromise;
    }

    startPromise = (async () => {
      let serverCreated = null;

      try {
        // PostgreSQL is mandatory.
        await db.query("SELECT NOW()");

        if (isShuttingDown) {
          return null;
        }

        logger.log("PostgreSQL connected successfully");

        const server = httpModule.createServer(expressApp);
        serverCreated = server;

        websocketService.attach(server);

        // Coordinate listen event and error handling during startup
        await new Promise((resolve, reject) => {
          let settled = false;

          function onListening() {
            cleanup();
            resolve();
          }

          function onInitialError(error) {
            cleanup();
            reject(error);
          }

          function onCancel() {
            cleanup();
            resolve();
          }

          function cleanup() {
            if (settled) return;
            settled = true;
            pendingListenCancel = null;
            server.removeListener("listening", onListening);
            server.removeListener("error", onInitialError);
          }

          pendingListenCancel = onCancel;
          server.once("listening", onListening);
          server.once("error", onInitialError);

          try {
            server.listen(port, onListening);
          } catch (syncError) {
            cleanup();
            reject(syncError);
          }
        });

        // Check if shutdown occurred while listen was pending
        if (isShuttingDown) {
          await closeHttpServer(server);
          return null;
        }

        httpServer = server;

        // Register runtime error handler after successful startup
        server.on("error", (error) => {
          if (error.code === "EADDRINUSE") {
            logger.error(
              `Port ${port} is already in use. Ensure no duplicate API server is running.`,
            );
          } else {
            logger.error("HTTP server error:", error.message);
          }
          setExitCode(1);
          void shutdown("HTTP server error");
        });

        logger.log(`Server running on http://localhost:${port}`);

        // HTTP remains available even if Redis is unavailable.
        if (!isShuttingDown) {
          void initializeRedisFeatures();
        }

        return httpServer;
      } catch (error) {
        if (error.code === "EADDRINUSE") {
          logger.error(
            `Port ${port} is already in use. Ensure no duplicate API server is running.`,
          );
        } else if (serverCreated) {
          logger.error("HTTP server error:", error.message);
        } else {
          logger.error("Database connection failed:", error.message);
        }

        if (serverCreated) {
          try {
            await closeHttpServer(serverCreated);
          } catch {}
        }

        try {
          await websocketService.close();
        } catch (shutdownError) {
          logger.error("WebSocket shutdown failed:", shutdownError.message);
        }

        try {
          await redisManager.closeRedis();
        } catch (shutdownError) {
          logger.error("Redis shutdown failed:", shutdownError.message);
        }

        // NOTE: We do NOT close the shared database pool on ordinary startup
        // connection check failure, allowing legitimate retry with the same pool.

        setExitCode(1);
        httpServer = null;
        return null;
      } finally {
        pendingListenCancel = null;
        startPromise = null;
      }
    })();

    return startPromise;
  }

  function shutdown(signal) {
    if (isShuttingDown) {
      return shutdownPromise;
    }

    isShuttingDown = true;

    // 1. Wake up any pending HTTP listen immediately
    if (pendingListenCancel) {
      pendingListenCancel();
    }

    // 2. Interrupt any pending Redis connection/initialization immediately
    if (pendingRedisCancel) {
      pendingRedisCancel();
    }

    let shutdownIncomplete = false;
    let redisCloseFailed = false;

    // 3. Immediately invoke the Redis manager's cancellation/close mechanism
    // so any pending connection socket is destroyed without waiting indefinitely.
    const redisClosePromise = Promise.resolve()
      .then(() => redisManager.closeRedis())
      .catch((error) => {
        redisCloseFailed = true;
        shutdownIncomplete = true;
        logger.error("Redis shutdown failed:", error.message);
        setExitCode(1);
      });

    shutdownPromise = (async () => {
      logger.log(`\n${signal} received. Shutting down gracefully...`);

      // 1. Await in-flight startup so it observes shutdown and settles, bounded by a timeout
      if (startPromise) {
        let startupTimer = null;
        let startupTimedOut = false;
        try {
          await Promise.race([
            startPromise,
            new Promise((resolve) => {
              startupTimer = setTimeoutFn(() => {
                startupTimedOut = true;
                resolve();
              }, startupTimeoutMs);
              startupTimer?.unref?.();
            }),
          ]);
          if (startupTimedOut) {
            shutdownIncomplete = true;
            logger.error(
              "Server startup did not settle before shutdown deadline",
            );
            setExitCode(1);
          }
        } catch (error) {
          shutdownIncomplete = true;
          logger.error("Server startup error during shutdown:", error.message);
          setExitCode(1);
        } finally {
          if (startupTimer !== null) {
            clearTimeoutFn(startupTimer);
            startupTimer = null;
          }
        }
      }

      // 2. Wait for in-flight Redis initialization to observe cancellation and settle
      if (redisInitializationPromise) {
        let redisInitTimer = null;
        try {
          await Promise.race([
            redisInitializationPromise,
            new Promise((resolve) => {
              redisInitTimer = setTimeoutFn(resolve, redisInitTimeoutMs);
              redisInitTimer?.unref?.();
            }),
          ]);
        } catch (error) {
          shutdownIncomplete = true;
          logger.error("Redis initialization cleanup failed:", error.message);
          setExitCode(1);
        } finally {
          if (redisInitTimer !== null) {
            clearTimeoutFn(redisInitTimer);
            redisInitTimer = null;
          }
        }
      }

      // 3. Stop WebSocket upgrades, clients, retries and subscriber activity
      let wsCloseTimer = null;
      let wsCloseTimedOut = false;
      try {
        const wsClosePromise = Promise.resolve().then(() =>
          websocketService.close({ timeoutMs: websocketShutdownTimeoutMs }),
        );
        wsClosePromise.catch(() => {});
        await Promise.race([
          wsClosePromise,
          new Promise((resolve) => {
            wsCloseTimer = setTimeoutFn(() => {
              wsCloseTimedOut = true;
              resolve();
            }, websocketShutdownTimeoutMs);
            wsCloseTimer?.unref?.();
          }),
        ]);

        if (wsCloseTimedOut) {
          shutdownIncomplete = true;
          logger.error("WebSocket shutdown did not settle before deadline");
          setExitCode(1);
        } else {
          logger.log("WebSocket service closed.");
        }
      } catch (error) {
        shutdownIncomplete = true;
        logger.error("WebSocket shutdown failed:", error.message);
        setExitCode(1);
      } finally {
        if (wsCloseTimer !== null) {
          clearTimeoutFn(wsCloseTimer);
          wsCloseTimer = null;
        }
      }

      // 4. Stop accepting new HTTP connections and wait for active requests
      if (httpServer) {
        let httpCloseTimer = null;
        let httpCloseTimedOut = false;
        try {
          const httpCloseOp = new Promise((resolve) => {
            if (!httpServer.listening) {
              resolve();
              return;
            }
            marketLive.close();
            httpServer.close((error) => {
              if (error) {
                shutdownIncomplete = true;
                logger.error("HTTP server shutdown failed:", error.message);
                setExitCode(1);
              } else {
                logger.log("HTTP server closed.");
              }
              resolve();
            });
          });

          // Stop accepting new requests and close idle keep-alive connections
          httpServer.closeIdleConnections?.();

          await Promise.race([
            httpCloseOp,
            new Promise((resolve) => {
              httpCloseTimer = setTimeoutFn(() => {
                httpCloseTimedOut = true;
                resolve();
              }, httpShutdownTimeoutMs);
              httpCloseTimer?.unref?.();
            }),
          ]);

          if (httpCloseTimedOut) {
            shutdownIncomplete = true;
            logger.error(
              "HTTP server shutdown did not settle before deadline; forced connection closure applied",
            );
            setExitCode(1);
            httpServer.closeAllConnections?.();
          }
        } catch (error) {
          shutdownIncomplete = true;
          logger.error("HTTP server shutdown error:", error.message);
          setExitCode(1);
        } finally {
          if (httpCloseTimer !== null) {
            clearTimeoutFn(httpCloseTimer);
            httpCloseTimer = null;
          }
          httpServer = null;
        }
      }

      // 5. Ensure the Redis close initiated at start of shutdown has finished
      let redisCloseTimer = null;
      let redisCloseTimedOut = false;
      try {
        await Promise.race([
          redisClosePromise,
          new Promise((resolve) => {
            redisCloseTimer = setTimeoutFn(() => {
              redisCloseTimedOut = true;
              resolve();
            }, redisCloseTimeoutMs);
            redisCloseTimer?.unref?.();
          }),
        ]);

        if (redisCloseTimedOut) {
          shutdownIncomplete = true;
          logger.error("Redis shutdown did not settle before deadline");
          setExitCode(1);
        } else if (!redisCloseFailed) {
          logger.log("Redis connection closed.");
        }
      } catch (error) {
        shutdownIncomplete = true;
        logger.error("Redis shutdown failed:", error.message);
        setExitCode(1);
      } finally {
        if (redisCloseTimer !== null) {
          clearTimeoutFn(redisCloseTimer);
          redisCloseTimer = null;
        }
      }

      // 6. Terminal shutdown closes the PostgreSQL connection pool exactly once
      if (!dbClosed && db?.end) {
        dbClosed = true;
        let dbEndTimer = null;
        let dbEndTimedOut = false;
        try {
          const dbEndPromise = Promise.resolve().then(() => db.end());
          dbEndPromise.catch(() => {});
          await Promise.race([
            dbEndPromise,
            new Promise((resolve) => {
              dbEndTimer = setTimeoutFn(() => {
                dbEndTimedOut = true;
                resolve();
              }, dbShutdownTimeoutMs);
              dbEndTimer?.unref?.();
            }),
          ]);

          if (dbEndTimedOut) {
            shutdownIncomplete = true;
            logger.error(
              "PostgreSQL connection pool shutdown did not settle before deadline",
            );
            setExitCode(1);
          } else {
            logger.log("PostgreSQL connection pool closed.");
          }
        } catch (error) {
          shutdownIncomplete = true;
          logger.error("PostgreSQL shutdown failed:", error.message);
          setExitCode(1);
        } finally {
          if (dbEndTimer !== null) {
            clearTimeoutFn(dbEndTimer);
            dbEndTimer = null;
          }
        }
      }

      if (shutdownIncomplete) {
        logger.error(
          "Server shutdown was incomplete; terminating process to release unmanaged handles",
        );
        if (typeof terminateProcess === "function") {
          terminateProcess(1);
        }
      } else {
        logger.log("Shutdown complete.");
      }
    })();

    return shutdownPromise;
  }

  return {
    startServer,
    shutdown,
    initializeRedisFeatures,
    getHttpServer: () => httpServer,
    isStarting: () => Boolean(startPromise),
    isShuttingDown: () => isShuttingDown,
  };
}

const defaultServerManager = createServerManager({
  terminateProcess: (code) => {
    process.exit(code);
  },
});

async function startServer() {
  return defaultServerManager.startServer();
}

function shutdown(signal) {
  return defaultServerManager.shutdown(signal);
}

function initializeRedisFeatures() {
  return defaultServerManager.initializeRedisFeatures();
}

if (require.main === module) {
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  void startServer();
}

module.exports = {
  startServer,
  shutdown,
  initializeRedisFeatures,
  createServerManager,
};
