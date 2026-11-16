const { test } = require("node:test");
const assert = require("node:assert/strict");

const { startDispatcher } = require("../src/workers/order-outbox-dispatcher");

test("always closes Redis and PostgreSQL when dispatcher queue cleanup throws", async () => {
  const calls = [];

  const controller = await startDispatcher({
    db: {
      async end() { calls.push("postgres.close"); },
    },
    redisManager: {
      async closeRedis() { calls.push("redis.close"); },
    },
    createDispatcher: () => ({
      async dispatchBatch() { return { claimed: 0, dispatched: 0, failed: 0 }; },
      stop() { calls.push("dispatcher.stop"); },
      async close() {
        calls.push("queue.close");
        throw new Error("Queue close failed");
      },
    }),
    pollIntervalMs: 60000,
    registerSignals: false,
    logger: { info() {}, warn() {}, error() {} },
  });

  await assert.rejects(controller.shutdown("test"), /Queue close failed/);

  assert.deepEqual(calls, [
    "dispatcher.stop",
    "queue.close",
    "redis.close",
    "postgres.close",
  ]);
});

test("bounds SIGTERM wait for an in-flight batch and still closes every connection", async () => {
  const calls = [];

  const controller = await startDispatcher({
    db: {
      async end() { calls.push("postgres.close"); },
    },
    redisManager: {
      async closeRedis() { calls.push("redis.close"); },
    },
    createDispatcher: () => ({
      dispatchBatch() {
        calls.push("dispatch.started");
        return new Promise(() => {});
      },
      stop() { calls.push("dispatcher.stop"); },
      async close() { calls.push("queue.close"); },
    }),
    pollIntervalMs: 60000,
    shutdownGraceMs: 25,
    queueCloseTimeoutMs: 25,
    registerSignals: false,
    logger: { info() {}, warn(message) { calls.push(message); }, error() {} },
  });

  await controller.shutdown("SIGTERM");

  assert.ok(calls.includes("dispatch.started"));
  assert.ok(calls.includes("dispatcher.stop"));
  assert.ok(calls.includes("queue.close"));
  assert.ok(calls.includes("redis.close"));
  assert.ok(calls.includes("postgres.close"));
});
