require("dotenv").config();

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");

const { createOrder } = require("../src/services/order.service");

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL is required");
}

if (process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) {
  throw new Error("Test database must be different from DATABASE_URL");
}

const testPool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  max: 5,
});

after(async () => {
  await testPool.end();
});

async function createFixture(initialQuantity = 5) {
  const unique = randomUUID();

  const category = await testPool.query(
    `INSERT INTO categories (name)
     VALUES ($1)
     RETURNING id`,
    [`outbox-test-${unique}`],
  );

  const user = await testPool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      "Outbox Integration Test",
      `outbox-${unique}@example.test`,
      "test-password-hash",
      "customer",
    ],
  );

  const product = await testPool.query(
    `INSERT INTO products (category_id, name, sku, price)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      category.rows[0].id,
      "Outbox Test Product",
      `OUTBOX-${unique}`,
      "15.00",
    ],
  );

  const productId = product.rows[0].id;

  await testPool.query(
    `INSERT INTO inventory (product_id, quantity)
     VALUES ($1, $2)`,
    [productId, initialQuantity],
  );

  return {
    categoryId: category.rows[0].id,
    userId: user.rows[0].id,
    productId,
  };
}

async function cleanupFixture(fixture) {
  if (!fixture) return;

  await testPool.query(
    `DELETE FROM inventory_transactions
     WHERE product_id = $1`,
    [fixture.productId],
  );

  await testPool.query(
    `DELETE FROM order_outbox
     WHERE order_id IN (
       SELECT id FROM orders WHERE user_id = $1
     )`,
    [fixture.userId],
  );

  await testPool.query(
    `DELETE FROM orders
     WHERE user_id = $1`,
    [fixture.userId],
  );

  await testPool.query(
    `DELETE FROM inventory
     WHERE product_id = $1`,
    [fixture.productId],
  );

  await testPool.query(
    `DELETE FROM products
     WHERE id = $1`,
    [fixture.productId],
  );

  await testPool.query(
    `DELETE FROM users
     WHERE id = $1`,
    [fixture.userId],
  );

  await testPool.query(
    `DELETE FROM categories
     WHERE id = $1`,
    [fixture.categoryId],
  );
}

test("successful checkout creates one pending receipt outbox event", {
  timeout: 60000,
}, async () => {
  let fixture;

  try {
    fixture = await createFixture(5);

    const order = await createOrder(
      fixture.userId,
      [{ productId: fixture.productId, quantity: 2 }],
      testPool,
    );

    const result = await testPool.query(
      `SELECT event_type, order_id, payload, status
       FROM order_outbox
       WHERE order_id = $1`,
      [order.id],
    );

    assert.equal(result.rowCount, 1);

    const event = result.rows[0];

    assert.equal(event.event_type, "order.receipt.requested");
    assert.equal(String(event.order_id), String(order.id));
    assert.equal(String(event.payload.orderId), String(order.id));
    assert.equal(event.status, "pending");
  } finally {
    await cleanupFixture(fixture);
  }
});

test("order and outbox event both roll back when COMMIT fails", {
  timeout: 60000,
}, async () => {
  let fixture;

  try {
    fixture = await createFixture(5);

    let attemptedOrderId;
    let outboxInsertAttempted = false;

    const failingPool = {
      async connect() {
        const client = await testPool.connect();

        const originalQuery = client.query.bind(client);
        const originalRelease = client.release.bind(client);

        client.query = async (...args) => {
          const sql = typeof args[0] === "string" ? args[0] : "";

          if (sql.includes("INSERT INTO order_outbox")) {
            outboxInsertAttempted = true;
          }

          if (sql.includes("INSERT INTO orders")) {
            const result = await originalQuery(...args);
            attemptedOrderId = result.rows[0].id;
            return result;
          }

          if (sql.trim().toUpperCase() === "COMMIT") {
            throw new Error("Simulated commit failure");
          }

          return originalQuery(...args);
        };

        // Restore the original methods before returning the client.
        client.release = (...args) => {
          client.query = originalQuery;
          return originalRelease(...args);
        };

        return client;
      },
    };

    await assert.rejects(
      createOrder(
        fixture.userId,
        [{ productId: fixture.productId, quantity: 2 }],
        failingPool,
      ),
      /Simulated commit failure/,
    );

    assert.ok(attemptedOrderId);
    assert.equal(outboxInsertAttempted, true);

    const orders = await testPool.query(
      `SELECT id FROM orders WHERE id = $1`,
      [attemptedOrderId],
    );

    assert.equal(orders.rowCount, 0);

    const events = await testPool.query(
      `SELECT id FROM order_outbox WHERE order_id = $1`,
      [attemptedOrderId],
    );

    assert.equal(events.rowCount, 0);

    const inventory = await testPool.query(
      `SELECT quantity
       FROM inventory
       WHERE product_id = $1`,
      [fixture.productId],
    );

    assert.equal(inventory.rows[0].quantity, 5);

    const transactions = await testPool.query(
      `SELECT id
       FROM inventory_transactions
       WHERE product_id = $1`,
      [fixture.productId],
    );

    assert.equal(transactions.rowCount, 0);
  } finally {
    await cleanupFixture(fixture);
  }
});
