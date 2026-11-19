const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  startDispatcher,
  REDIS_CLOSE_TIMEOUT_MS,
  DATABASE_CLOSE_TIMEOUT_MS,
} = require("../src/workers/order-outbox-dispatcher");

function createLogger(calls) {
  return {
    info(message) { calls.push("log.info:" + message); },
    warn(message) { calls.push("log.warn:" + message); },
    error(message) { calls.push("log.error:" + message); },
  };
}

function count(calls, value) {
  return calls.filter((item) => item === value).length;
}

function createDispatcherHarness({
  dispatchBatch,
  queueClose,
  redisClose,
  databaseEnd,
  shutdownGraceMs = 50,
  queueCloseTimeoutMs = 50,
  redisCloseTimeoutMs = 30,
  databaseCloseTimeoutMs = 30,
} = {}) {
  const calls = [];
  const terminations = [];
  const logs = [];
  const controllerPromise = startDispatcher({
    db: {
      async end() {
        calls.push("postgres.close");
        if (databaseEnd) return databaseEnd();
      },
    },
    redisManager: {
      async closeRedis() {
        calls.push("redis.close");
        if (redisClose) return redisClose();
      },
    },
    createDispatcher: () => ({
      async dispatchBatch() {
        calls.push("dispatch");
        if (dispatchBatch) return dispatchBatch();
        return { claimed: 0, dispatched: 0, failed: 0 };
      },
      stop() { calls.push("dispatcher.stop"); },
      async close() {
        calls.push("queue.close");
        if (queueClose) return queueClose();
      },
    }),
    pollIntervalMs: 60000,
    shutdownGraceMs,
    queueCloseTimeoutMs,
    redisCloseTimeoutMs,
    databaseCloseTimeoutMs,
    terminateProcess(code) {
      calls.push("process.terminate:" + code);
      terminations.push(code);
    },
    registerSignals: false,
    logger: createLogger(logs),
  });

  return controllerPromise.then((controller) => ({
    controller,
    calls,
    logs,
    terminations,
  }));
}

test("always attempts Redis and PostgreSQL cleanup when dispatcher queue cleanup rejects", async () => {
  const harness = await createDispatcherHarness({
    queueClose: async () => {
      throw new Error("Queue close failed");
    },
  });

  await harness.controller.shutdown("test");

  assert.deepEqual(
    harness.calls.filter((call) =>
      ["dispatcher.stop", "queue.close", "redis.close", "postgres.close", "process.terminate:1"].includes(call)
    ),
    ["dispatcher.stop", "queue.close", "redis.close", "postgres.close", "process.terminate:1"],
  );
  assert.deepEqual(harness.terminations, [1]);
  assert.ok(harness.logs.some((line) => line.includes("Queue cleanup failed")));
});

test("bounds an in-flight batch and escalates while leaving outstanding claims recoverable", async () => {
  const harness = await createDispatcherHarness({
    dispatchBatch: () => new Promise(() => {}),
    shutdownGraceMs: 20,
  });

  const start = Date.now();
  await harness.controller.shutdown("SIGTERM");
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 500, `shutdown should be bounded, took ${elapsed}ms`);
  assert.ok(harness.calls.includes("dispatch"));
  assert.ok(harness.calls.includes("dispatcher.stop"));
  assert.ok(harness.calls.includes("queue.close"));
  assert.ok(harness.calls.includes("redis.close"));
  assert.ok(harness.calls.includes("postgres.close"));
  assert.deepEqual(harness.terminations, [1]);
  assert.ok(harness.logs.some((line) => line.includes("lease expiry")));
});

test("a never-settling Redis close is bounded and PostgreSQL cleanup still runs once", async () => {
  const harness = await createDispatcherHarness({
    redisClose: () => new Promise(() => {}),
    redisCloseTimeoutMs: 20,
  });

  const start = Date.now();
  await harness.controller.shutdown("SIGTERM");
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 500, `shutdown should be bounded, took ${elapsed}ms`);
  assert.equal(count(harness.calls, "queue.close"), 1);
  assert.equal(count(harness.calls, "redis.close"), 1);
  assert.equal(count(harness.calls, "postgres.close"), 1);
  assert.deepEqual(harness.terminations, [1]);
  assert.ok(harness.logs.some((line) => line.includes("Redis cleanup failed")));
  assert.ok(harness.logs.some((line) => line.includes("terminating with exit code 1")));
});

test("a never-settling PostgreSQL close is bounded after Redis cleanup completes", async () => {
  const harness = await createDispatcherHarness({
    databaseEnd: () => new Promise(() => {}),
    databaseCloseTimeoutMs: 20,
  });

  const start = Date.now();
  await harness.controller.shutdown("SIGTERM");
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 500, `shutdown should be bounded, took ${elapsed}ms`);
  assert.equal(count(harness.calls, "queue.close"), 1);
  assert.equal(count(harness.calls, "redis.close"), 1);
  assert.equal(count(harness.calls, "postgres.close"), 1);
  assert.deepEqual(harness.terminations, [1]);
  assert.ok(harness.logs.some((line) => line.includes("PostgreSQL cleanup failed")));
});

test("rejected Redis and PostgreSQL cleanup operations are isolated and each attempted once", async () => {
  const harness = await createDispatcherHarness({
    redisClose: async () => {
      throw new Error("Redis close rejected");
    },
    databaseEnd: async () => {
      throw new Error("PostgreSQL close rejected");
    },
  });

  await harness.controller.shutdown("SIGTERM");

  assert.equal(count(harness.calls, "queue.close"), 1);
  assert.equal(count(harness.calls, "redis.close"), 1);
  assert.equal(count(harness.calls, "postgres.close"), 1);
  assert.deepEqual(harness.terminations, [1]);
  assert.ok(harness.logs.some((line) => line.includes("Redis cleanup failed")));
  assert.ok(harness.logs.some((line) => line.includes("PostgreSQL cleanup failed")));
});

test("repeated shutdown calls share one promise and attempt every cleanup step exactly once", async () => {
  const harness = await createDispatcherHarness();

  const first = harness.controller.shutdown("SIGTERM");
  const second = harness.controller.shutdown("SIGINT");

  assert.equal(first, second);
  await Promise.all([first, second]);

  assert.equal(count(harness.calls, "dispatcher.stop"), 1);
  assert.equal(count(harness.calls, "queue.close"), 1);
  assert.equal(count(harness.calls, "redis.close"), 1);
  assert.equal(count(harness.calls, "postgres.close"), 1);
  assert.deepEqual(harness.terminations, []);
  assert.ok(harness.logs.some((line) => line.includes("Shutdown completed gracefully")));
});

test("exports documented Redis and PostgreSQL cleanup deadlines", () => {
  assert.equal(REDIS_CLOSE_TIMEOUT_MS, 2000);
  assert.equal(DATABASE_CLOSE_TIMEOUT_MS, 3000);
});

test("logs startup and periodic idle health diagnostics without logging every empty poll", async () => {
  const logs = [];
  let pollAttempt = 0;
  const controller = await startDispatcher({
    db: { async end() {} },
    redisManager: { async closeRedis() {} },
    createDispatcher: () => ({
      async dispatchBatch() {
        pollAttempt += 1;
        if (pollAttempt === 2) {
          throw new Error("Temporary database error");
        }
        return { claimed: 0, dispatched: 0, failed: 0 };
      },
      stop() {},
      async close() {},
    }),
    pollIntervalMs: 60000,
    emptyPollLogInterval: 3,
    registerSignals: false,
    logger: createLogger(logs),
  });

  // Poll #1 (startup): empty (count = 1).
  // Poll #2: throws -> resets emptyPollCount to 0.
  await controller.poll();
  // Polls #3 and #4: empty (count = 1, 2) -> must not log idle yet.
  await controller.poll();
  await controller.poll();
  assert.equal(
    logs.filter((line) => line.includes("Outbox idle")).length,
    0,
    "failed poll must reset consecutive empty poll counter",
  );

  // Poll #5: third consecutive successful empty poll -> logs idle once.
  await controller.poll();
  await controller.shutdown("test");

  const startupLogs = logs.filter((line) => line.includes("Started successfully"));
  const idleLogs = logs.filter((line) => line.includes("Outbox idle; 3 consecutive empty polls"));

  assert.equal(startupLogs.length, 1);
  assert.equal(idleLogs.length, 1);
});
