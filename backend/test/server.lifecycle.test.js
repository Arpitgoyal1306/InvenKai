const { test } = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");

const { createServerManager } = require("../server");

function createMockLogger() {
  const logs = [];
  return {
    logs,
    log(...args) { logs.push(["log", ...args]); },
    warn(...args) { logs.push(["warn", ...args]); },
    error(...args) { logs.push(["error", ...args]); },
  };
}

function createMockWebSocketService() {
  let attachedServer = null;
  let closed = false;
  let subscriberStarted = false;

  return {
    attach(server) {
      attachedServer = server;
    },
    async close() {
      closed = true;
    },
    async startSubscriber() {
      subscriberStarted = true;
      return true;
    },
    getAttachedServer: () => attachedServer,
    isClosed: () => closed,
    isSubscriberStarted: () => subscriberStarted,
  };
}

function createMockRedisManager({ connectDeferred = null, neverResolves = false } = {}) {
  let closed = false;
  let client = null;

  return {
    get client() {
      return client;
    },
    async connectRedis() {
      if (neverResolves) {
        return new Promise(() => {});
      }
      if (connectDeferred) {
        await connectDeferred;
      }
      client = { isReady: true };
      closed = false;
      return true;
    },
    async closeRedis() {
      closed = true;
      client = null;
    },
    isClosed: () => closed,
  };
}

function createMockHttpModule({
  listenDelayPromise = null,
  listenError = null,
  onListenStarted = null,
} = {}) {
  let createServerCalls = 0;
  const servers = [];

  return {
    createServer() {
      createServerCalls += 1;
      const server = new EventEmitter();
      server.listening = false;
      let closeCalled = false;

      server.listen = function (port, callback) {
        if (typeof onListenStarted === "function") {
          onListenStarted();
        }

        if (listenError) {
          process.nextTick(() => {
            server.emit("error", listenError);
          });
          return server;
        }

        const notify = () => {
          if (closeCalled) return;
          server.listening = true;
          if (typeof callback === "function") {
            callback();
          }
          server.emit("listening");
        };

        if (listenDelayPromise) {
          listenDelayPromise.then(notify).catch((err) => server.emit("error", err));
        } else {
          process.nextTick(notify);
        }

        return server;
      };

      server.close = function (callback) {
        closeCalled = true;
        server.listening = false;
        if (typeof callback === "function") {
          process.nextTick(callback);
        }
      };

      server.isCloseCalled = () => closeCalled;
      servers.push(server);
      return server;
    },
    getCreateServerCalls: () => createServerCalls,
    getServers: () => servers,
  };
}

// ---------------------------------------------------------------------------
// Existing Six Lifecycle Tests
// ---------------------------------------------------------------------------

test("two concurrent startServer calls await the same operation and receive the same HTTP server instance", async () => {
  const httpModule = createMockHttpModule();
  const wsService = createMockWebSocketService();
  const redisManager = createMockRedisManager();
  const logger = createMockLogger();

  let dbQueryCalls = 0;
  const db = {
    async query() {
      dbQueryCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { rows: [{ now: new Date() }] };
    },
    async end() {},
  };

  const manager = createServerManager({
    port: 9999,
    db,
    redisManager,
    httpModule,
    websocketService: wsService,
    logger,
  });

  const [server1, server2] = await Promise.all([
    manager.startServer(),
    manager.startServer(),
  ]);

  assert.ok(server1, "first caller receives an HTTP server instance");
  assert.ok(server2, "second caller receives an HTTP server instance");
  assert.strictEqual(server1, server2, "both callers receive the exact same instance");
  assert.strictEqual(httpModule.getCreateServerCalls(), 1, "only one HTTP server is initialized");
  assert.strictEqual(dbQueryCalls, 1, "only one database check is executed");
  assert.strictEqual(wsService.getAttachedServer(), server1, "websocket service attached to server");

  await manager.shutdown("TEST");
});

test("subsequent startServer call after completion returns existing HTTP server without re-initialization", async () => {
  const httpModule = createMockHttpModule();
  const db = {
    async query() {
      return { rows: [{ now: new Date() }] };
    },
    async end() {},
  };

  const manager = createServerManager({
    port: 9999,
    db,
    redisManager: createMockRedisManager(),
    httpModule,
    websocketService: createMockWebSocketService(),
    logger: createMockLogger(),
  });

  const server1 = await manager.startServer();
  const server2 = await manager.startServer();

  assert.strictEqual(server1, server2);
  assert.strictEqual(httpModule.getCreateServerCalls(), 1);

  await manager.shutdown("TEST");
});

test("startup failure cleans up, returns null to all concurrent callers, and allows a later retry", async () => {
  const httpModule = createMockHttpModule();
  const wsService = createMockWebSocketService();
  const redisManager = createMockRedisManager();
  const logger = createMockLogger();
  const exitCodes = [];

  let shouldFail = true;
  let dbEndCalls = 0;
  const db = {
    async query() {
      if (shouldFail) {
        throw new Error("PostgreSQL connection refused");
      }
      return { rows: [{ now: new Date() }] };
    },
    async end() {
      dbEndCalls += 1;
    },
  };

  const manager = createServerManager({
    port: 9999,
    db,
    redisManager,
    httpModule,
    websocketService: wsService,
    logger,
    setExitCode: (code) => exitCodes.push(code),
  });

  // Concurrent startup calls during failure
  const [res1, res2] = await Promise.all([
    manager.startServer(),
    manager.startServer(),
  ]);

  assert.strictEqual(res1, null, "caller 1 receives null on startup failure");
  assert.strictEqual(res2, null, "caller 2 receives null on startup failure");
  assert.strictEqual(httpModule.getCreateServerCalls(), 0, "no HTTP server initialized on db failure");
  assert.strictEqual(manager.getHttpServer(), null);
  assert.strictEqual(manager.isStarting(), false, "start promise is reset in finally");
  assert.ok(exitCodes.includes(1), "exit code 1 is recorded on failure");
  assert.ok(wsService.isClosed(), "websocket service was cleaned up");
  assert.ok(redisManager.isClosed(), "redis connection was cleaned up");
  assert.strictEqual(dbEndCalls, 0, "shared database pool is not closed on startup connection failure");

  // Subsequent legitimate retry when database recovers
  shouldFail = false;
  const retryServer = await manager.startServer();

  assert.ok(retryServer, "retry successfully starts when conditions permit");
  assert.strictEqual(httpModule.getCreateServerCalls(), 1);

  await manager.shutdown("TEST");
  assert.strictEqual(dbEndCalls, 1, "terminal shutdown ends the database pool");
});

test("shutdown during startup aborts server initialization, resolves callers to null, and prevents race", async () => {
  const httpModule = createMockHttpModule();
  const wsService = createMockWebSocketService();
  const redisManager = createMockRedisManager();
  const logger = createMockLogger();

  let resolveDbQuery;
  const dbQueryPromise = new Promise((resolve) => {
    resolveDbQuery = resolve;
  });

  const db = {
    async query() {
      return dbQueryPromise;
    },
    async end() {},
  };

  const manager = createServerManager({
    port: 9999,
    db,
    redisManager,
    httpModule,
    websocketService: wsService,
    logger,
  });

  // Initiate startup
  const startPromise = manager.startServer();
  assert.strictEqual(manager.isStarting(), true, "startup is in flight");

  // Trigger shutdown while db.query is pending
  const shutdownPromise = manager.shutdown("SIGTERM");
  assert.strictEqual(manager.isShuttingDown(), true, "shutdown is marked");

  // Release the pending database query
  resolveDbQuery({ rows: [{ now: new Date() }] });

  const [startResult] = await Promise.all([startPromise, shutdownPromise]);

  assert.strictEqual(startResult, null, "startup returns null when shutdown interrupts");
  assert.strictEqual(httpModule.getCreateServerCalls(), 0, "HTTP server was never created");
  assert.strictEqual(manager.getHttpServer(), null);

  // Subsequent startup call after shutdown must not race or start
  const postShutdownResult = await manager.startServer();
  assert.strictEqual(postShutdownResult, null, "startup after shutdown is blocked");
  assert.strictEqual(httpModule.getCreateServerCalls(), 0);
});

test("EADDRINUSE error on server triggers error handling and graceful shutdown", async () => {
  const httpModule = createMockHttpModule();
  const logger = createMockLogger();
  const exitCodes = [];

  const manager = createServerManager({
    port: 5001,
    db: {
      async query() { return { rows: [{ now: new Date() }] }; },
      async end() {},
    },
    redisManager: createMockRedisManager(),
    httpModule,
    websocketService: createMockWebSocketService(),
    logger,
    setExitCode: (code) => exitCodes.push(code),
  });

  const server = await manager.startServer();
  assert.ok(server);

  // Simulate EADDRINUSE error emitted by HTTP server at runtime
  const eaddrinuseError = Object.assign(new Error("listen EADDRINUSE: address already in use :::5001"), {
    code: "EADDRINUSE",
  });
  server.emit("error", eaddrinuseError);

  // Wait for shutdown to process
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(exitCodes.includes(1), "exit code 1 is set on EADDRINUSE");
  assert.strictEqual(manager.isShuttingDown(), true, "shutdown initiated");
  assert.ok(
    logger.logs.some(([level, msg]) => level === "error" && msg.includes("Port 5001 is already in use")),
    "logs descriptive port collision message",
  );
});

test("starts real HTTP server on port 0 and cleanly shuts down", async () => {
  const logger = createMockLogger();
  const manager = createServerManager({
    port: 0,
    db: {
      async query() { return { rows: [{ now: new Date() }] }; },
      async end() {},
    },
    redisManager: createMockRedisManager(),
    websocketService: createMockWebSocketService(),
    logger,
  });

  const [s1, s2] = await Promise.all([
    manager.startServer(),
    manager.startServer(),
  ]);

  assert.ok(s1);
  assert.strictEqual(s1, s2);
  assert.strictEqual(s1.listening, true);

  const address = s1.address();
  assert.ok(address && address.port > 0, "bound to ephemeral port");

  await manager.shutdown("TEST");
  assert.strictEqual(s1.listening, false);
});

// ---------------------------------------------------------------------------
// Issue 1 Targeted Regression Tests: HTTP listen / shutdown race
// ---------------------------------------------------------------------------

test("Issue 1: shutdown while HTTP listen is pending aborts listen, returns null, and closes server", async () => {
  let resolveListen;
  const listenDelayPromise = new Promise((resolve) => {
    resolveListen = resolve;
  });

  let onListenStarted;
  const listenStartedPromise = new Promise((resolve) => {
    onListenStarted = resolve;
  });

  const httpModule = createMockHttpModule({ listenDelayPromise, onListenStarted });
  const wsService = createMockWebSocketService();
  const redisManager = createMockRedisManager();
  const logger = createMockLogger();

  const manager = createServerManager({
    port: 9999,
    db: {
      async query() { return { rows: [{ now: new Date() }] }; },
      async end() {},
    },
    redisManager,
    httpModule,
    websocketService: wsService,
    logger,
  });

  // Start server
  const startPromise = manager.startServer();

  // Wait until server.listen() has actually been invoked
  await listenStartedPromise;
  assert.strictEqual(manager.isStarting(), true);

  // Trigger shutdown while listen is still pending
  const shutdownPromise = manager.shutdown("SIGTERM");
  assert.strictEqual(manager.isShuttingDown(), true);

  // Allow pending listen to resolve late
  resolveListen();

  const [startResult] = await Promise.all([startPromise, shutdownPromise]);

  assert.strictEqual(startResult, null, "startup returns null when shutdown interrupts listen");
  assert.strictEqual(manager.getHttpServer(), null, "httpServer is null after shutdown");

  const [server] = httpModule.getServers();
  assert.ok(server, "server instance was created");
  assert.strictEqual(server.isCloseCalled(), true, "server was closed by shutdown coordination");
  assert.strictEqual(wsService.isSubscriberStarted(), false, "Redis subscriber was never started");
});

test("Issue 1: successful listen followed by shutdown cleanly closes the listening server", async () => {
  const httpModule = createMockHttpModule();
  const manager = createServerManager({
    port: 9999,
    db: {
      async query() { return { rows: [{ now: new Date() }] }; },
      async end() {},
    },
    redisManager: createMockRedisManager(),
    httpModule,
    websocketService: createMockWebSocketService(),
    logger: createMockLogger(),
  });

  const server = await manager.startServer();
  assert.ok(server);
  assert.strictEqual(server.listening, true);

  await manager.shutdown("SIGTERM");
  assert.strictEqual(server.listening, false);
  assert.strictEqual(manager.getHttpServer(), null);
});

test("Issue 1: listen failure during startup handles EADDRINUSE, cleans up, and returns null", async () => {
  const listenError = Object.assign(new Error("listen EADDRINUSE: address already in use :::9999"), {
    code: "EADDRINUSE",
  });
  const httpModule = createMockHttpModule({ listenError });
  const wsService = createMockWebSocketService();
  const redisManager = createMockRedisManager();
  const logger = createMockLogger();
  const exitCodes = [];

  const manager = createServerManager({
    port: 9999,
    db: {
      async query() { return { rows: [{ now: new Date() }] }; },
      async end() {},
    },
    redisManager,
    httpModule,
    websocketService: wsService,
    logger,
    setExitCode: (code) => exitCodes.push(code),
  });

  const result = await manager.startServer();

  assert.strictEqual(result, null, "returns null on listen failure");
  assert.strictEqual(manager.getHttpServer(), null);
  assert.strictEqual(manager.isStarting(), false);
  assert.ok(exitCodes.includes(1), "exit code 1 is set on listen error");
  assert.ok(
    logger.logs.some(([level, msg]) => level === "error" && msg.includes("Port 9999 is already in use")),
    "logged port in use error message",
  );
  assert.ok(wsService.isClosed(), "websocket service was closed on listen failure");
  assert.ok(redisManager.isClosed(), "redis manager was closed on listen failure");
});

test("Issue 1: repeated shutdown calls share the same shutdown promise", async () => {
  const manager = createServerManager({
    port: 9999,
    db: {
      async query() { return { rows: [{ now: new Date() }] }; },
      async end() {},
    },
    redisManager: createMockRedisManager(),
    httpModule: createMockHttpModule(),
    websocketService: createMockWebSocketService(),
    logger: createMockLogger(),
  });

  await manager.startServer();

  const shutdownPromise1 = manager.shutdown("SIGTERM");
  const shutdownPromise2 = manager.shutdown("SIGINT");

  assert.strictEqual(shutdownPromise1, shutdownPromise2, "repeated shutdown calls share identical promise");
  await shutdownPromise1;
});

// ---------------------------------------------------------------------------
// Issue 2 Targeted Regression Tests: Redis initialization / shutdown race & deadlock
// ---------------------------------------------------------------------------

test("Issue 2: Redis connection established late during shutdown is properly closed", async () => {
  let resolveConnect;
  const connectDeferred = new Promise((resolve) => {
    resolveConnect = resolve;
  });

  const redisManager = createMockRedisManager({ connectDeferred });
  const wsService = createMockWebSocketService();
  const logger = createMockLogger();

  const manager = createServerManager({
    port: 9999,
    db: {
      async query() { return { rows: [{ now: new Date() }] }; },
      async end() {},
    },
    redisManager,
    httpModule: createMockHttpModule(),
    websocketService: wsService,
    logger,
  });

  // Trigger Redis initialization in the background (held by connectDeferred)
  const redisInitPromise = manager.initializeRedisFeatures();

  // Trigger shutdown while connectRedis is still pending
  const shutdownPromise = manager.shutdown("SIGTERM");

  // Now resolve the late connectRedis
  resolveConnect();

  await Promise.all([redisInitPromise, shutdownPromise]);

  assert.strictEqual(redisManager.isClosed(), true, "Redis manager is closed after shutdown");
  assert.strictEqual(redisManager.client, null, "no Redis client remains active after shutdown");
  assert.strictEqual(wsService.isClosed(), true, "WebSocket service was closed during shutdown");
});

test("Issue 2: shutdown does not deadlock when connectRedis promise deliberately remains unresolved", async () => {
  const redisManager = createMockRedisManager({ neverResolves: true });
  const wsService = createMockWebSocketService();
  const logger = createMockLogger();
  let dbEndCalls = 0;
  const db = {
    async query() { return { rows: [{ now: new Date() }] }; },
    async end() { dbEndCalls += 1; },
  };

  const manager = createServerManager({
    port: 9999,
    db,
    redisManager,
    httpModule: createMockHttpModule(),
    websocketService: wsService,
    logger,
  });

  // Start Redis initialization (its connectRedis promise deliberately never resolves)
  const redisInitPromise = manager.initializeRedisFeatures();

  // Initiate shutdown - must interrupt the pending Redis connection and not deadlock
  const shutdownPromise = manager.shutdown("SIGTERM");

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
  }, 2000);

  const [initResult] = await Promise.all([redisInitPromise, shutdownPromise]);
  clearTimeout(timeoutId);

  assert.strictEqual(timedOut, false, "shutdown completed within bounded timeout without deadlock");
  assert.strictEqual(initResult, false, "initialization returned false when interrupted by shutdown");
  assert.strictEqual(redisManager.isClosed(), true, "Redis close was invoked");
  assert.strictEqual(redisManager.client, null, "no Redis client remains active");
  assert.strictEqual(wsService.isClosed(), true, "WebSocket service is closed");
  assert.strictEqual(dbEndCalls, 1, "database pool was closed exactly once");
});

test("Issue 2: 5-second fallback timer is cleared when Redis initialization settles before 5 seconds", async () => {
  let timerCleared = false;
  let timerUnrefCalled = false;
  let configuredDelay = null;
  const mockTimerHandle = { id: "test-timer-5s" };

  const setTimeoutFn = (callback, ms) => {
    configuredDelay = ms;
    return {
      ...mockTimerHandle,
      unref() {
        timerUnrefCalled = true;
      },
    };
  };

  const clearTimeoutFn = (timer) => {
    if (timer && timer.id === "test-timer-5s") {
      timerCleared = true;
    }
  };

  const redisManager = createMockRedisManager({ neverResolves: true });
  const wsService = createMockWebSocketService();
  const logger = createMockLogger();

  const manager = createServerManager({
    port: 9999,
    db: {
      async query() { return { rows: [{ now: new Date() }] }; },
      async end() {},
    },
    redisManager,
    httpModule: createMockHttpModule(),
    websocketService: wsService,
    logger,
    setTimeoutFn,
    clearTimeoutFn,
  });

  // Start initialization in flight
  const initPromise = manager.initializeRedisFeatures();

  // Initiate shutdown while initialization is in flight
  await manager.shutdown("SIGTERM");
  await initPromise;

  assert.strictEqual(configuredDelay, 5000, "5-second timeout bound is preserved");
  assert.strictEqual(timerUnrefCalled, true, "unref() was called on timer");
  assert.strictEqual(timerCleared, true, "timer was cleared in finally block");
});

test("Issue 2: 5-second fallback timer triggers shutdown progression when Redis initialization remains pending", async () => {
  let timerCleared = false;
  let timerFired = false;
  let configuredDelay = null;
  let fallbackTimerId = null;

  // setTimeoutFn fires callback after 30ms to simulate the 5000ms safety timeout expiring
  const setTimeoutFn = (callback, ms) => {
    configuredDelay = ms;
    const realTimer = setTimeout(() => {
      timerFired = true;
      callback();
    }, 30);
    fallbackTimerId = realTimer;
    return realTimer;
  };

  const clearTimeoutFn = (timer) => {
    timerCleared = true;
    clearTimeout(timer);
  };

  let closeRedisCompleted = false;
  const redisManager = {
    connectRedis: () => new Promise(() => {}),
    closeRedis: async () => {
      // Simulate close taking 120ms (longer than the 30ms simulated timeout)
      await new Promise((resolve) => setTimeout(resolve, 120));
      closeRedisCompleted = true;
    },
  };

  const wsService = createMockWebSocketService();
  const logger = createMockLogger();
  let dbEndCalls = 0;

  const manager = createServerManager({
    port: 9999,
    db: {
      async query() { return { rows: [{ now: new Date() }] }; },
      async end() { dbEndCalls += 1; },
    },
    redisManager,
    httpModule: createMockHttpModule(),
    websocketService: wsService,
    logger,
    setTimeoutFn,
    clearTimeoutFn,
  });

  // Start Redis initialization in flight
  const initPromise = manager.initializeRedisFeatures();

  // Initiate shutdown - fallback timeout expires before closeRedis finishes
  await manager.shutdown("SIGTERM");

  assert.strictEqual(configuredDelay, 5000, "5-second timeout bound was requested");
  assert.strictEqual(timerFired, true, "fallback timeout branch resolved before init settled");
  assert.strictEqual(timerCleared, true, "fallback timer cleared in finally");
  assert.strictEqual(closeRedisCompleted, true, "redisClosePromise completed in shutdown step 5");
  assert.strictEqual(wsService.isClosed(), true, "WebSocket closed");
  assert.strictEqual(dbEndCalls, 1, "database pool closed");
});

// ---------------------------------------------------------------------------
// Issue 3 Targeted Regression Test: PostgreSQL pool reuse after startup failure
// ---------------------------------------------------------------------------

test("Issue 3: database pool mock becomes unusable after end(), verifying pool is not prematurely closed on startup failure", async () => {
  let ended = false;
  let queryCount = 0;
  let endCount = 0;

  const db = {
    async query() {
      if (ended) {
        throw new Error("Cannot use a pool after calling end()");
      }
      queryCount += 1;
      if (queryCount === 1) {
        throw new Error("Database temporarily unreachable");
      }
      return { rows: [{ now: new Date() }] };
    },
    async end() {
      if (ended) {
        throw new Error("Pool has already been ended");
      }
      ended = true;
      endCount += 1;
    },
    isEnded: () => ended,
    getEndCount: () => endCount,
  };

  const exitCodes = [];
  const manager = createServerManager({
    port: 9999,
    db,
    redisManager: createMockRedisManager(),
    httpModule: createMockHttpModule(),
    websocketService: createMockWebSocketService(),
    logger: createMockLogger(),
    setExitCode: (code) => exitCodes.push(code),
  });

  // Attempt 1: database connection check fails
  const res1 = await manager.startServer();
  assert.strictEqual(res1, null, "first startup fails due to database error");
  assert.strictEqual(db.isEnded(), false, "shared database pool must NOT be ended on startup failure");

  // Attempt 2: retry succeeds with the exact same pool instance
  const res2 = await manager.startServer();
  assert.ok(res2, "retry succeeds because the pool was preserved");
  assert.strictEqual(db.isEnded(), false, "pool remains alive while server is running");

  // Terminal shutdown closes the pool exactly once
  await manager.shutdown("TERMINAL");
  assert.strictEqual(db.isEnded(), true, "terminal shutdown ends the pool");
  assert.strictEqual(db.getEndCount(), 1, "pool.end() was called exactly once");

  // Repeated shutdown does not call end() again
  await manager.shutdown("TERMINAL_REPEAT");
  assert.strictEqual(db.getEndCount(), 1, "subsequent shutdown does not re-invoke pool.end()");
});

// ---------------------------------------------------------------------------
// Issue 4 Targeted Regression Tests: Bounded startup wait during shutdown
// ---------------------------------------------------------------------------

test("Issue 4: permanently pending PostgreSQL startup query does not hang shutdown and progresses after timeout", async () => {
  let timerFired = false;
  let timerCleared = false;
  let configuredDelay = null;

  // Simulate startupTimeoutMs expiring after 25ms using injected timer
  const setTimeoutFn = (callback, ms) => {
    configuredDelay = ms;
    const realTimer = setTimeout(() => {
      timerFired = true;
      callback();
    }, 25);
    return realTimer;
  };

  const clearTimeoutFn = (timer) => {
    timerCleared = true;
    clearTimeout(timer);
  };

  const db = {
    // Permanently pending PostgreSQL query
    query: () => new Promise(() => {}),
    endCalls: 0,
    async end() {
      this.endCalls += 1;
    },
  };

  const wsService = createMockWebSocketService();
  const redisManager = createMockRedisManager();
  const logger = createMockLogger();
  const exitCodes = [];

  const manager = createServerManager({
    port: 9999,
    db,
    redisManager,
    httpModule: createMockHttpModule(),
    websocketService: wsService,
    logger,
    setTimeoutFn,
    clearTimeoutFn,
    startupTimeoutMs: 5000,
    setExitCode: (code) => exitCodes.push(code),
  });

  // Start server (starts query that never resolves)
  void manager.startServer();

  let timedOut = false;
  const safetyTimeout = setTimeout(() => {
    timedOut = true;
  }, 2000);

  // Trigger shutdown - must proceed after startup timeout expires
  await manager.shutdown("SIGTERM");
  clearTimeout(safetyTimeout);

  assert.strictEqual(timedOut, false, "shutdown completed without deadlocking");
  assert.strictEqual(configuredDelay, 5000, "configured delay of 5000ms was used");
  assert.strictEqual(timerFired, true, "startup timeout fired");
  assert.strictEqual(timerCleared, true, "timer handle cleared in finally");
  assert.strictEqual(wsService.isClosed(), true, "WebSocket was closed");
  assert.strictEqual(redisManager.isClosed(), true, "Redis was closed");
  assert.strictEqual(db.endCalls, 1, "database pool was ended");
  assert.ok(exitCodes.includes(1), "exit code 1 set because startup did not settle");
  assert.ok(
    logger.logs.some(([level, msg]) => level === "error" && msg.includes("Server startup did not settle")),
    "logged startup timeout error",
  );
});

test("Issue 4: PostgreSQL startup query resolves before timeout, and timer is cleared in finally block", async () => {
  let timerCleared = false;
  let timerUnrefCalled = false;
  let configuredDelay = null;
  const mockTimerHandle = { id: "startup-timer-mock" };

  const setTimeoutFn = (callback, ms) => {
    configuredDelay = ms;
    return {
      ...mockTimerHandle,
      unref() {
        timerUnrefCalled = true;
      },
    };
  };

  const clearTimeoutFn = (timer) => {
    if (timer && timer.id === "startup-timer-mock") {
      timerCleared = true;
    }
  };

  const db = {
    async query() {
      // Resolves quickly
      return { rows: [{ now: new Date() }] };
    },
    endCalls: 0,
    async end() {
      this.endCalls += 1;
    },
  };

  const wsService = createMockWebSocketService();
  const redisManager = createMockRedisManager();
  const logger = createMockLogger();

  const manager = createServerManager({
    port: 9999,
    db,
    redisManager,
    httpModule: createMockHttpModule(),
    websocketService: wsService,
    logger,
    setTimeoutFn,
    clearTimeoutFn,
    startupTimeoutMs: 5000,
  });

  const startPromise = manager.startServer();
  await startPromise;

  await manager.shutdown("SIGTERM");

  assert.strictEqual(configuredDelay, 5000, "5-second timeout bound was requested");
  assert.strictEqual(timerUnrefCalled, true, "unref() was called on startup timer");
  assert.strictEqual(timerCleared, true, "startup timer was cleared in finally block");
  assert.strictEqual(manager.getHttpServer(), null, "server cleaned up");
  assert.strictEqual(db.endCalls, 1, "database closed normally");
});

test("Issue 4: PostgreSQL startup query rejects during shutdown without crashing or leaving open handles", async () => {
  let rejectDbQuery;
  const dbQueryPromise = new Promise((_, reject) => {
    rejectDbQuery = reject;
  });

  const db = {
    async query() {
      return dbQueryPromise;
    },
    endCalls: 0,
    async end() {
      this.endCalls += 1;
    },
  };

  const wsService = createMockWebSocketService();
  const redisManager = createMockRedisManager();
  const logger = createMockLogger();
  const exitCodes = [];

  const manager = createServerManager({
    port: 9999,
    db,
    redisManager,
    httpModule: createMockHttpModule(),
    websocketService: wsService,
    logger,
    setExitCode: (code) => exitCodes.push(code),
  });

  const startPromise = manager.startServer();
  const shutdownPromise = manager.shutdown("SIGTERM");

  // Reject the DB query while shutdown is in flight
  rejectDbQuery(new Error("Connection terminated unexpectedly"));

  const [startResult] = await Promise.all([startPromise, shutdownPromise]);

  assert.strictEqual(startResult, null, "startServer returns null");
  assert.strictEqual(manager.getHttpServer(), null);
  assert.strictEqual(wsService.isClosed(), true);
  assert.strictEqual(redisManager.isClosed(), true);
  assert.strictEqual(db.endCalls, 1);
  assert.ok(exitCodes.includes(1), "exit code 1 set on startup rejection");
});

test("Issue 4: startup resolves late after shutdown has begun, and no HTTP, Redis, or WebSocket resources are started", async () => {
  let resolveDbQuery;
  const dbQueryPromise = new Promise((resolve) => {
    resolveDbQuery = resolve;
  });

  const httpModule = createMockHttpModule();
  const wsService = createMockWebSocketService();
  const redisManager = createMockRedisManager();
  const logger = createMockLogger();
  const exitCodes = [];

  const db = {
    async query() {
      return dbQueryPromise;
    },
    endCalls: 0,
    async end() {
      this.endCalls += 1;
    },
  };

  const manager = createServerManager({
    port: 9999,
    db,
    redisManager,
    httpModule,
    websocketService: wsService,
    logger,
    startupTimeoutMs: 20, // Fast timeout
    setExitCode: (code) => exitCodes.push(code),
  });

  const startPromise = manager.startServer();
  const shutdownPromise = manager.shutdown("SIGTERM");

  // Await shutdown completion first
  await shutdownPromise;

  assert.strictEqual(manager.isShuttingDown(), true);

  // Now resolve the late startup query after shutdown has already finished
  resolveDbQuery({ rows: [{ now: new Date() }] });
  const startResult = await startPromise;

  assert.strictEqual(startResult, null, "late startup returns null");
  assert.strictEqual(httpModule.getCreateServerCalls(), 0, "no HTTP server was created");
  assert.strictEqual(wsService.getAttachedServer(), null, "websocket was not attached");
  assert.strictEqual(wsService.isSubscriberStarted(), false, "redis subscriber was not started");
  assert.strictEqual(redisManager.client, null, "redis client was not created or retained");
  assert.strictEqual(db.endCalls, 1, "database pool was ended exactly once");
});

test("Issue 4: concurrent shutdown calls while startup is pending share the same shutdown promise", async () => {
  const db = {
    query: () => new Promise(() => {}), // permanently pending
    endCalls: 0,
    async end() {
      this.endCalls += 1;
    },
  };

  const exitCodes = [];
  const manager = createServerManager({
    port: 9999,
    db,
    redisManager: createMockRedisManager(),
    httpModule: createMockHttpModule(),
    websocketService: createMockWebSocketService(),
    logger: createMockLogger(),
    startupTimeoutMs: 25,
    setExitCode: (code) => exitCodes.push(code),
  });

  void manager.startServer();

  const shut1 = manager.shutdown("SIGTERM");
  const shut2 = manager.shutdown("SIGINT");
  const shut3 = manager.shutdown("SIGTERM");

  assert.strictEqual(shut1, shut2, "first and second shutdown calls return identical promise");
  assert.strictEqual(shut2, shut3, "second and third shutdown calls return identical promise");

  await shut1;
  assert.strictEqual(db.endCalls, 1, "database pool closed once despite concurrent calls");
});

test("Issue 4: database pool cleanup happens exactly once, even when startup remains permanently pending and shutdown is repeated", async () => {
  let endCallCount = 0;
  const db = {
    query: () => new Promise(() => {}), // permanently pending
    async end() {
      endCallCount += 1;
    },
  };

  const exitCodes = [];
  const manager = createServerManager({
    port: 9999,
    db,
    redisManager: createMockRedisManager(),
    httpModule: createMockHttpModule(),
    websocketService: createMockWebSocketService(),
    logger: createMockLogger(),
    startupTimeoutMs: 20,
    setExitCode: (code) => exitCodes.push(code),
  });

  void manager.startServer();

  await manager.shutdown("TERMINAL");
  assert.strictEqual(endCallCount, 1, "pool.end() called once on initial shutdown");

  // Subsequent explicit shutdown after completion
  await manager.shutdown("POST_TERMINAL");
  assert.strictEqual(endCallCount, 1, "pool.end() is not invoked again on subsequent shutdown calls");
});

// ---------------------------------------------------------------------------
// Issue 1 Targeted Regression Tests: Bounded PostgreSQL pool cleanup during shutdown
// ---------------------------------------------------------------------------

test("Issue 1: permanently pending PostgreSQL query causes db.end() to remain pending, but complete shutdown settles within bounded period", async () => {
  let timerCleared = false;
  let timerUnrefCalled = false;
  let configuredDelay = null;

  const setTimeoutFn = (callback, ms) => {
    configuredDelay = ms;
    const realTimer = setTimeout(() => {
      callback();
    }, 25);
    return {
      unref() {
        timerUnrefCalled = true;
        realTimer.unref();
      },
      [Symbol.toPrimitive]() {
        return realTimer;
      },
      realTimer,
    };
  };

  const clearTimeoutFn = (timer) => {
    timerCleared = true;
    if (timer?.realTimer) {
      clearTimeout(timer.realTimer);
    } else {
      clearTimeout(timer);
    }
  };

  const db = {
    query: () => new Promise(() => {}), // In-flight query on checked-out client never resolves
    endCalls: 0,
    end() {
      this.endCalls += 1;
      // In pg.Pool, end() waits for checked-out clients to be released.
      // Since the query never resolves, pg.Pool.end() returns a Promise
      // that remains pending indefinitely.
      return new Promise(() => {});
    },
  };

  const wsService = createMockWebSocketService();
  const redisManager = createMockRedisManager();
  const logger = createMockLogger();
  const exitCodes = [];

  const manager = createServerManager({
    port: 9999,
    db,
    redisManager,
    httpModule: createMockHttpModule(),
    websocketService: wsService,
    logger,
    setTimeoutFn,
    clearTimeoutFn,
    startupTimeoutMs: 25,
    dbShutdownTimeoutMs: 25,
    setExitCode: (code) => exitCodes.push(code),
  });

  void manager.startServer();

  let timedOut = false;
  const safetyTimeout = setTimeout(() => {
    timedOut = true;
  }, 2000);

  // Complete shutdown lifecycle must settle within bounded period
  await manager.shutdown("SIGTERM");
  clearTimeout(safetyTimeout);

  assert.strictEqual(timedOut, false, "shutdown completed without deadlocking on pending db.end()");
  assert.strictEqual(db.endCalls, 1, "db.end() was invoked once");
  assert.strictEqual(wsService.isClosed(), true, "WebSocket was closed");
  assert.strictEqual(redisManager.isClosed(), true, "Redis was closed");
  assert.strictEqual(timerUnrefCalled, true, "unref() called on db shutdown timer");
  assert.strictEqual(timerCleared, true, "db shutdown timer cleared in finally");
  assert.ok(exitCodes.includes(1), "exit code 1 set because db.end did not settle");
  assert.ok(
    logger.logs.some(([level, msg]) => level === "error" && msg.includes("PostgreSQL connection pool shutdown did not settle before deadline")),
    "logged pool shutdown timeout error",
  );

  // Repeated shutdown is idempotent and returns the same completed promise
  await manager.shutdown("SIGTERM");
  assert.strictEqual(db.endCalls, 1, "db.end() was not called a second time on repeated shutdown");
});

test("Issue 1: normal db.end() clears shutdown timer and logs clean pool closure", async () => {
  let timerCleared = false;
  let timerUnrefCalled = false;
  const mockTimer = {
    id: "db-timer",
    unref() {
      timerUnrefCalled = true;
    },
  };

  const setTimeoutFn = () => mockTimer;
  const clearTimeoutFn = (timer) => {
    if (timer?.id === "db-timer") {
      timerCleared = true;
    }
  };

  const db = {
    async query() {
      return { rows: [{ now: new Date() }] };
    },
    endCalls: 0,
    async end() {
      this.endCalls += 1;
    },
  };

  const logger = createMockLogger();
  const exitCodes = [];

  const manager = createServerManager({
    port: 9999,
    db,
    redisManager: createMockRedisManager(),
    httpModule: createMockHttpModule(),
    websocketService: createMockWebSocketService(),
    logger,
    setTimeoutFn,
    clearTimeoutFn,
    setExitCode: (code) => exitCodes.push(code),
  });

  await manager.startServer();
  await manager.shutdown("SIGTERM");

  assert.strictEqual(db.endCalls, 1, "db.end() was called");
  assert.strictEqual(timerUnrefCalled, true, "unref() called on timer");
  assert.strictEqual(timerCleared, true, "timer cleared in finally block");
  assert.ok(
    logger.logs.some(([level, msg]) => level === "log" && msg.includes("PostgreSQL connection pool closed.")),
    "logged clean pool closure",
  );
  assert.strictEqual(exitCodes.length, 0, "no error exit code set on clean shutdown");
});

test("Issue 1: db.end() rejection during shutdown is logged without crashing or preventing shutdown completion", async () => {
  const db = {
    async query() {
      return { rows: [{ now: new Date() }] };
    },
    endCalls: 0,
    async end() {
      this.endCalls += 1;
      throw new Error("Pool destroy error");
    },
  };

  const logger = createMockLogger();
  const exitCodes = [];

  const manager = createServerManager({
    port: 9999,
    db,
    redisManager: createMockRedisManager(),
    httpModule: createMockHttpModule(),
    websocketService: createMockWebSocketService(),
    logger,
    setExitCode: (code) => exitCodes.push(code),
  });

  await manager.startServer();
  await manager.shutdown("SIGTERM");

  assert.strictEqual(db.endCalls, 1, "db.end() was attempted");
  assert.ok(exitCodes.includes(1), "exit code 1 set on rejection");
  assert.ok(
    logger.logs.some(([level, ...args]) => level === "error" && args.join(" ").includes("PostgreSQL shutdown failed: Pool destroy error")),
    "logged db shutdown failure error",
  );
});

test("Issue 1: terminateProcess is called when shutdown is incomplete", async () => {
  const db = {
    query: () => new Promise(() => {}),
    end: () => new Promise(() => {}),
  };

  const logger = createMockLogger();
  const exitCodes = [];
  const terminationCalls = [];

  const manager = createServerManager({
    port: 9999,
    db,
    redisManager: createMockRedisManager(),
    httpModule: createMockHttpModule(),
    websocketService: createMockWebSocketService(),
    logger,
    startupTimeoutMs: 20,
    dbShutdownTimeoutMs: 20,
    setExitCode: (code) => exitCodes.push(code),
    terminateProcess: (code) => terminationCalls.push(code),
  });

  void manager.startServer();
  await manager.shutdown("SIGTERM");

  assert.deepStrictEqual(terminationCalls, [1], "terminateProcess(1) was invoked");
  assert.ok(
    logger.logs.some(([level, ...args]) => level === "error" && args.join(" ").includes("Server shutdown was incomplete; terminating process")),
    "logged forced process termination warning",
  );
});

test("Issue 1: terminateProcess is NOT called when shutdown completes gracefully", async () => {
  const db = {
    async query() {
      return { rows: [{ now: new Date() }] };
    },
    async end() {},
  };

  const logger = createMockLogger();
  const terminationCalls = [];

  const manager = createServerManager({
    port: 9999,
    db,
    redisManager: createMockRedisManager(),
    httpModule: createMockHttpModule(),
    websocketService: createMockWebSocketService(),
    logger,
    terminateProcess: (code) => terminationCalls.push(code),
  });

  await manager.startServer();
  await manager.shutdown("SIGTERM");

  assert.strictEqual(terminationCalls.length, 0, "terminateProcess was NOT called on graceful shutdown");
  assert.ok(
    logger.logs.some(([level, ...args]) => level === "log" && args.join(" ").includes("Shutdown complete.")),
    "logged graceful shutdown complete",
  );
});

test("Issue 1 (Process Termination): child process with unresolved PostgreSQL query and active handles exits on SIGTERM within bounded period", async () => {
  const { spawn } = require("child_process");

  const childCode = `
    const net = require("net");
    const { createServerManager } = require("./server");

    // Create an active TCP socket handle that would keep the event loop alive forever
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const socket = net.connect(server.address().port, "127.0.0.1", () => {
        const db = {
          query: () => new Promise(() => {}),
          end: () => new Promise(() => {}),
        };

        const manager = createServerManager({
          port: 0,
          db,
          startupTimeoutMs: 50,
          dbShutdownTimeoutMs: 50,
          terminateProcess: (code) => {
            process.exit(code);
          },
        });

        process.once("SIGTERM", () => {
          void manager.shutdown("SIGTERM");
        });

        void manager.startServer();
        console.log("CHILD_READY");
      });
    });
  `;

  const child = spawn(process.execPath, ["-e", childCode], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: __dirname + "/..",
  });

  let output = "";
  let errOutput = "";
  let sigtermSent = false;

  child.stdout.on("data", (d) => {
    output += d.toString();
    if (!sigtermSent && output.includes("CHILD_READY")) {
      sigtermSent = true;
      child.kill("SIGTERM");
    }
  });

  child.stderr.on("data", (d) => {
    errOutput += d.toString();
  });

  let timedOut = false;
  const timeoutPromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      resolve({ code: -1, signal: "TIMED_OUT" });
    }, 5000);
    timer.unref?.();
  });

  const exitPromise = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  const result = await Promise.race([exitPromise, timeoutPromise]);

  assert.strictEqual(timedOut, false, "child process exited before safety timeout");
  assert.strictEqual(result.code, 1, "child process exited with code 1");
  assert.ok(
    errOutput.includes("PostgreSQL connection pool shutdown did not settle before deadline") ||
    errOutput.includes("Server startup did not settle before shutdown deadline"),
    "stderr contains diagnostic timeout warning",
  );
  assert.ok(
    errOutput.includes("Server shutdown was incomplete; terminating process to release unmanaged handles"),
    "stderr contains forced termination diagnostic",
  );
});
