const { test } = require("node:test");
const assert = require("node:assert/strict");

const { startOrderWorker } = require("../src/workers/order.worker");
const { ORDER_QUEUE_NAME, ORDER_RECEIPT_JOB } = require("../src/queues/order.queue");

function createMocks({ redisAvailable = true } = {}) {
  const calls = [];

  const rawClient = {
    isOpen: false,
    on() {},
    async connect() {
      calls.push("redis.connect");
      if (!redisAvailable) throw new Error("Redis connection failed");
      this.isOpen = true;
    },
    destroy() {
      calls.push("redis.destroy");
      this.isOpen = false;
    },
  };

  const redisManager = {
    client: {
      duplicate() {
        calls.push("redis.duplicate");
        return rawClient;
      },
    },
    async connectRedis() {
      calls.push("redisManager.connectRedis");
      return redisAvailable;
    },
    async closeRedis() {
      calls.push("redisManager.closeRedis");
    },
  };

  const db = {
    async end() { calls.push("db.end"); },
  };

  class FakeWorker {
    constructor(queueName, processor, options) {
      this.queueName = queueName;
      this.processor = processor;
      this.options = options;
      this.events = {};
      calls.push("worker.created");
    }
    on(event, callback) {
      this.events[event] = callback;
      return this;
    }
    async close() { calls.push("worker.close"); }
  }

  const processReceipt = async (job) => {
    calls.push(`receipt:${job.data.orderId}`);
    return { receiptId: "receipt-1" };
  };

  return {
    dependencies: {
      redisManager,
      db,
      WorkerClass: FakeWorker,
      createReceiptProcessor: () => processReceipt,
      createRedisConnection: (client) => ({ client, adapter: true }),
      logger: { info() {}, error() {} },
      registerSignals: false,
    },
    calls,
  };
}

test("starts the order worker with the correct queue and concurrency", async () => {
  const mocks = createMocks();
  const result = await startOrderWorker(mocks.dependencies);

  assert.equal(result.worker.queueName, ORDER_QUEUE_NAME);
  assert.equal(result.worker.options.concurrency, 5);
  assert.equal(result.worker.options.connection.adapter, true);
  assert.ok(mocks.calls.includes("worker.created"));

  await result.shutdown();
});

test("processes a valid order receipt job", async () => {
  const mocks = createMocks();
  const { worker, shutdown } = await startOrderWorker(mocks.dependencies);

  const result = await worker.processor({
    name: ORDER_RECEIPT_JOB,
    data: { orderId: "101" },
  });

  assert.deepEqual(result, { receiptId: "receipt-1" });
  assert.ok(mocks.calls.includes("receipt:101"));
  await shutdown();
});

test("rejects unsupported job types", async () => {
  const mocks = createMocks();
  const { worker, shutdown } = await startOrderWorker(mocks.dependencies);

  await assert.rejects(worker.processor({
    name: "unknown-job",
    data: { orderId: "101" },
  }), /Unsupported job/);

  await shutdown();
});

test("fails when Redis is unavailable", async () => {
  const mocks = createMocks({ redisAvailable: false });

  await assert.rejects(startOrderWorker(mocks.dependencies), /Redis is unavailable/);
  assert.ok(mocks.calls.includes("redisManager.connectRedis"));
  assert.ok(!mocks.calls.includes("worker.created"));
  assert.ok(mocks.calls.includes("redisManager.closeRedis"));
});

test("cleans up Redis connections when worker startup fails", async () => {
  const mocks = createMocks();

  class FailingWorker {
    constructor() { throw new Error("Worker initialization failed"); }
  }

  await assert.rejects(startOrderWorker({
    ...mocks.dependencies,
    WorkerClass: FailingWorker,
  }), /Worker initialization failed/);

  assert.ok(mocks.calls.includes("redis.destroy"));
  assert.ok(mocks.calls.includes("redisManager.closeRedis"));
});

test("gracefully shuts down worker, its dedicated Redis client and database", async () => {
  const mocks = createMocks();
  const { shutdown } = await startOrderWorker(mocks.dependencies);

  await shutdown("test shutdown");

  assert.ok(mocks.calls.includes("worker.close"));
  assert.ok(mocks.calls.includes("redis.destroy"));
  assert.ok(mocks.calls.includes("redisManager.closeRedis"));
  assert.ok(mocks.calls.includes("db.end"));

  assert.ok(mocks.calls.indexOf("worker.close") < mocks.calls.indexOf("redis.destroy"));
  assert.ok(mocks.calls.indexOf("redis.destroy") < mocks.calls.indexOf("redisManager.closeRedis"));
  assert.ok(mocks.calls.indexOf("redisManager.closeRedis") < mocks.calls.indexOf("db.end"));
});

test("does not perform shutdown more than once", async () => {
  const mocks = createMocks();
  const { shutdown } = await startOrderWorker(mocks.dependencies);

  await shutdown();
  await shutdown();

  assert.equal(mocks.calls.filter((call) => call === "worker.close").length, 1);
  assert.equal(mocks.calls.filter((call) => call === "redis.destroy").length, 1);
  assert.equal(mocks.calls.filter((call) => call === "redisManager.closeRedis").length, 1);
  assert.equal(mocks.calls.filter((call) => call === "db.end").length, 1);
});
