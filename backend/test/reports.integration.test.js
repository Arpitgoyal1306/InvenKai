const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const pool = require("../src/config/database");

const {
  getStockSummary,
  getLowStockSummary,
  getCategoryStock,
  getStockMovement,
} = require("../src/services/reports.service");

async function withTransaction(callback) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await callback(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

async function createTestCategory(client, name) {
  const result = await client.query(
    `INSERT INTO categories (name)
     VALUES ($1)
     RETURNING id`,
    [name],
  );

  return result.rows[0].id;
}

async function createTestProduct(
  client,
  categoryId,
  { name, sku, threshold, quantity },
) {
  const productResult = await client.query(
    `INSERT INTO products
      (category_id, name, sku, price, low_stock_threshold)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [categoryId, name, sku, 100, threshold],
  );

  const productId = productResult.rows[0].id;

  if (quantity !== undefined) {
    await client.query(
      `INSERT INTO inventory (product_id, quantity)
       VALUES ($1, $2)`,
      [productId, quantity],
    );
  }

  return productId;
}

// 1. Stock summary integration test.

test("getStockSummary calculates totals correctly using PostgreSQL", async () => {
  await withTransaction(async (client) => {
    const uniqueId = randomUUID();

    // Capture existing database totals before inserting test data.
    const before = await getStockSummary(client);

    const categoryId = await createTestCategory(
      client,
      `Summary Test ${uniqueId}`,
    );

    await createTestProduct(client, categoryId, {
      name: "Summary Keyboard",
      sku: `SUMMARY-KB-${uniqueId}`,
      threshold: 10,
      quantity: 50,
    });

    await createTestProduct(client, categoryId, {
      name: "Summary Mouse",
      sku: `SUMMARY-MS-${uniqueId}`,
      threshold: 5,
      quantity: 5,
    });

    await createTestProduct(client, categoryId, {
      name: "Missing Inventory Product",
      sku: `SUMMARY-MISSING-${uniqueId}`,
      threshold: 5,
    });

    const after = await getStockSummary(client);

    // Verify only the changes introduced by this test.
    assert.equal(after.product_count - before.product_count, 3);

    assert.equal(
      after.products_with_inventory - before.products_with_inventory,
      2,
    );

    assert.equal(
      after.products_without_inventory - before.products_without_inventory,
      1,
    );

    assert.equal(
      after.total_stock_quantity - before.total_stock_quantity,
      55,
    );
  });
});

// 2. Low-stock integration test.

test("getLowStockSummary reuses PostgreSQL low-stock filtering", async () => {
  await withTransaction(async (client) => {
    const uniqueId = randomUUID();

    const categoryId = await createTestCategory(
      client,
      `Low Stock Report ${uniqueId}`,
    );

    await createTestProduct(client, categoryId, {
      name: "Below Threshold",
      sku: `REPORT-LOW-${uniqueId}`,
      threshold: 10,
      quantity: 3,
    });

    await createTestProduct(client, categoryId, {
      name: "Above Threshold",
      sku: `REPORT-HIGH-${uniqueId}`,
      threshold: 10,
      quantity: 20,
    });

    await createTestProduct(client, categoryId, {
      name: "No Threshold",
      sku: `REPORT-NULL-${uniqueId}`,
      threshold: null,
      quantity: 2,
    });

    const result = await getLowStockSummary(client);

    const returnedSkus = result.products.map((product) => product.sku);

    // Our below-threshold product must appear.
    assert.ok(returnedSkus.includes(`REPORT-LOW-${uniqueId}`));

    // These two products must not appear.
    assert.ok(!returnedSkus.includes(`REPORT-HIGH-${uniqueId}`));
    assert.ok(!returnedSkus.includes(`REPORT-NULL-${uniqueId}`));

    // Count only the products created by this test.
    const matchingProducts = result.products.filter(
      (product) => product.sku === `REPORT-LOW-${uniqueId}`,
    );

    assert.equal(matchingProducts.length, 1);
  });
});

// 3. Category stock integration test.

test("getCategoryStock calculates category totals without duplicate counts", async () => {
  await withTransaction(async (client) => {
    const uniqueId = randomUUID();

    const categoryA = await createTestCategory(
      client,
      `Category A ${uniqueId}`,
    );

    const categoryB = await createTestCategory(
      client,
      `Category B ${uniqueId}`,
    );

    await createTestProduct(client, categoryA, {
      name: "Category A Product 1",
      sku: `CAT-A-1-${uniqueId}`,
      threshold: 10,
      quantity: 20,
    });

    await createTestProduct(client, categoryA, {
      name: "Category A Product 2",
      sku: `CAT-A-2-${uniqueId}`,
      threshold: 10,
      quantity: 30,
    });

    await createTestProduct(client, categoryB, {
      name: "Category B Product",
      sku: `CAT-B-1-${uniqueId}`,
      threshold: 5,
      quantity: 15,
    });

    // Create a category with no products.
    const emptyCategory = await createTestCategory(
      client,
      `Empty Category ${uniqueId}`,
    );

    const allCategories = await getCategoryStock(undefined, client);

    const categoryAResult = allCategories.categories.find(
      (category) => Number(category.category_id) === Number(categoryA),
    );

    assert.ok(categoryAResult);
    assert.equal(categoryAResult.product_count, 2);
    assert.equal(categoryAResult.products_with_inventory, 2);
    assert.equal(categoryAResult.total_stock_quantity, 50);

    const emptyCategoryResult = allCategories.categories.find(
      (category) =>
        Number(category.category_id) === Number(emptyCategory),
    );

    assert.ok(emptyCategoryResult);
    assert.equal(emptyCategoryResult.product_count, 0);
    assert.equal(emptyCategoryResult.products_with_inventory, 0);
    assert.equal(emptyCategoryResult.total_stock_quantity, 0);

    // Verify optional category filtering.
    const filteredResult = await getCategoryStock(categoryB, client);

    assert.equal(filteredResult.categories.length, 1);

    assert.equal(
      Number(filteredResult.categories[0].category_id),
      Number(categoryB),
    );

    assert.equal(filteredResult.categories[0].total_stock_quantity, 15);
  });
});

// 4. Stock movement integration test.

test("getStockMovement calculates totals and daily dates using PostgreSQL", async () => {
  await withTransaction(async (client) => {
    const uniqueId = randomUUID();

    const categoryId = await createTestCategory(
      client,
      `Movement Test ${uniqueId}`,
    );

    const productId = await createTestProduct(client, categoryId, {
      name: "Movement Product",
      sku: `MOVEMENT-${uniqueId}`,
      threshold: 5,
      quantity: 50,
    });

    // Use a dedicated future date to avoid existing database transactions.
    await client.query(
      `INSERT INTO inventory_transactions
        (product_id, transaction_type, quantity,
         quantity_before, quantity_after, created_at)
       VALUES
        ($1, 'increase', 10, 50, 60, $2),
        ($1, 'decrease', 3, 60, 57, $3),
        ($1, 'increase', 5, 57, 62, $4)`,
      [
        productId,
        "2099-06-15T10:00:00Z",
        "2099-06-15T15:00:00Z",
        "2099-06-16T08:00:00Z",
      ],
    );

    const result = await getStockMovement(
      "2099-06-15",
      "2099-06-15",
      client,
    );

    assert.equal(result.start_date, "2099-06-15");
    assert.equal(result.end_date, "2099-06-15");

    assert.equal(result.total_added, 10);
    assert.equal(result.total_removed, 3);
    assert.equal(result.net_change, 7);

    assert.equal(result.daily.length, 1);
    assert.equal(result.daily[0].date, "2099-06-15");
    assert.equal(result.daily[0].stock_added, 10);
    assert.equal(result.daily[0].stock_removed, 3);
    assert.equal(result.daily[0].net_change, 7);
  });
});

// 5. Inclusive end-date integration test.

test("getStockMovement includes transactions throughout the end date", async () => {
  await withTransaction(async (client) => {
    const uniqueId = randomUUID();

    const categoryId = await createTestCategory(
      client,
      `End Date Test ${uniqueId}`,
    );

    const productId = await createTestProduct(client, categoryId, {
      name: "End Date Product",
      sku: `END-DATE-${uniqueId}`,
      threshold: 5,
      quantity: 20,
    });

    await client.query(
      `INSERT INTO inventory_transactions
        (product_id, transaction_type, quantity,
         quantity_before, quantity_after, created_at)
       VALUES
        ($1, 'increase', 4, 20, 24, $2),
        ($1, 'increase', 6, 24, 30, $3)`,
      [
        productId,
        "2099-07-20T00:00:00Z",
        "2099-07-20T23:59:59.999Z",
      ],
    );

    const result = await getStockMovement(
      "2099-07-20",
      "2099-07-20",
      client,
    );

    assert.equal(result.total_added, 10);
    assert.equal(result.total_removed, 0);
    assert.equal(result.net_change, 10);

    assert.equal(result.daily.length, 1);
    assert.equal(result.daily[0].date, "2099-07-20");
  });
});
