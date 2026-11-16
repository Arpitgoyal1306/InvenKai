const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createOrderOutboxDispatcher,
} = require("../src/services/order-outbox-dispatcher.service");

const TOKEN = "11111111-1111-4111-8111-111111111111";

function createMocks({
  redisInitiallyReady = true,
  redisConnectResults = [true],
  events = [],
  failMarkDispatched = false,
} = {}) {
  const queries = [];
  const enqueuedOrders = [];
  const queueCloseCount = { value: 0 };

  let redisReady = redisInitiallyReady;
  let redisConnectCalls = 0;
  let markDispatchedCalls = 0;

  const db = {
    async query(sql, params) {
      queries.push({ sql, params });

      if (sql.includes("WITH candidates AS")) {
        return { rows: events };
      }

      if (sql.includes("SET status = 'dispatched'")) {
        markDispatchedCalls += 1;

        if (failMarkDispatched && markDispatchedCalls === 1) {
          throw new Error("Database update failed");
        }

        return { rows: [] };
      }

      if (sql.includes("SET status = 'pending'")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const redisManager = {
    isRedisReady() {
      return redisReady;
    },

    async connectRedis() {
      const result = redisConnectResults[redisConnectCalls] ?? false;
      redisConnectCalls += 1;
      redisReady = result;
      return result;
    },
  };

  async function createQueue() {
    return {
      async enqueueOrderReceipt(orderId) {
        enqueuedOrders.push(String(orderId));
      },
      async close() {
        queueCloseCount.value += 1;
      },
    };
  }

  return {
    db,
    redisManager,
    createQueue,
    queries,
    enqueuedOrders,
    queueCloseCount,
    get redisConnectCalls() { return redisConnectCalls; },
    get markDispatchedCalls() { return markDispatchedCalls; },
  };
}

function event(id, orderId, attempts = 1) {
  return {
    id: String(id),
    order_id: String(orderId),
    payload: { orderId: String(orderId) },
    attempts,
    claim_token: TOKEN,
  };
}

test("dispatcher recovers when Redis becomes available", async () => {
  const mocks = createMocks({
    redisInitiallyReady: false,
    redisConnectResults: [false, true],
    events: [event(1, 101)],
  });

  const dispatcher = createOrderOutboxDispatcher({
    db: mocks.db,
    redisManager: mocks.redisManager,
    createQueue: mocks.createQueue,
  });

  const firstResult = await dispatcher.dispatchBatch();
  assert.deepEqual(firstResult, { claimed: 1, dispatched: 0, failed: 1 });
  assert.deepEqual(mocks.enqueuedOrders, []);

  const secondResult = await dispatcher.dispatchBatch();
  assert.deepEqual(secondResult, { claimed: 1, dispatched: 1, failed: 0 });
  assert.deepEqual(mocks.enqueuedOrders, ["101"]);
  assert.equal(mocks.redisConnectCalls, 2);

  await dispatcher.close();
});

test("releases event when marking dispatched fails after enqueue", async () => {
  const mocks = createMocks({
    failMarkDispatched: true,
    events: [event(1, 101)],
  });

  const dispatcher = createOrderOutboxDispatcher({
    db: mocks.db,
    redisManager: mocks.redisManager,
    createQueue: mocks.createQueue,
  });

  const result = await dispatcher.dispatchBatch();

  assert.deepEqual(result, { claimed: 1, dispatched: 0, failed: 1 });
  assert.deepEqual(mocks.enqueuedOrders, ["101"]);
  assert.ok(mocks.queries.some((query) => query.sql.includes("SET status = 'pending'")));
  assert.equal(mocks.queueCloseCount.value, 1);

  const markQuery = mocks.queries.find((query) => query.sql.includes("SET status = 'dispatched'"));
  const retryQuery = mocks.queries.find((query) => query.sql.includes("SET status = 'pending'"));
  assert.match(markQuery.sql, /claim_token = \$2::uuid/);
  assert.match(retryQuery.sql, /claim_token = \$3::uuid/);
  assert.equal(markQuery.params[1], TOKEN);
  assert.equal(retryQuery.params[2], TOKEN);

  await dispatcher.close();
});

test("reclaims expired processing events with a new lease token", async () => {
  const mocks = createMocks({ events: [event(5, 205, 3)] });

  const dispatcher = createOrderOutboxDispatcher({
    db: mocks.db,
    redisManager: mocks.redisManager,
    createQueue: mocks.createQueue,
  });

  const result = await dispatcher.dispatchBatch();
  assert.deepEqual(result, { claimed: 1, dispatched: 1, failed: 0 });
  assert.deepEqual(mocks.enqueuedOrders, ["205"]);

  const claimQuery = mocks.queries.find((query) => query.sql.includes("WITH candidates AS"));
  const markQuery = mocks.queries.find((query) => query.sql.includes("SET status = 'dispatched'"));

  assert.match(claimQuery.sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(claimQuery.sql, /locked_until < CURRENT_TIMESTAMP/);
  assert.match(claimQuery.sql, /claim_token = \$3::uuid/);
  assert.match(markQuery.sql, /claim_token = \$2::uuid/);

  await dispatcher.close();
});

test("uses exponential retry scheduling and records the error", async () => {
  const mocks = createMocks({ events: [event(8, 308, 4)] });

  const dispatcher = createOrderOutboxDispatcher({
    db: mocks.db,
    redisManager: {
      isRedisReady() { return true; },
      async connectRedis() { return true; },
    },
    createQueue: async () => ({
      async enqueueOrderReceipt() { throw new Error("Temporary Redis failure"); },
      async close() {},
    }),
  });

  const result = await dispatcher.dispatchBatch();
  assert.deepEqual(result, { claimed: 1, dispatched: 0, failed: 1 });

  const retryQuery = mocks.queries.find((query) => query.sql.includes("SET status = 'pending'"));
  assert.ok(retryQuery);
  assert.match(retryQuery.sql, /POWER\(2, attempts\)/);
  assert.match(retryQuery.sql, /LEAST/);
  assert.match(retryQuery.sql, /claim_token = \$3::uuid/);
  assert.equal(retryQuery.params[0], "8");
  assert.equal(retryQuery.params[1], "Temporary Redis failure");
  assert.equal(retryQuery.params[2], TOKEN);

  await dispatcher.close();
});

test("does not overwrite an outbox lease reclaimed during a slow enqueue", async () => {
  const queries = [];
  let newClaimWasMade = false;

  const db = {
    async query(sql, params) {
      queries.push({ sql, params });

      if (sql.includes("WITH candidates AS")) {
        return {
          rows: [{
            ...event(15, 415, 2),
            claim_token: TOKEN,
          }],
        };
      }

      if (sql.includes("SET status = 'dispatched'")) {
        assert.notEqual(params[1], "99999999-9999-4999-8999-999999999999");
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes("SET status = 'pending'")) {
        return { rowCount: 0, rows: [] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const dispatcher = createOrderOutboxDispatcher({
    db,
    redisManager: {
      isRedisReady: () => true,
      async connectRedis() { return true; },
    },
    createQueue: async () => ({
      async enqueueOrderReceipt() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        newClaimWasMade = true;
      },
      async close() {},
    }),
  });

  const result = await dispatcher.dispatchBatch();

  assert.deepEqual(result, { claimed: 1, dispatched: 0, failed: 1 });
  assert.equal(newClaimWasMade, true);

  const claimQuery = queries.find((query) => query.sql.includes("WITH candidates AS"));
  const markQuery = queries.find((query) => query.sql.includes("SET status = 'dispatched'"));
  const releaseQuery = queries.find((query) => query.sql.includes("SET status = 'pending'"));

  assert.match(claimQuery.sql, /claim_token = \$3::uuid/);
  assert.match(markQuery.sql, /claim_token = \$2::uuid/);
  assert.equal(releaseQuery, undefined, "a stale dispatcher must not release another dispatcher's claim");

  await dispatcher.close();
});


test("continues dispatching the batch when one event cannot be released for retry", async () => {
  const queries = [];
  const logs = [];
  const enqueued = [];
  let releaseCalls = 0;
  let queueCreateCalls = 0;

  const db = {
    async query(sql) {
      queries.push(sql);

      if (sql.includes("WITH candidates AS")) {
        return {
          rows: [
            event(101, 901),
            { ...event(102, 902), id: "102", order_id: "902" },
          ],
        };
      }

      if (sql.includes("SET status = 'pending'")) {
        releaseCalls += 1;
        throw new Error("PostgreSQL temporarily unavailable");
      }

      if (sql.includes("SET status = 'dispatched'")) {
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const dispatcher = createOrderOutboxDispatcher({
    db,
    redisManager: {
      isRedisReady() { return true; },
      async connectRedis() { return true; },
    },
    logger: {
      warn() {},
      error(message) { logs.push(message); },
    },
    createQueue: async () => {
      queueCreateCalls += 1;
      return {
        async enqueueOrderReceipt(orderId) {
          if (String(orderId) === "901") {
            throw new Error("Temporary Redis publish failure");
          }
          enqueued.push(String(orderId));
        },
        async close() {},
      };
    },
  });

  const result = await dispatcher.dispatchBatch();

  assert.deepEqual(result, { claimed: 2, dispatched: 1, failed: 1 });
  assert.equal(releaseCalls, 1);
  assert.deepEqual(enqueued, ["902"]);
  assert.ok(
    logs.some((message) => message.includes("event 101") && message.includes("lease expiry")),
  );
  assert.ok(queueCreateCalls >= 2, "dispatcher creates a fresh queue for the second event");

  await dispatcher.close();
});

 
require("dotenv").config();
const { after } = require("node:test");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const { createOrder } = require("../src/services/order.service");
const { createRedisManager } = require("../src/config/redis");
const { createOrderQueue, ORDER_RECEIPT_JOB } = require("../src/queues/order.queue");
const { startOrderWorker } = require("../src/workers/order.worker");
const { createOrderReceiptProcessor } = require("../src/workers/order-receipt.processor");

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testRedisUrl = process.env.TEST_REDIS_URL;
const integrationPool = testDatabaseUrl
  ? new Pool({ connectionString: testDatabaseUrl, max: 8 })
  : null;

after(async () => {
  if (integrationPool) await integrationPool.end();
});

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForQueueJob(queue, jobId, state, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job) {
      const currentState = await job.getState();
      if (currentState === state) return job;
      if (currentState === "failed" && state !== "failed") {
        throw new Error(`Job ${jobId} failed: ${job.failedReason}`);
      }
    }
    await pause(50);
  }

  throw new Error(`Job ${jobId} did not reach state ${state}`);
}

async function createLeaseTestOrder(db) {
  const suffix = randomUUID();

  const category = await db.query(
    "INSERT INTO categories (name) VALUES ($1) RETURNING id",
    [`lease-test-${suffix}`],
  );
  const user = await db.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    ["Lease Test User", `lease-${suffix}@example.test`, "test-password-hash", "customer"],
  );
  const product = await db.query(
    `INSERT INTO products (category_id, name, sku, price)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [category.rows[0].id, "Lease Test Product", `LEASE-${suffix}`, "12.00"],
  );

  await db.query(
    "INSERT INTO inventory (product_id, quantity) VALUES ($1, $2)",
    [product.rows[0].id, 3],
  );

  const order = await createOrder(
    user.rows[0].id,
    [{ productId: product.rows[0].id, quantity: 1 }],
    db,
    async () => {},
  );

  return {
    orderId: String(order.id),
    categoryId: category.rows[0].id,
    userId: user.rows[0].id,
    productId: product.rows[0].id,
  };
}

async function cleanupLeaseTestOrder(db, fixture) {
  if (!fixture) return;

  await db.query(
    "DELETE FROM receipts WHERE order_id = $1",
    [fixture.orderId],
  );
  await db.query(
    "DELETE FROM order_outbox WHERE order_id = $1",
    [fixture.orderId],
  );
  await db.query(
    "DELETE FROM inventory_transactions WHERE product_id = $1",
    [fixture.productId],
  );
  await db.query("DELETE FROM orders WHERE id = $1", [fixture.orderId]);
  await db.query("DELETE FROM inventory WHERE product_id = $1", [fixture.productId]);
  await db.query("DELETE FROM products WHERE id = $1", [fixture.productId]);
  await db.query("DELETE FROM users WHERE id = $1", [fixture.userId]);
  await db.query("DELETE FROM categories WHERE id = $1", [fixture.categoryId]);
}

test("two real dispatchers reclaim an expired lease without stale updates or duplicate receipts", {
  timeout: 30000,
  skip: testDatabaseUrl && testRedisUrl
    ? false
    : "Requires TEST_DATABASE_URL and TEST_REDIS_URL for PostgreSQL/Redis concurrency verification.",
}, async () => {
  const dispatcherRedisA = createRedisManager({ url: testRedisUrl, logger: { info() {}, warn() {}, error() {} } });
  const dispatcherRedisB = createRedisManager({ url: testRedisUrl, logger: { info() {}, warn() {}, error() {} } });
  const workerRedis = createRedisManager({ url: testRedisUrl, logger: { info() {}, warn() {}, error() {} } });
  const inspectRedis = createRedisManager({ url: testRedisUrl, logger: { info() {}, warn() {}, error() {} } });
  const workerPool = new Pool({ connectionString: testDatabaseUrl, max: 3 });

  let fixture;
  let workerResources;
  let dispatcherA;
  let dispatcherB;
  let inspectionQueue;
  let resumeA;
  let dispatchAPromise;
  let resolveAEnqueued;
  let claimTokenB;

  const aEnqueued = new Promise((resolve) => {
    resolveAEnqueued = resolve;
  });
  const holdA = new Promise((resolve) => {
    resumeA = resolve;
  });

  try {
    fixture = await createLeaseTestOrder(integrationPool);

    workerResources = await startOrderWorker({
      redisManager: workerRedis,
      db: workerPool,
      createReceiptProcessor: () => createOrderReceiptProcessor({ db: workerPool }),
      logger: { info() {}, warn() {}, error() {} },
      registerSignals: false,
    });
    await workerResources.worker.waitUntilReady();

    dispatcherA = createOrderOutboxDispatcher({
      db: integrationPool,
      redisManager: dispatcherRedisA,
      leaseSeconds: 1,
      batchSize: 1,
      logger: { info() {}, warn() {}, error() {} },
      createQueue: async () => {
        const resources = await createOrderQueue({ redisManager: dispatcherRedisA });
        return {
          async enqueueOrderReceipt(orderId) {
            const job = await resources.enqueueOrderReceipt(orderId);
            resolveAEnqueued(job);
            await holdA;
            return job;
          },
          close: () => resources.close(),
        };
      },
    });

    const dbForDispatcherB = {
      async query(sql, params) {
        const result = await integrationPool.query(sql, params);
        if (sql.includes("WITH candidates AS") && result.rows[0]) {
          claimTokenB = result.rows[0].claim_token;
        }
        return result;
      },
    };

    dispatcherB = createOrderOutboxDispatcher({
      db: dbForDispatcherB,
      redisManager: dispatcherRedisB,
      leaseSeconds: 1,
      batchSize: 1,
      logger: { info() {}, warn() {}, error() {} },
      createQueue: () => createOrderQueue({ redisManager: dispatcherRedisB }),
    });

    dispatchAPromise = dispatcherA.dispatchBatch();

    // A has committed the real BullMQ job but pauses before returning to the
    // dispatcher, which deliberately holds markDispatched().
    const firstJob = await Promise.race([
      aEnqueued,
      pause(5000).then(() => { throw new Error("Dispatcher A did not enqueue"); }),
    ]);
    assert.equal(firstJob.id, `order-${fixture.orderId}`);

    const claimA = await integrationPool.query(
      "SELECT claim_token, status FROM order_outbox WHERE order_id = $1",
      [fixture.orderId],
    );
    const claimTokenA = claimA.rows[0].claim_token;
    assert.equal(claimA.rows[0].status, "processing");

    // Simulate a lease expiring without sleeping for 60 seconds.
    await integrationPool.query(
      `UPDATE order_outbox
       SET locked_until = CURRENT_TIMESTAMP - INTERVAL '1 second'
       WHERE order_id = $1 AND status = 'processing'`,
      [fixture.orderId],
    );

    const resultB = await dispatcherB.dispatchBatch();
    assert.deepEqual(resultB, { claimed: 1, dispatched: 1, failed: 0 });
    assert.ok(claimTokenB);
    assert.notEqual(claimTokenA, claimTokenB, "reclaim must issue a new claim token");

    const afterB = await integrationPool.query(
      "SELECT status, claim_token, attempts FROM order_outbox WHERE order_id = $1",
      [fixture.orderId],
    );
    assert.equal(afterB.rows[0].status, "dispatched");
    assert.equal(afterB.rows[0].claim_token, null);
    assert.equal(Number(afterB.rows[0].attempts), 2);

    // A resumes after B owns and completes the event. Its token-guarded update
    // must affect zero rows, and it must not release B's completed row.
    resumeA();
    const resultA = await dispatchAPromise;
    assert.deepEqual(resultA, { claimed: 1, dispatched: 0, failed: 1 });

    const finalOutbox = await integrationPool.query(
      "SELECT status, claim_token FROM order_outbox WHERE order_id = $1",
      [fixture.orderId],
    );
    assert.equal(finalOutbox.rows[0].status, "dispatched");
    assert.equal(finalOutbox.rows[0].claim_token, null);

    inspectionQueue = await createOrderQueue({ redisManager: inspectRedis });
    await inspectionQueue.queue.waitUntilReady();
    await waitForQueueJob(
      inspectionQueue.queue,
      `order-${fixture.orderId}`,
      "completed",
    );

    // Deliver a second, distinct job for the same order. The unique receipt
    // order_id and ON CONFLICT path must still leave exactly one receipt.
    const replayJob = await inspectionQueue.queue.add(
      ORDER_RECEIPT_JOB,
      { orderId: fixture.orderId },
      { jobId: `lease-test-replay-${fixture.orderId}`, attempts: 1 },
    );
    await waitForQueueJob(inspectionQueue.queue, replayJob.id, "completed");

    const receipts = await integrationPool.query(
      "SELECT id FROM receipts WHERE order_id = $1",
      [fixture.orderId],
    );
    assert.equal(receipts.rowCount, 1);
  } finally {
    resumeA?.();

    if (dispatchAPromise) {
      await Promise.race([dispatchAPromise.catch(() => {}), pause(5000)]);
    }

    if (inspectionQueue) await inspectionQueue.close().catch(() => {});
    if (dispatcherA) await dispatcherA.close().catch(() => {});
    if (dispatcherB) await dispatcherB.close().catch(() => {});
    if (workerResources) {
      await workerResources.shutdown("lease concurrency test").catch(() => {});
    } else {
      await workerPool.end().catch(() => {});
    }

    await dispatcherRedisA.closeRedis().catch(() => {});
    await dispatcherRedisB.closeRedis().catch(() => {});
    await workerRedis.closeRedis().catch(() => {});
    await inspectRedis.closeRedis().catch(() => {});
    await cleanupLeaseTestOrder(integrationPool, fixture);
  }
});
