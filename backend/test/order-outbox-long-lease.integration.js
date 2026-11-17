require("dotenv").config();

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");

const { createOrder } = require("../src/services/order.service");
const { createOrderOutboxDispatcher } = require("../src/services/order-outbox-dispatcher.service");

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

async function createFixture() {
  const suffix = randomUUID();
  const category = await testPool.query(
    "INSERT INTO categories (name) VALUES ($1) RETURNING id",
    ["outbox-long-lease-" + suffix],
  );
  const user = await testPool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    ["Outbox Long Lease Test", "outbox-long-" + suffix + "@example.test", "test-password-hash", "customer"],
  );
  const product = await testPool.query(
    `INSERT INTO products (category_id, name, sku, price)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [category.rows[0].id, "Outbox Long Lease Product", "OUTBOX-LONG-" + suffix, "15.00"],
  );
  await testPool.query(
    "INSERT INTO inventory (product_id, quantity) VALUES ($1, $2)",
    [product.rows[0].id, 30],
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
  await testPool.query(
    "DELETE FROM inventory_transactions WHERE product_id = $1",
    [fixture.productId],
  );
  await testPool.query("DELETE FROM orders WHERE user_id = $1", [fixture.userId]);
  await testPool.query("DELETE FROM inventory WHERE product_id = $1", [fixture.productId]);
  await testPool.query("DELETE FROM products WHERE id = $1", [fixture.productId]);
  await testPool.query("DELETE FROM users WHERE id = $1", [fixture.userId]);
  await testPool.query("DELETE FROM categories WHERE id = $1", [fixture.categoryId]);
}

function createScopedOutboxDb(orderIds) {
  return {
    async query(sql, params = []) {
      if (sql.includes("WITH candidates AS")) {
        // Scope both sides of the pending/expired-lease OR expression to this
        // test fixture without changing the dispatcher's locking behaviour.
        const scopedSql = sql.replace(
          "FROM order_outbox\n         WHERE",
          "FROM order_outbox\n         WHERE order_id = ANY($4::bigint[]) AND (",
        ).replace(
          "           OR\n           (status = 'processing' AND locked_until < CURRENT_TIMESTAMP)\n         ORDER BY id",
          "           OR\n           (status = 'processing' AND locked_until < CURRENT_TIMESTAMP)\n           )\n         ORDER BY id",
        );

        // Never fall back to an unscoped claim if the dispatcher SQL changes.
        if (
          !scopedSql.includes("order_id = ANY($4::bigint[]) AND (") ||
          !scopedSql.includes("           )\n         ORDER BY id")
        ) {
          throw new Error("Could not scope the outbox claim query to the fixture orders");
        }

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

test(
  "renews all still-processing claims while a real 25-row PostgreSQL batch runs beyond the original 60-second lease",
  {
    timeout: 240000,
  },
  async () => {
    let fixture;
    let dispatcherA;
    let dispatcherB;
    let dispatchPromise;
    let signalFirstEnqueue;
    const firstEnqueueStarted = new Promise((resolve) => {
      signalFirstEnqueue = resolve;
    });
    const enqueuedByA = [];
    let queueBCreated = false;

    try {
      fixture = await createFixture();
      const orders = await createOrdersForFixture(fixture, 25);
      const orderIds = orders.map((order) => String(order.id));

      const outboxRows = await testPool.query(
        `SELECT id, order_id, claim_token, status
         FROM order_outbox
         WHERE order_id = ANY($1::bigint[])
         ORDER BY id`,
        [orderIds],
      );
      assert.equal(outboxRows.rowCount, 25);

      dispatcherA = createOrderOutboxDispatcher({
        db: createScopedOutboxDb(orderIds),
        redisManager: {
          isRedisReady() { return true; },
          async connectRedis() { return true; },
        },
        batchSize: 25,
        leaseSeconds: 60,
        leaseRenewalIntervalMs: 10000,
        enqueueTimeoutMs: 30000,
        logger: { info() {}, warn() {}, error() {} },
        createQueue: async () => ({
          async enqueueOrderReceipt(orderId) {
            enqueuedByA.push(String(orderId));
            if (enqueuedByA.length === 1) signalFirstEnqueue();

            // Three 21-second enqueue calls keep the batch active past its
            // original 60-second lease. The remaining 22 rows are unstarted.
            if (enqueuedByA.length <= 3) await delay(21000);
          },
          async close() {},
        }),
      });

      dispatchPromise = dispatcherA.dispatchBatch();
      await firstEnqueueStarted;
      await delay(61000);

      assert.equal(
        enqueuedByA.length,
        3,
        "the remaining 22 rows should still be unstarted after 61 seconds",
      );

      const beforeB = await testPool.query(
        `SELECT id, order_id, status, claim_token,
                locked_until > CURRENT_TIMESTAMP AS lease_valid
         FROM order_outbox
         WHERE order_id = ANY($1::bigint[])
         ORDER BY id`,
        [orderIds],
      );
      assert.equal(beforeB.rows.length, 25);
      assert.ok(
        beforeB.rows.slice(2).every(
          (row) => row.status === "processing" && row.lease_valid,
        ),
        "the active event and all 22 unstarted rows must retain valid leases",
      );

      dispatcherB = createOrderOutboxDispatcher({
        db: createScopedOutboxDb(orderIds),
        redisManager: {
          isRedisReady() { return true; },
          async connectRedis() { return true; },
        },
        batchSize: 25,
        leaseSeconds: 60,
        enqueueTimeoutMs: 30000,
        logger: { info() {}, warn() {}, error() {} },
        createQueue: async () => {
          queueBCreated = true;
          return {
            async enqueueOrderReceipt() {},
            async close() {},
          };
        },
      });

      const resultB = await dispatcherB.dispatchBatch();
      assert.deepEqual(resultB, { claimed: 0, dispatched: 0, failed: 0 });
      assert.equal(
        queueBCreated,
        false,
        "dispatcher B must not create a queue or reclaim any row still leased by A",
      );

      const resultA = await dispatchPromise;
      assert.deepEqual(resultA, { claimed: 25, dispatched: 25, failed: 0 });
      assert.equal(enqueuedByA.length, 25);
      assert.equal(new Set(enqueuedByA).size, 25);
      assert.deepEqual(enqueuedByA, orderIds);

      const finalRows = await testPool.query(
        `SELECT status, attempts
         FROM order_outbox
         WHERE order_id = ANY($1::bigint[])
         ORDER BY id`,
        [orderIds],
      );
      assert.equal(finalRows.rowCount, 25);
      for (const row of finalRows.rows) {
        assert.equal(row.status, "dispatched");
        assert.equal(Number(row.attempts), 1);
      }
    } finally {
      if (dispatchPromise) {
        await Promise.race([dispatchPromise.catch(() => {}), delay(5000)]);
      }
      if (dispatcherA) await dispatcherA.close().catch(() => {});
      if (dispatcherB) await dispatcherB.close().catch(() => {});
      await cleanupFixture(fixture);
    }
  },
);
