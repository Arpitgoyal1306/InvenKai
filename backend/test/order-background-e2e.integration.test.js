require("dotenv").config();

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");

const { createOrder } = require("../src/services/order.service");
const { createRedisManager } = require("../src/config/redis");
const { createOrderOutboxDispatcher } = require("../src/services/order-outbox-dispatcher.service");
const { createOrderQueue, ORDER_RECEIPT_JOB } = require("../src/queues/order.queue");
const { startOrderWorker } = require("../src/workers/order.worker");
const { createOrderReceiptProcessor } = require("../src/workers/order-receipt.processor");

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL is required");
}
if (process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) {
  throw new Error("Test database must be different from DATABASE_URL");
}

const testPool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  max: 8,
});

after(async () => {
  await testPool.end();
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJobState(queue, jobId, expectedState, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (state === expectedState) return job;
      if (state === "failed") {
        throw new Error(`BullMQ job ${jobId} failed: ${job.failedReason}`);
      }
    }
    await delay(100);
  }

  throw new Error(`BullMQ job ${jobId} did not reach ${expectedState}`);
}

async function waitForReceipt(orderId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await testPool.query(
      "SELECT id FROM receipts WHERE order_id = $1",
      [orderId],
    );
    if (result.rowCount === 1) return result.rows[0];
    await delay(100);
  }

  throw new Error(`Receipt for order ${orderId} was not generated`);
}

async function createFixture() {
  const suffix = randomUUID();
  const category = await testPool.query(
    "INSERT INTO categories (name) VALUES ($1) RETURNING id",
    [`order-e2e-${suffix}`],
  );
  const user = await testPool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    ["Order E2E Test", `order-e2e-${suffix}@example.test`, "test-password-hash", "customer"],
  );
  const product = await testPool.query(
    `INSERT INTO products (category_id, name, sku, price)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [category.rows[0].id, "Order E2E Product", `ORDER-E2E-${suffix}`, "25.00"],
  );
  await testPool.query(
    "INSERT INTO inventory (product_id, quantity) VALUES ($1, $2)",
    [product.rows[0].id, 4],
  );

  return {
    categoryId: category.rows[0].id,
    userId: user.rows[0].id,
    productId: product.rows[0].id,
  };
}

async function cleanupFixture(fixture) {
  if (!fixture) return;

  await testPool.query(
    "DELETE FROM receipts WHERE order_id IN (SELECT id FROM orders WHERE user_id = $1)",
    [fixture.userId],
  );
  await testPool.query(
    "DELETE FROM order_outbox WHERE order_id IN (SELECT id FROM orders WHERE user_id = $1)",
    [fixture.userId],
  );
  await testPool.query("DELETE FROM inventory_transactions WHERE product_id = $1", [fixture.productId]);
  await testPool.query("DELETE FROM orders WHERE user_id = $1", [fixture.userId]);
  await testPool.query("DELETE FROM inventory WHERE product_id = $1", [fixture.productId]);
  await testPool.query("DELETE FROM products WHERE id = $1", [fixture.productId]);
  await testPool.query("DELETE FROM users WHERE id = $1", [fixture.userId]);
  await testPool.query("DELETE FROM categories WHERE id = $1", [fixture.categoryId]);
}

test(
  "committed order flows through PostgreSQL outbox, BullMQ, worker, and creates one receipt",
  {
    timeout: 60000,
    skip: process.env.TEST_REDIS_URL
      ? false
      : "Set TEST_REDIS_URL to run the real Redis/BullMQ end-to-end test.",
  },
  async () => {
    const dispatcherRedis = createRedisManager({
      url: process.env.TEST_REDIS_URL,
      logger: { info() {}, warn() {}, error() {} },
    });
    const workerRedis = createRedisManager({
      url: process.env.TEST_REDIS_URL,
      logger: { info() {}, warn() {}, error() {} },
    });
    const workerPool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 3,
    });

    let fixture;
    let dispatcher;
    let workerResources;
    let inspectionQueue;

    try {
      fixture = await createFixture();

      workerResources = await startOrderWorker({
        redisManager: workerRedis,
        db: workerPool,
        createReceiptProcessor: () => createOrderReceiptProcessor({ db: workerPool }),
        logger: { info() {}, warn() {}, error() {} },
        registerSignals: false,
      });
      await workerResources.worker.waitUntilReady();

      dispatcher = createOrderOutboxDispatcher({
        db: testPool,
        redisManager: dispatcherRedis,
        createQueue: () => createOrderQueue({ redisManager: dispatcherRedis }),
      });

      const order = await createOrder(
        fixture.userId,
        [{ productId: fixture.productId, quantity: 2 }],
        testPool,
        async () => {},
      );

      // Dispatch batches until this order's outbox row is confirmed published.
      const deadline = Date.now() + 15000;
      let outboxStatus = "pending";
      while (Date.now() < deadline && outboxStatus !== "dispatched") {
        await dispatcher.dispatchBatch();
        const outbox = await testPool.query(
          "SELECT status FROM order_outbox WHERE order_id = $1",
          [order.id],
        );
        outboxStatus = outbox.rows[0]?.status;
        if (outboxStatus !== "dispatched") await delay(100);
      }
      assert.equal(outboxStatus, "dispatched");

      inspectionQueue = await createOrderQueue({ redisManager: dispatcherRedis });
      await inspectionQueue.queue.waitUntilReady();
      await waitForJobState(inspectionQueue.queue, `order-${order.id}`, "completed");

      const receipt = await waitForReceipt(order.id);
      assert.ok(receipt.id);

      // Add a distinct job for the same order to exercise the processor twice.
      const replayJob = await inspectionQueue.queue.add(
        ORDER_RECEIPT_JOB,
        { orderId: String(order.id) },
        { jobId: `receipt-replay-${randomUUID()}`, attempts: 1 },
      );
      await waitForJobState(inspectionQueue.queue, replayJob.id, "completed");

      const receipts = await testPool.query(
        "SELECT id FROM receipts WHERE order_id = $1",
        [order.id],
      );
      assert.equal(receipts.rowCount, 1, "replaying a job must not create a second receipt");
    } finally {
      if (inspectionQueue) await inspectionQueue.close().catch(() => {});
      if (dispatcher) await dispatcher.close().catch(() => {});
      if (workerResources) {
        await workerResources.shutdown("integration test").catch(() => {});
      } else {
        await workerPool.end().catch(() => {});
      }
      await dispatcherRedis.closeRedis().catch(() => {});
      await workerRedis.closeRedis().catch(() => {});
      await cleanupFixture(fixture);
    }
  },
);


test(
  "retries temporary PostgreSQL receipt failures and allows recovery of an exhausted job",
  {
    timeout: 30000,
    skip: process.env.TEST_REDIS_URL && process.env.TEST_DATABASE_URL
      ? false
      : "Requires TEST_DATABASE_URL and TEST_REDIS_URL.",
  },
  async () => {
    const dispatcherRedis = createRedisManager({
      url: process.env.TEST_REDIS_URL,
      logger: { info() {}, warn() {}, error() {} },
    });
    const workerRedis = createRedisManager({
      url: process.env.TEST_REDIS_URL,
      logger: { info() {}, warn() {}, error() {} },
    });
    const workerPool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 3,
    });

    let fixture;
    let workerResources;
    let queueResources;
    let remainingReceiptWriteFailures = 3;

    const flakyDatabase = {
      async query(sql, params) {
        if (sql.includes("INSERT INTO receipts") && remainingReceiptWriteFailures > 0) {
          remainingReceiptWriteFailures -= 1;
          throw new Error("Simulated PostgreSQL outage during receipt write");
        }
        return workerPool.query(sql, params);
      },
    };

    try {
      fixture = await createFixture();

      const order = await createOrder(
        fixture.userId,
        [{ productId: fixture.productId, quantity: 1 }],
        testPool,
        async () => {},
      );

      workerResources = await startOrderWorker({
        redisManager: workerRedis,
        db: workerPool,
        createReceiptProcessor: () => createOrderReceiptProcessor({ db: flakyDatabase }),
        logger: { info() {}, warn() {}, error() {} },
        registerSignals: false,
      });
      await workerResources.worker.waitUntilReady();

      const dispatcherRedisConnected = await dispatcherRedis.connectRedis();
      assert.equal(dispatcherRedisConnected, true);

      queueResources = await createOrderQueue({ redisManager: dispatcherRedis });
      await queueResources.queue.waitUntilReady();

      const job = await queueResources.enqueueOrderReceipt(order.id);

      // Three receipt-write failures exhaust the configured BullMQ attempts.
      const failedJob = await waitForJobState(
        queueResources.queue,
        job.id,
        "failed",
        12000,
      );
      assert.equal(remainingReceiptWriteFailures, 0);
      assert.equal(failedJob.attemptsMade, 3);

      const receiptBeforeRecovery = await testPool.query(
        "SELECT id FROM receipts WHERE order_id = $1",
        [order.id],
      );
      assert.equal(receiptBeforeRecovery.rowCount, 0);

      // PostgreSQL has recovered. An operator can retry the retained failed
      // job with resetAttemptsMade=true to give it a fresh three attempts.
      await failedJob.retry("failed", { resetAttemptsMade: true });
      await waitForJobState(queueResources.queue, job.id, "completed", 10000);

      const receipts = await testPool.query(
        "SELECT id FROM receipts WHERE order_id = $1",
        [order.id],
      );
      assert.equal(receipts.rowCount, 1);

      const replay = await queueResources.queue.add(
        ORDER_RECEIPT_JOB,
        { orderId: String(order.id) },
        { jobId: `pg-recovery-replay-${order.id}`, attempts: 1 },
      );
      await waitForJobState(queueResources.queue, replay.id, "completed");
      const receiptCount = await testPool.query(
        "SELECT id FROM receipts WHERE order_id = $1",
        [order.id],
      );
      assert.equal(receiptCount.rowCount, 1);
    } finally {
      if (queueResources) await queueResources.close().catch(() => {});
      if (workerResources) {
        await workerResources.shutdown("PostgreSQL retry integration test").catch(() => {});
      } else {
        await workerPool.end().catch(() => {});
      }
      await dispatcherRedis.closeRedis().catch(() => {});
      await workerRedis.closeRedis().catch(() => {});
      await cleanupFixture(fixture);
    }
  },
);


test(
  "retries a pending outbox event after a real Redis connection outage and recovery",
  {
    timeout: 30000,
    skip: process.env.TEST_REDIS_URL && process.env.TEST_DATABASE_URL
      ? false
      : "Requires TEST_DATABASE_URL and TEST_REDIS_URL.",
  },
  async () => {
    const dispatcherRedis = createRedisManager({
      url: process.env.TEST_REDIS_URL,
      logger: { info() {}, warn() {}, error() {} },
    });
    const workerRedis = createRedisManager({
      url: process.env.TEST_REDIS_URL,
      logger: { info() {}, warn() {}, error() {} },
    });
    const workerPool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 3,
    });

    let fixture;
    let dispatcher;
    let workerResources;
    let connectCalls = 0;

    const recoverableRedis = {
      get client() {
        return dispatcherRedis.client;
      },
      isRedisReady() {
        return dispatcherRedis.isRedisReady();
      },
      async connectRedis() {
        connectCalls += 1;

        // First dispatcher attempt represents Redis being unavailable.
        if (connectCalls === 1) return false;

        return dispatcherRedis.connectRedis();
      },
      closeRedis() {
        return dispatcherRedis.closeRedis();
      },
    };

    try {
      fixture = await createFixture();

      const order = await createOrder(
        fixture.userId,
        [{ productId: fixture.productId, quantity: 1 }],
        testPool,
        async () => {},
      );

      workerResources = await startOrderWorker({
        redisManager: workerRedis,
        db: workerPool,
        createReceiptProcessor: () => createOrderReceiptProcessor({ db: workerPool }),
        logger: { info() {}, warn() {}, error() {} },
        registerSignals: false,
      });
      await workerResources.worker.waitUntilReady();

      dispatcher = createOrderOutboxDispatcher({
        db: testPool,
        redisManager: recoverableRedis,
        createQueue: () => createOrderQueue({ redisManager: recoverableRedis }),
      });

      const firstAttempt = await dispatcher.dispatchBatch();
      assert.deepEqual(firstAttempt, { claimed: 1, dispatched: 0, failed: 1 });

      const pending = await testPool.query(
        "SELECT status, attempts FROM order_outbox WHERE order_id = $1",
        [order.id],
      );
      assert.equal(pending.rows[0].status, "pending");
      assert.equal(Number(pending.rows[0].attempts), 1);

      // Skip the normal retry delay to test recovery without waiting.
      await testPool.query(
        "UPDATE order_outbox SET available_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE order_id = $1",
        [order.id],
      );

      const recoveredAttempt = await dispatcher.dispatchBatch();
      assert.deepEqual(recoveredAttempt, { claimed: 1, dispatched: 1, failed: 0 });
      assert.equal(connectCalls, 2);

      const queueResources = await createOrderQueue({ redisManager: dispatcherRedis });
      try {
        await waitForJobState(
          queueResources.queue,
          `order-${order.id}`,
          "completed",
        );
      } finally {
        await queueResources.close();
      }

      const receipts = await testPool.query(
        "SELECT id FROM receipts WHERE order_id = $1",
        [order.id],
      );
      assert.equal(receipts.rowCount, 1);
    } finally {
      if (dispatcher) await dispatcher.close().catch(() => {});
      if (workerResources) {
        await workerResources.shutdown("Redis recovery integration test").catch(() => {});
      } else {
        await workerPool.end().catch(() => {});
      }
      await dispatcherRedis.closeRedis().catch(() => {});
      await workerRedis.closeRedis().catch(() => {});
      await cleanupFixture(fixture);
    }
  },
);


function createScopedOutboxDb(orderIds, observedQueries = []) {
  return {
    async query(sql, params = []) {
      observedQueries.push({ sql, params });

      if (sql.includes("WITH candidates AS")) {
        const scopedSql = sql.replace(
          "FROM order_outbox\n         WHERE",
          "FROM order_outbox\n         WHERE order_id = ANY($4::bigint[]) AND (",
        ).replace(
          "           OR\n           (status = 'processing' AND locked_until < CURRENT_TIMESTAMP)\n         ORDER BY id",
          "           OR\n           (status = 'processing' AND locked_until < CURRENT_TIMESTAMP)\n           )\n         ORDER BY id",
        );
        return testPool.query(scopedSql, [...params, orderIds]);
      }

      return testPool.query(sql, params);
    },
  };
}

async function createOrdersForFixture(fixture, count) {
  const orders = [];

  for (let index = 0; index < count; index += 1) {
    const order = await createOrder(
      fixture.userId,
      [{ productId: fixture.productId, quantity: 1 }],
      testPool,
      async () => {},
    );
    orders.push(order);
  }

  return orders;
}

async function waitForCondition(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }

  throw new Error("Condition was not reached before timeout");
}

test(
  "a dispatcher that loses one row's claim stops that stale row and cannot mark or release the new owner's row",
  {
    timeout: 20000,
  },
  async () => {
    let fixture;
    let dispatcherA;
    let dispatcherB;
    let dispatchAPromise;
    let releaseA;
    let signalAStarted;
    const aStarted = new Promise((resolve) => {
      signalAStarted = resolve;
    });
    const holdA = new Promise((resolve) => {
      releaseA = resolve;
    });
    const enqueuedA = [];
    const enqueuedB = [];
    const logsA = [];
    const queriesA = [];

    try {
      fixture = await createFixture();
      const orders = await createOrdersForFixture(fixture, 2);
      const orderIds = orders.map((order) => String(order.id));
      const outboxRows = await testPool.query(
        `SELECT id, order_id
         FROM order_outbox
         WHERE order_id = ANY($1::bigint[])
         ORDER BY id`,
        [orderIds],
      );
      assert.equal(outboxRows.rowCount, 2);
      const firstOutboxId = String(outboxRows.rows[0].id);
      const secondOutboxId = String(outboxRows.rows[1].id);

      dispatcherA = createOrderOutboxDispatcher({
        db: createScopedOutboxDb(orderIds, queriesA),
        redisManager: {
          isRedisReady() { return true; },
          async connectRedis() { return true; },
        },
        batchSize: 2,
        leaseSeconds: 60,
        leaseRenewalIntervalMs: 1000,
        enqueueTimeoutMs: 5000,
        logger: {
          info() {},
          warn(message) { logsA.push(message); },
          error(message) { logsA.push(message); },
        },
        createQueue: async () => ({
          async enqueueOrderReceipt(orderId) {
            enqueuedA.push(String(orderId));
            if (enqueuedA.length === 1) {
              signalAStarted();
              await holdA;
            }
          },
          async close() {},
        }),
      });

      dispatchAPromise = dispatcherA.dispatchBatch();
      await aStarted;

      // Expire only the second row while A is still processing the first.
      await testPool.query(
        `UPDATE order_outbox
         SET locked_until = CURRENT_TIMESTAMP - INTERVAL '1 second'
         WHERE id = $1 AND status = 'processing'`,
        [secondOutboxId],
      );

      dispatcherB = createOrderOutboxDispatcher({
        db: createScopedOutboxDb(orderIds),
        redisManager: {
          isRedisReady() { return true; },
          async connectRedis() { return true; },
        },
        batchSize: 1,
        leaseSeconds: 60,
        enqueueTimeoutMs: 5000,
        logger: { info() {}, warn() {}, error() {} },
        createQueue: async () => ({
          async enqueueOrderReceipt(orderId) {
            enqueuedB.push(String(orderId));
          },
          async close() {},
        }),
      });

      const resultB = await dispatcherB.dispatchBatch();
      assert.deepEqual(resultB, { claimed: 1, dispatched: 1, failed: 0 });
      assert.deepEqual(enqueuedB, [orderIds[1]]);

      await waitForCondition(
        () => logsA.some((message) => message.includes("Lost claim for event " + secondOutboxId)),
      );

      releaseA();
      const resultA = await dispatchAPromise;
      assert.deepEqual(resultA, { claimed: 2, dispatched: 1, failed: 1 });
      assert.deepEqual(enqueuedA, [orderIds[0]], "A must not enqueue the reclaimed row");

      const staleMarks = queriesA.filter(
        (query) => query.sql.includes("SET status = 'dispatched'") &&
          String(query.params[0]) === secondOutboxId,
      );
      const staleReleases = queriesA.filter(
        (query) => query.sql.includes("SET status = 'pending'") &&
          String(query.params[0]) === secondOutboxId,
      );
      assert.equal(staleMarks.length, 0, "A must not mark B's row dispatched");
      assert.equal(staleReleases.length, 0, "A must not release B's row");

      const finalRows = await testPool.query(
        `SELECT id, status, attempts, claim_token
         FROM order_outbox
         WHERE id = ANY($1::bigint[])
         ORDER BY id`,
        [[firstOutboxId, secondOutboxId]],
      );
      assert.equal(finalRows.rows[0].status, "dispatched");
      assert.equal(Number(finalRows.rows[0].attempts), 1);
      assert.equal(finalRows.rows[1].status, "dispatched");
      assert.equal(Number(finalRows.rows[1].attempts), 2);
      assert.equal(finalRows.rows[1].claim_token, null);
    } finally {
      releaseA?.();
      if (dispatchAPromise) await Promise.race([dispatchAPromise.catch(() => {}), delay(5000)]);
      if (dispatcherA) await dispatcherA.close().catch(() => {});
      if (dispatcherB) await dispatcherB.close().catch(() => {});
      await cleanupFixture(fixture);
    }
  },
);
