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

      if (sql.includes("SET locked_until = CURRENT_TIMESTAMP")) {
        return { rows: (params?.[2] || []).map((id) => ({ id })) };
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

test("stops a batch when lease renewal stalls without starting another renewal", async () => {
  const renewalStarted = [];
  const db = {
    async query(sql) {
      if (sql.includes("WITH candidates AS")) {
        return { rows: [event(12, 312)] };
      }

      if (sql.includes("SET locked_until = CURRENT_TIMESTAMP")) {
        renewalStarted.push(Date.now());
        return new Promise(() => {});
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const dispatcher = createOrderOutboxDispatcher({
    db,
    leaseRenewalIntervalMs: 5,
    leaseRenewalTimeoutMs: 20,
    redisManager: {
      isRedisReady() { return true; },
      async connectRedis() { return true; },
    },
    createQueue: async () => {
      throw new Error("Queue must not be created after renewal stalls");
    },
  });

  const result = await dispatcher.dispatchBatch();

  assert.deepEqual(result, { claimed: 1, dispatched: 0, failed: 1 });
  assert.equal(renewalStarted.length, 1);

  await dispatcher.close();
});

test("stops an event when per-event renewal before enqueue stalls without enqueuing or releasing the claim", async () => {
  const renewalStarted = [];
  let enqueued = false;
  let released = false;

  const db = {
    async query(sql, params) {
      if (sql.includes("WITH candidates AS")) {
        return { rows: [event(13, 313)] };
      }

      if (sql.includes("SET locked_until = CURRENT_TIMESTAMP")) {
        renewalStarted.push(Date.now());
        if (renewalStarted.length === 1) {
          return { rows: (params?.[2] || []).map((id) => ({ id })) };
        }
        return new Promise(() => {});
      }

      if (sql.includes("SET status = 'pending'")) {
        released = true;
        return { rowCount: 0, rows: [] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const dispatcher = createOrderOutboxDispatcher({
    db,
    leaseRenewalIntervalMs: 5,
    leaseRenewalTimeoutMs: 20,
    redisManager: {
      isRedisReady() { return true; },
      async connectRedis() { return true; },
    },
    createQueue: async () => ({
      async enqueueOrderReceipt() {
        enqueued = true;
      },
      async close() {},
    }),
  });

  const startedAt = Date.now();
  const result = await dispatcher.dispatchBatch();
  const elapsedMs = Date.now() - startedAt;

  assert.deepEqual(result, { claimed: 1, dispatched: 0, failed: 1 });
  assert.equal(renewalStarted.length, 2);
  assert.equal(enqueued, false);
  assert.equal(released, false);
  assert.ok(elapsedMs < 500, `Expected dispatchBatch to finish near the renewal timeout, took ${elapsedMs}ms`);

  await dispatcher.close();
});



test("heartbeat renews remaining batch claims after joining a per-event renewal", async () => {
  const renewalCandidateSets = [];
  let signalPerEventRenewalStarted;
  let signalRemainingRenewalStarted;
  let releaseEnqueue;
  const perEventRenewalStarted = new Promise((resolve) => {
    signalPerEventRenewalStarted = resolve;
  });
  const remainingRenewalStarted = new Promise((resolve) => {
    signalRemainingRenewalStarted = resolve;
  });
  const enqueueGate = new Promise((resolve) => {
    releaseEnqueue = resolve;
  });

  const db = {
    async query(sql, params) {
      if (sql.includes("WITH candidates AS")) {
        return { rows: [event(21, 421), event(22, 422)] };
      }

      if (sql.includes("SET locked_until = CURRENT_TIMESTAMP")) {
        const ids = (params?.[2] || []).map(String);
        renewalCandidateSets.push(ids);

        if (renewalCandidateSets.length === 2) {
          signalPerEventRenewalStarted();
          // Keep the per-event renewal in flight until the heartbeat joins it.
          await new Promise((resolve) => setTimeout(resolve, 150));
        }

        if (renewalCandidateSets.length === 3) {
          signalRemainingRenewalStarted();
        }

        return { rows: ids.map((id) => ({ id })) };
      }

      if (sql.includes("SET status = 'dispatched'")) {
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const dispatcher = createOrderOutboxDispatcher({
    db,
    leaseRenewalIntervalMs: 100,
    leaseRenewalTimeoutMs: 1000,
    enqueueTimeoutMs: 2000,
    redisManager: {
      isRedisReady() { return true; },
      async connectRedis() { return true; },
    },
    createQueue: async () => ({
      async enqueueOrderReceipt(orderId) {
        if (String(orderId) === "421") {
          await enqueueGate;
        }
      },
      async close() {},
    }),
  });

  const dispatchPromise = dispatcher.dispatchBatch();
  await perEventRenewalStarted;

  try {
    await Promise.race([
      remainingRenewalStarted,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("Heartbeat did not renew the remaining batch claim")),
        1000,
      )),
    ]);

    assert.deepEqual(
      renewalCandidateSets[2],
      ["22"],
      "heartbeat must renew the still-pending event after sharing the event-21 renewal",
    );
  } finally {
    releaseEnqueue();
  }

  const result = await dispatchPromise;
  assert.deepEqual(result, { claimed: 2, dispatched: 2, failed: 0 });
  assert.deepEqual(renewalCandidateSets.slice(0, 3), [
    ["21", "22"],
    ["21"],
    ["22"],
  ]);

  await dispatcher.close();
});

test("waits for an in-flight batch renewal before enqueueing without starting an overlapping renewal", async () => {
  const renewalCandidateSets = [];
  const enqueued = [];
  let inFlightRenewal = 0;
  let maxConcurrentRenewals = 0;
  let sharedRenewalResolved = false;
  let resolveBatchRenewal;
  let signalBatchRenewalStarted;
  const batchRenewalStarted = new Promise((resolve) => {
    signalBatchRenewalStarted = resolve;
  });

  const db = {
    async query(sql, params) {
      if (sql.includes("WITH candidates AS")) {
        return { rows: [event(14, 314)] };
      }

      if (sql.includes("SET locked_until = CURRENT_TIMESTAMP")) {
        const ids = (params?.[2] || []).map(String);
        renewalCandidateSets.push(ids);
        inFlightRenewal += 1;
        maxConcurrentRenewals = Math.max(maxConcurrentRenewals, inFlightRenewal);

        try {
          // Query 1: initial batch renewal before ensureQueue().
          // Query 2: background heartbeat renewal started while createQueue()
          //          is pending; per-event renewal before enqueue waits on it.
          if (renewalCandidateSets.length === 2) {
            signalBatchRenewalStarted();
            await new Promise((resolve) => {
              resolveBatchRenewal = resolve;
            });
            sharedRenewalResolved = true;
          }

          return { rows: ids.map((id) => ({ id })) };
        } finally {
          inFlightRenewal -= 1;
        }
      }

      if (sql.includes("SET status = 'dispatched'")) {
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const dispatcher = createOrderOutboxDispatcher({
    db,
    leaseRenewalIntervalMs: 5,
    leaseRenewalTimeoutMs: 200,
    redisManager: {
      isRedisReady() { return true; },
      async connectRedis() { return true; },
    },
    createQueue: async () => {
      await batchRenewalStarted;
      // Allow the in-flight batch renewal to settle shortly after the
      // per-event renewal before enqueue begins waiting on renewalPromise.
      setTimeout(() => resolveBatchRenewal(), 10);

      return {
        async enqueueOrderReceipt(orderId) {
          assert.equal(
            sharedRenewalResolved,
            true,
            "event must not be enqueued until the in-flight shared renewal confirms its ID",
          );
          enqueued.push(String(orderId));
        },
        async close() {},
      };
    },
  });

  const result = await dispatcher.dispatchBatch();

  assert.deepEqual(result, { claimed: 1, dispatched: 1, failed: 0 });
  assert.deepEqual(enqueued, ["314"]);
  assert.equal(maxConcurrentRenewals, 1, "renewal queries must never overlap");
  assert.deepEqual(renewalCandidateSets, [["14"], ["14"]]);

  await dispatcher.close();
});

test("times out when per-event renewal waits on a shared renewal that never settles", async () => {
  const renewalStarted = [];
  let enqueued = false;
  let released = false;
  let signalSharedRenewalStarted;
  const sharedRenewalStarted = new Promise((resolve) => {
    signalSharedRenewalStarted = resolve;
  });

  const db = {
    async query(sql, params) {
      if (sql.includes("WITH candidates AS")) {
        return { rows: [event(16, 316)] };
      }

      if (sql.includes("SET locked_until = CURRENT_TIMESTAMP")) {
        renewalStarted.push(Date.now());
        if (renewalStarted.length === 1) {
          return { rows: (params?.[2] || []).map((id) => ({ id })) };
        }
        signalSharedRenewalStarted();
        return new Promise(() => {});
      }

      if (sql.includes("SET status = 'pending'")) {
        released = true;
        return { rowCount: 0, rows: [] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const dispatcher = createOrderOutboxDispatcher({
    db,
    leaseRenewalIntervalMs: 5,
    leaseRenewalTimeoutMs: 25,
    redisManager: {
      isRedisReady() { return true; },
      async connectRedis() { return true; },
    },
    createQueue: async () => {
      await sharedRenewalStarted;
      return {
        async enqueueOrderReceipt() {
          enqueued = true;
        },
        async close() {},
      };
    },
  });

  const startedAt = Date.now();
  const result = await dispatcher.dispatchBatch();
  const elapsedMs = Date.now() - startedAt;

  assert.deepEqual(result, { claimed: 1, dispatched: 0, failed: 1 });
  assert.equal(renewalStarted.length, 2);
  assert.equal(enqueued, false);
  assert.equal(released, false);
  assert.ok(elapsedMs < 500, `Expected dispatchBatch to finish near the renewal timeout, took ${elapsedMs}ms`);

  await dispatcher.close();
});

test("does not enqueue when a shared renewal completes without returning the requested event ID", async () => {
  const renewalCalls = [];
  let enqueued = false;
  let released = false;
  let resolveSharedRenewal;
  let signalSharedRenewalStarted;
  const sharedRenewalStarted = new Promise((resolve) => {
    signalSharedRenewalStarted = resolve;
  });

  const db = {
    async query(sql, params) {
      if (sql.includes("WITH candidates AS")) {
        return { rows: [event(17, 317)] };
      }

      if (sql.includes("SET locked_until = CURRENT_TIMESTAMP")) {
        renewalCalls.push((params?.[2] || []).map(String));
        if (renewalCalls.length === 1) {
          return { rows: (params?.[2] || []).map((id) => ({ id })) };
        }
        signalSharedRenewalStarted();
        await new Promise((resolve) => {
          resolveSharedRenewal = resolve;
        });
        return { rows: [] };
      }

      if (sql.includes("SET status = 'pending'")) {
        released = true;
        return { rowCount: 0, rows: [] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const dispatcher = createOrderOutboxDispatcher({
    db,
    leaseRenewalIntervalMs: 5,
    leaseRenewalTimeoutMs: 200,
    redisManager: {
      isRedisReady() { return true; },
      async connectRedis() { return true; },
    },
    createQueue: async () => {
      await sharedRenewalStarted;
      setTimeout(() => resolveSharedRenewal(), 10);
      return {
        async enqueueOrderReceipt() {
          enqueued = true;
        },
        async close() {},
      };
    },
  });

  const result = await dispatcher.dispatchBatch();

  assert.deepEqual(result, { claimed: 1, dispatched: 0, failed: 1 });
  assert.equal(renewalCalls.length, 2);
  assert.equal(enqueued, false);
  assert.equal(released, false);

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

      if (sql.includes("SET locked_until = CURRENT_TIMESTAMP")) {
        return { rows: (params?.[2] || []).map((id) => ({ id })) };
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
    async query(sql, params) {
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

      if (sql.includes("SET locked_until = CURRENT_TIMESTAMP")) {
        return { rows: (params?.[2] || []).map((id) => ({ id })) };
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
const { startDispatcher } = require("../src/workers/order-outbox-dispatcher");

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

// Restrict only the dispatcher claim query to one fixture order. The shared
// test database can contain unrelated outbox rows, but the SQL's ordering,
// SKIP LOCKED, lease expiry and claim-token logic stay unchanged.
function scopeClaimQueryToOrder(sql, params, orderId) {
  if (!sql.includes("WITH candidates AS")) return [sql, params];

  const scopedSql = sql.replace(
    "FROM order_outbox\n         WHERE",
    "FROM order_outbox\n         WHERE order_id = ANY($4::bigint[]) AND (",
  ).replace(
    "           OR\n           (status = 'processing' AND locked_until < CURRENT_TIMESTAMP)\n         ORDER BY id",
    "           OR\n           (status = 'processing' AND locked_until < CURRENT_TIMESTAMP)\n           )\n         ORDER BY id",
  );

  if (
    !scopedSql.includes("order_id = ANY($4::bigint[]) AND (") ||
    !scopedSql.includes("           )\n         ORDER BY id")
  ) {
    throw new Error("Could not scope the outbox claim query to the fixture order");
  }

  return [scopedSql, [...params, [orderId]]];
}

async function waitForQueueJob(queue, jobId, state, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const currentState = await queue.getJobState(jobId);
    if (currentState === state) {
      const job = await queue.getJob(jobId);
      if (job) return job;
    }
    if (currentState === "failed" && state !== "failed") {
      const failedJob = await queue.getJob(jobId);
      throw new Error(`Job ${jobId} failed: ${failedJob?.failedReason}`);
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

    const dbForDispatcherA = {
      async query(sql, params) {
        const [scopedSql, scopedParams] = scopeClaimQueryToOrder(sql, params, fixture.orderId);
        return integrationPool.query(scopedSql, scopedParams);
      },
    };

    dispatcherA = createOrderOutboxDispatcher({
      db: dbForDispatcherA,
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
        const [scopedSql, scopedParams] = scopeClaimQueryToOrder(sql, params, fixture.orderId);
        const result = await integrationPool.query(scopedSql, scopedParams);
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

    await inspectRedis.connectRedis();
    inspectionQueue = await createOrderQueue({ redisManager: inspectRedis });
    await inspectionQueue.queue.waitUntilReady();
    await waitForQueueJob(
      inspectionQueue.queue,
      `order-${fixture.orderId}`,
      "completed",
    );

    // The two dispatchers used the same stable job ID. While that completed
    // job is retained, the second enqueue must not create another copy.
    const retainedJob = await inspectionQueue.queue.getJob(`order-${fixture.orderId}`);
    assert.ok(retainedJob, "completed BullMQ job should remain retained");
    const retainedJobs = await inspectionQueue.queue.getJobs(
      ["waiting", "active", "completed", "failed"],
      0,
      -1,
    );
    assert.equal(
      retainedJobs.filter((job) => job.id === `order-${fixture.orderId}`).length,
      1,
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


test("SIGTERM bounds a stalled enqueue, releases its claim, and closes Redis/PostgreSQL", {
  timeout: 30000,
  skip: testDatabaseUrl
    ? false
    : "Requires TEST_DATABASE_URL for the shutdown/lease recovery integration test.",
}, async () => {
  const shutdownPool = new Pool({
    connectionString: testDatabaseUrl,
    max: 2,
  });

  let fixture;
  let controller;
  let queueClosed = false;
  let redisClosed = false;
  let databaseClosed = false;
  let signalEnqueueStarted;

  const enqueueStarted = new Promise((resolve) => {
    signalEnqueueStarted = resolve;
  });

  const redisManager = {
    isRedisReady() { return true; },
    async connectRedis() { return true; },
    async closeRedis() { redisClosed = true; },
  };

  const shutdownDb = {
    async query(sql, params = []) {
      if (sql.includes("WITH candidates AS")) {
        const result = await shutdownPool.query(
          `WITH candidates AS (
            SELECT id
            FROM order_outbox
            WHERE order_id = $4
              AND (
                (status = 'pending' AND available_at <= CURRENT_TIMESTAMP)
                OR
                (status = 'processing' AND locked_until < CURRENT_TIMESTAMP)
              )
            ORDER BY id
            LIMIT $1
            FOR UPDATE SKIP LOCKED
          )
          UPDATE order_outbox AS events
          SET status = 'processing',
              attempts = attempts + 1,
              locked_until = CURRENT_TIMESTAMP + ($2 * INTERVAL '1 second'),
              claim_token = $3::uuid,
              updated_at = CURRENT_TIMESTAMP
          FROM candidates
          WHERE events.id = candidates.id
          RETURNING events.id, events.order_id, events.payload,
                    events.attempts, events.claim_token`,
          [...params, fixture.orderId],
        );

        return result;
      }

      return shutdownPool.query(sql, params);
    },
    async end() {
      databaseClosed = true;
      await shutdownPool.end();
    },
  };

  try {
    fixture = await createLeaseTestOrder(integrationPool);

    controller = await startDispatcher({
      db: shutdownDb,
      redisManager,
      createDispatcher: (options) => createOrderOutboxDispatcher({
        ...options,
        db: shutdownDb,
        redisManager,
        batchSize: 1,
        leaseSeconds: 60,
        enqueueTimeoutMs: 50,
        createQueue: async () => ({
          enqueueOrderReceipt() {
            signalEnqueueStarted();
            // Represents a Redis/BullMQ call that never responds. The
            // dispatcher's timeout must release this claim for recovery.
            return new Promise(() => {});
          },
          async close() {
            queueClosed = true;
          },
        }),
      }),
      pollIntervalMs: 60000,
      shutdownGraceMs: 1000,
      queueCloseTimeoutMs: 1000,
      registerSignals: false,
      logger: { info() {}, warn() {}, error() {} },
    });

    await Promise.race([
      enqueueStarted,
      pause(5000).then(() => {
        throw new Error("Dispatcher never began the in-flight enqueue");
      }),
    ]);

    await controller.shutdown("SIGTERM");

    assert.equal(queueClosed, true);
    assert.equal(redisClosed, true);
    assert.equal(databaseClosed, true);

    const recovered = await integrationPool.query(
      `SELECT status, claim_token, last_error
       FROM order_outbox
       WHERE order_id = $1`,
      [fixture.orderId],
    );

    assert.equal(recovered.rows[0].status, "pending");
    assert.equal(recovered.rows[0].claim_token, null);
    assert.match(recovered.rows[0].last_error, /Timed out enqueueing receipt job/);
  } finally {
    if (controller && !databaseClosed) {
      await controller.shutdown("test cleanup").catch(() => {});
    }
    if (!databaseClosed) {
      await shutdownPool.end().catch(() => {});
    }
    if (!redisClosed) {
      await redisManager.closeRedis().catch(() => {});
    }
    await cleanupLeaseTestOrder(integrationPool, fixture);
  }
});
