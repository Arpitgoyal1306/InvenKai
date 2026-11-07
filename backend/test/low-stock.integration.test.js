
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const pool = require("../src/config/database");
const { getLowStockProducts } = require("../src/services/inventory.service");

async function withTransaction(callback) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await callback(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

test("getLowStockProducts correctly filters products using PostgreSQL", async () => {
  await withTransaction(async (client) => {
    const uniqueId = randomUUID();

    // Create a category for the test products.
    const categoryResult = await client.query(
      `INSERT INTO categories (name)
       VALUES ($1)
       RETURNING id`,
      [`Low Stock Test ${uniqueId}`],
    );

    const categoryId = categoryResult.rows[0].id;

    // Create four products with different thresholds.
    const products = [
      {
        name: "Below Threshold",
        sku: `LOW-${uniqueId}`,
        threshold: 5,
        quantity: 2,
      },
      {
        name: "Equal Threshold",
        sku: `EQUAL-${uniqueId}`,
        threshold: 5,
        quantity: 5,
      },
      {
        name: "Above Threshold",
        sku: `ABOVE-${uniqueId}`,
        threshold: 5,
        quantity: 8,
      },
      {
        name: "Null Threshold",
        sku: `NULL-${uniqueId}`,
        threshold: null,
        quantity: 2,
      },
    ];

    const productIds = {};

    for (const product of products) {
      const result = await client.query(
        `INSERT INTO products
          (category_id, name, sku, price, low_stock_threshold)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          categoryId,
          product.name,
          product.sku,
          100,
          product.threshold,
        ],
      );

      productIds[product.name] = result.rows[0].id;

      // Create inventory for these four products.
      await client.query(
        `INSERT INTO inventory (product_id, quantity)
         VALUES ($1, $2)`,
        [result.rows[0].id, product.quantity],
      );
    }

    // Create a fifth product without an inventory record.
    const missingInventoryResult = await client.query(
      `INSERT INTO products
        (category_id, name, sku, price, low_stock_threshold)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        categoryId,
        "Missing Inventory",
        `MISSING-${uniqueId}`,
        100,
        5,
      ],
    );

    productIds["Missing Inventory"] =
      missingInventoryResult.rows[0].id;

    // Execute the actual service query on this transaction connection.
    const lowStockProducts = await getLowStockProducts(client);

    const returnedIds = lowStockProducts.map((product) =>
      Number(product.product_id),
    );

    // Below threshold should be returned.
    assert.ok(returnedIds.includes(Number(productIds["Below Threshold"])));

    // Equal to threshold should also be returned.
    assert.ok(returnedIds.includes(Number(productIds["Equal Threshold"])));

    // Above threshold should not be returned.
    assert.ok(!returnedIds.includes(Number(productIds["Above Threshold"])));

    // NULL threshold should not be returned.
    assert.ok(!returnedIds.includes(Number(productIds["Null Threshold"])));

    // Product without an inventory record should not be returned.
    assert.ok(!returnedIds.includes(Number(productIds["Missing Inventory"])));

    // Exactly two products should match.
    assert.equal(lowStockProducts.length, 2);
  });
});
