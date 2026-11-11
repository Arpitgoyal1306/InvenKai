require("dotenv").config();

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");

const {
  createOrder,
  getUserOrders,
  getOrderById,
} = require("../src/services/order.service");

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL is required for order integration tests");
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

  const categoryResult = await testPool.query(
    `INSERT INTO categories (name)
     VALUES ($1)
     RETURNING id`,
    [`order-test-${unique}`],
  );

  const userResult = await testPool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      "Order Integration Test",
      `order-test-${unique}@example.test`,
      "test-password-hash",
      "customer",
    ],
  );

  const productResult = await testPool.query(
    `INSERT INTO products (category_id, name, sku, price)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      categoryResult.rows[0].id,
      "Integration Test Product",
      `ORDER-${unique}`,
      "15.00",
    ],
  );

  const productId = productResult.rows[0].id;

  await testPool.query(
    `INSERT INTO inventory (product_id, quantity)
     VALUES ($1, $2)`,
    [productId, initialQuantity],
  );

  return {
    categoryId: categoryResult.rows[0].id,
    userId: userResult.rows[0].id,
    productId,
  };
}


async function cleanupFixture(fixture, additionalUserIds = []) {
  const userIds = [fixture.userId, ...additionalUserIds];

  await testPool.query(
    `DELETE FROM inventory_transactions WHERE product_id = $1`,
    [fixture.productId],
  );

  await testPool.query(`DELETE FROM orders WHERE user_id = ANY($1::bigint[])`, [
    userIds,
  ]);

  await testPool.query(`DELETE FROM inventory WHERE product_id = $1`, [
    fixture.productId,
  ]);

  await testPool.query(`DELETE FROM products WHERE id = $1`, [
    fixture.productId,
  ]);

  await testPool.query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [
    userIds,
  ]);

  await testPool.query(`DELETE FROM categories WHERE id = $1`, [
    fixture.categoryId,
  ]);
}

async function createSecondCustomer() {
  const result = await testPool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      "Concurrent Test Customer",
      `concurrent-${randomUUID()}@example.com`,
      "test-password-hash",
      "customer",
    ],
  );

  return result.rows[0].id;
}

test("createOrder creates an order and deducts inventory", async () => {
  let fixture;

  try {
    fixture = await createFixture(5);

    const order = await createOrder(
      fixture.userId,
      [
        {
          productId: fixture.productId,
          quantity: 2,
        },
      ],
      testPool,
    );

    // Verify the order.
    assert.ok(order.id);
    assert.equal(String(order.user_id), String(fixture.userId));
    assert.equal(order.status, "placed");
    assert.equal(String(order.total_amount), "30.00");

    // Verify the order item.
    assert.equal(order.items.length, 1);
    assert.equal(String(order.items[0].product_id), String(fixture.productId));
    assert.equal(order.items[0].quantity, 2);
    assert.equal(String(order.items[0].unit_price), "15.00");
    assert.equal(String(order.items[0].line_total), "30.00");

    // Verify inventory deduction.
    const inventory = await testPool.query(
      `SELECT quantity
       FROM inventory
       WHERE product_id = $1`,
      [fixture.productId],
    );

    assert.equal(inventory.rows[0].quantity, 3);

    // Verify inventory transaction history.
    const transactions = await testPool.query(
      `SELECT transaction_type, quantity,
              quantity_before, quantity_after, order_id
       FROM inventory_transactions
       WHERE product_id = $1`,
      [fixture.productId],
    );

    assert.equal(transactions.rowCount, 1);
    assert.equal(transactions.rows[0].transaction_type, "decrease");
    assert.equal(transactions.rows[0].quantity, 2);
    assert.equal(transactions.rows[0].quantity_before, 5);
    assert.equal(transactions.rows[0].quantity_after, 3);
    assert.equal(String(transactions.rows[0].order_id), String(order.id));
  } finally {
    await cleanupFixture(fixture);
  }
});


test("createOrder rolls back when inventory is insufficient", async () => {
  let fixture;

  try {
    fixture = await createFixture(1);

    await assert.rejects(
      createOrder(
        fixture.userId,
        [
          {
            productId: fixture.productId,
            quantity: 2,
          },
        ],
        testPool,
      ),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.match(error.message, /Insufficient stock/);
        return true;
      },
    );

    // Inventory must remain unchanged.
    const inventory = await testPool.query(
      `SELECT quantity
       FROM inventory
       WHERE product_id = $1`,
      [fixture.productId],
    );

    assert.equal(inventory.rows[0].quantity, 1);

    // No order should have been created.
    const orders = await testPool.query(
      `SELECT id
       FROM orders
       WHERE user_id = $1`,
      [fixture.userId],
    );

    assert.equal(orders.rowCount, 0);

    // No inventory transaction should have been recorded.
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


test("createOrder rejects missing products without creating an order", async () => {
  let fixture;

  try {
    fixture = await createFixture(5);

    await assert.rejects(
      createOrder(
        fixture.userId,
        [{ productId: "999999999999999999", quantity: 1 }],
        testPool,
      ),
      (error) => {
        assert.equal(error.statusCode, 404);
        return true;
      },
    );

    const orders = await testPool.query(
      "SELECT id FROM orders WHERE user_id = $1",
      [fixture.userId],
    );

    assert.equal(orders.rowCount, 0);

    const inventory = await testPool.query(
      "SELECT quantity FROM inventory WHERE product_id = $1",
      [fixture.productId],
    );

    assert.equal(inventory.rows[0].quantity, 5);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("createOrder rolls back when an inventory transaction insert fails", async () => {
  let fixture;

  try {
    fixture = await createFixture(5);

    // A separate client injects a failure after inventory deduction.

    const failingPool = {
    async connect() {
        const client = await testPool.connect();

        const originalQuery = client.query.bind(client);
        const originalRelease = client.release.bind(client);

        client.query = async (...args) => {
        const sql = typeof args[0] === "string" ? args[0] : "";

        if (sql.includes("INSERT INTO inventory_transactions")) {
            throw new Error("Simulated inventory transaction failure");
        }

        return originalQuery(...args);
        };

        // Restore the original query method before returning
        // this connection to the PostgreSQL pool.
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
      /Simulated inventory transaction failure/,
    );

    const inventory = await testPool.query(
      "SELECT quantity FROM inventory WHERE product_id = $1",
      [fixture.productId],
    );

    assert.equal(inventory.rows[0].quantity, 5);

    const orders = await testPool.query(
      "SELECT id FROM orders WHERE user_id = $1",
      [fixture.userId],
    );

    assert.equal(orders.rowCount, 0);

    const transactions = await testPool.query(
      "SELECT id FROM inventory_transactions WHERE product_id = $1",
      [fixture.productId],
    );

    assert.equal(transactions.rowCount, 0);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("concurrent checkouts cannot oversell the last unit", async () => {
  const fixture = await createFixture(1);
  let secondUserId;

  try {
    secondUserId = await createSecondCustomer();

    const results = await Promise.allSettled([
      createOrder(
        fixture.userId,
        [{ productId: fixture.productId, quantity: 1 }],
        testPool,
      ),
      createOrder(
        secondUserId,
        [{ productId: fixture.productId, quantity: 1 }],
        testPool,
      ),
    ]);

    const successfulOrders = results.filter(
      (result) => result.status === "fulfilled",
    );

    const failedOrders = results.filter(
      (result) => result.status === "rejected",
    );



    assert.equal(successfulOrders.length, 1);
    assert.equal(failedOrders.length, 1);
    assert.equal(
      failedOrders[0].reason.statusCode,
      409,
      `Unexpected checkout error: ${JSON.stringify({
        message: failedOrders[0].reason.message,
        code: failedOrders[0].reason.code,
        statusCode: failedOrders[0].reason.statusCode,
        detail: failedOrders[0].reason.detail,
      })}`,
    );

    const inventoryResult = await testPool.query(
      `SELECT quantity
       FROM inventory
       WHERE product_id = $1`,
      [fixture.productId],
    );

    assert.equal(inventoryResult.rows[0].quantity, 0);

    const orderResult = await testPool.query(
      `SELECT COUNT(*)::int AS count
       FROM orders
       WHERE user_id = ANY($1::bigint[])`,
      [[fixture.userId, secondUserId]],
    );

    assert.equal(orderResult.rows[0].count, 1);

    const transactionResult = await testPool.query(
      `SELECT transaction_type, quantity, quantity_before, quantity_after
       FROM inventory_transactions
       WHERE product_id = $1`,
      [fixture.productId],
    );

    assert.equal(transactionResult.rowCount, 1);
    assert.equal(transactionResult.rows[0].transaction_type, "decrease");
    assert.equal(transactionResult.rows[0].quantity, 1);
    assert.equal(transactionResult.rows[0].quantity_before, 1);
    assert.equal(transactionResult.rows[0].quantity_after, 0);
  } finally {
    await cleanupFixture(fixture, secondUserId ? [secondUserId] : []);
  }
});


test("getUserOrders returns only the requested user's orders", async () => {
  let fixture;
  let secondUserId;

  try {
    fixture = await createFixture(20);
    secondUserId = await createSecondCustomer();

    // Create three orders for the first customer.
    const firstOrder = await createOrder(
      fixture.userId,
      [{ productId: fixture.productId, quantity: 1 }],
      testPool,
    );

    const secondOrder = await createOrder(
      fixture.userId,
      [{ productId: fixture.productId, quantity: 2 }],
      testPool,
    );

    const thirdOrder = await createOrder(
      fixture.userId,
      [{ productId: fixture.productId, quantity: 1 }],
      testPool,
    );

    // Create an order for another customer.
    await createOrder(
      secondUserId,
      [{ productId: fixture.productId, quantity: 1 }],
      testPool,
    );

    const result = await getUserOrders(fixture.userId, {}, testPool);

    assert.equal(result.orders.length, 3);
    assert.equal(result.pagination.total, 3);

    // Every returned order must belong to the requested user.
    for (const order of result.orders) {
      assert.equal(String(order.user_id), String(fixture.userId));
    }

    // Newest orders should appear first.
    assert.deepEqual(
      result.orders.map((order) => String(order.id)),
      [String(thirdOrder.id), String(secondOrder.id), String(firstOrder.id)],
    );

    // Every order contains exactly one item.
    for (const order of result.orders) {
      assert.equal(order.item_count, 1);
    }
  } finally {
    await cleanupFixture(fixture, secondUserId ? [secondUserId] : []);
  }
});

test("getUserOrders returns an empty array when the user has no orders", async () => {
  let fixture;

  try {
    fixture = await createFixture(5);

    const result = await getUserOrders(fixture.userId, {}, testPool);

    assert.deepEqual(result.orders, []);

    assert.deepEqual(result.pagination, {
      page: 1,
      limit: 10,
      total: 0,
      totalPages: 0,
    });
  } finally {
    await cleanupFixture(fixture);
  }
});


test("getUserOrders correctly calculates item counts", async () => {
  let fixture;
  let secondProductId;
  let secondCategoryId;

  try {
    fixture = await createFixture(20);

    // Create a second category.
    const categoryResult = await testPool.query(
      `INSERT INTO categories (name)
       VALUES ($1)
       RETURNING id`,
      [`second-order-category-${randomUUID()}`],
    );

    secondCategoryId = categoryResult.rows[0].id;

    // Create a second product.
    const secondProductResult = await testPool.query(
      `INSERT INTO products (category_id, name, sku, price)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        secondCategoryId,
        "Second Integration Product",
        `ORDER-${randomUUID()}`,
        "25.00",
      ],
    );

    secondProductId = secondProductResult.rows[0].id;

    // Create inventory for the second product.
    await testPool.query(
      `INSERT INTO inventory (product_id, quantity)
       VALUES ($1, $2)`,
      [secondProductId, 10],
    );

    // Create one order containing two different products.
    const order = await createOrder(
      fixture.userId,
      [
        { productId: fixture.productId, quantity: 2 },
        { productId: secondProductId, quantity: 3 },
      ],
      testPool,
    );

    // Retrieve the user's orders.
    const result = await getUserOrders(fixture.userId, {}, testPool);

    assert.equal(result.orders.length, 1);
    assert.equal(result.orders[0].item_count, 2);
    assert.equal(String(result.orders[0].id), String(order.id));
  } finally {
    // Remove transactions for the second product first.
    // They reference the order through order_id.
    if (secondProductId) {
      await testPool.query(
        `DELETE FROM inventory_transactions
         WHERE product_id = $1`,
        [secondProductId],
      );
    }

    // This deletes the fixture's orders.
    // order_items are automatically deleted through ON DELETE CASCADE.
    await cleanupFixture(fixture);

    // The order items have now been removed, so the second
    // product can safely be deleted.
    if (secondProductId) {
      await testPool.query(
        `DELETE FROM inventory
         WHERE product_id = $1`,
        [secondProductId],
      );

      await testPool.query(
        `DELETE FROM products
         WHERE id = $1`,
        [secondProductId],
      );
    }

    if (secondCategoryId) {
      await testPool.query(
        `DELETE FROM categories
         WHERE id = $1`,
        [secondCategoryId],
      );
    }
  }
});


test("getUserOrders supports pagination", async () => {
  let fixture;

  try {
    fixture = await createFixture(20);

    const createdOrders = [];

    // Create five orders for the same user.
    for (let i = 0; i < 5; i++) {
      const order = await createOrder(
        fixture.userId,
        [{ productId: fixture.productId, quantity: 1 }],
        testPool,
      );

      createdOrders.push(order);
    }

    const pageOne = await getUserOrders(
      fixture.userId,
      { page: 1, limit: 2 },
      testPool,
    );

    const pageTwo = await getUserOrders(
      fixture.userId,
      { page: 2, limit: 2 },
      testPool,
    );

    const pageThree = await getUserOrders(
      fixture.userId,
      { page: 3, limit: 2 },
      testPool,
    );

    // Page one.
    assert.equal(pageOne.orders.length, 2);
    assert.equal(pageOne.pagination.page, 1);
    assert.equal(pageOne.pagination.limit, 2);
    assert.equal(pageOne.pagination.total, 5);
    assert.equal(pageOne.pagination.totalPages, 3);

    // Page two.
    assert.equal(pageTwo.orders.length, 2);
    assert.equal(pageTwo.pagination.page, 2);

    // Page three.
    assert.equal(pageThree.orders.length, 1);
    assert.equal(pageThree.pagination.page, 3);

    // Verify that pages do not contain duplicate orders.
    const allReturnedIds = [
      ...pageOne.orders,
      ...pageTwo.orders,
      ...pageThree.orders,
    ].map((order) => String(order.id));

    assert.equal(new Set(allReturnedIds).size, 5);

    // Verify newest-first ordering across pages.
    const expectedIds = createdOrders
      .map((order) => String(order.id))
      .reverse();

    assert.deepEqual(allReturnedIds, expectedIds);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("getUserOrders rejects invalid user IDs", async () => {
  await assert.rejects(getUserOrders("invalid-id", {}, testPool), (error) => {
    assert.equal(error.statusCode, 400);
    return true;
  });
});

test("getUserOrders returns 404 for a nonexistent user", async () => {
  await assert.rejects(
    getUserOrders("999999999999999999", {}, testPool),
    (error) => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.message, "User not found");
      return true;
    },
  );
});

test("getUserOrders rejects invalid pagination values", async () => {
  const invalidOptions = [
    { page: 0 },
    { page: -1 },
    { page: 1.5 },
    { limit: 0 },
    { limit: -1 },
    { limit: 101 },
    { limit: 1.5 },
    { page: Number.MAX_SAFE_INTEGER, limit: 100 },
  ];

  for (const options of invalidOptions) {
    await assert.rejects(getUserOrders("1", options, testPool), (error) => {
      assert.equal(error.statusCode, 400);
      return true;
    });
  }
});


test("getOrderById returns an order with its items", async () => {
  let fixture;

  try {
    fixture = await createFixture(5);

    const createdOrder = await createOrder(
      fixture.userId,
      [{ productId: fixture.productId, quantity: 2 }],
      testPool,
    );

    const result = await getOrderById(
      fixture.userId,
      createdOrder.id,
      testPool,
    );

    assert.equal(String(result.id), String(createdOrder.id));
    assert.equal(String(result.user_id), String(fixture.userId));
    assert.equal(result.status, "placed");
    assert.equal(String(result.total_amount), "30.00");

    assert.equal(result.items.length, 1);

    assert.equal(String(result.items[0].product_id), String(fixture.productId));

    assert.equal(result.items[0].product_name, "Integration Test Product");

    assert.equal(result.items[0].quantity, 2);
    assert.equal(String(result.items[0].unit_price), "15.00");
    assert.equal(String(result.items[0].line_total), "30.00");
  } finally {
    await cleanupFixture(fixture);
  }
});

test("getOrderById prevents users from accessing another user's order", async () => {
  let fixture;
  let secondUserId;

  try {
    fixture = await createFixture(5);
    secondUserId = await createSecondCustomer();

    const createdOrder = await createOrder(
      fixture.userId,
      [{ productId: fixture.productId, quantity: 1 }],
      testPool,
    );

    await assert.rejects(
      getOrderById(secondUserId, createdOrder.id, testPool),
      (error) => {
        assert.equal(error.statusCode, 404);
        assert.equal(error.message, "Order not found");
        return true;
      },
    );
  } finally {
    await cleanupFixture(fixture, secondUserId ? [secondUserId] : []);
  }
});

test("getOrderById returns 404 when the order does not exist", async () => {
  let fixture;

  try {
    fixture = await createFixture(5);

    await assert.rejects(
      getOrderById(fixture.userId, "999999999999999999", testPool),
      (error) => {
        assert.equal(error.statusCode, 404);
        assert.equal(error.message, "Order not found");
        return true;
      },
    );
  } finally {
    await cleanupFixture(fixture);
  }
});
