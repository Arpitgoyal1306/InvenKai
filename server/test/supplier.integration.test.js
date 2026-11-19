const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const pool = require("../src/config/database");
const { updateSupplier } = require("../src/services/supplier.service");

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

async function createTestData(client, options = {}) {
  const uniqueId = randomUUID();

  // Create category
  const categoryResult = await client.query(
    `INSERT INTO categories (name)
     VALUES ($1)
     RETURNING id`,
    [`Integration Category ${uniqueId}`]
  );

  const categoryId = categoryResult.rows[0].id;

  // Create first product
  const product1Result = await client.query(
    `INSERT INTO products (category_id, name, sku, price)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      categoryId,
      "Integration Product 1",
      `TEST-${uniqueId}-1`,
      100,
    ]
  );

  const product1Id = product1Result.rows[0].id;

  // Create second product
  const product2Result = await client.query(
    `INSERT INTO products (category_id, name, sku, price)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      categoryId,
      "Integration Product 2",
      `TEST-${uniqueId}-2`,
      200,
    ]
  );

  const product2Id = product2Result.rows[0].id;

  // Create supplier
  const supplierResult = await client.query(
    `INSERT INTO suppliers (name, email, is_active)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [
      "Integration Test Supplier",
      `test-${uniqueId}@example.com`,
      options.isActive ?? true,
    ]
  );

  const supplierId = supplierResult.rows[0].id;

  return {
    categoryId,
    product1Id,
    product2Id,
    supplierId,
  };
}

// Test 1: Inactive supplier cannot receive a new association.
test("rejects INSERT for an inactive supplier", async () => {
  await withTransaction(async (client) => {
    const { supplierId, product1Id } = await createTestData(client, {
      isActive: false,
    });

    await assert.rejects(
      client.query(
        `INSERT INTO supplier_products (supplier_id, product_id)
         VALUES ($1, $2)`,
        [supplierId, product1Id]
      ),
      (error) => error.code === "23514"
    );
  });
});

// Test 2: Inactive supplier cannot receive a product through UPDATE.
test("rejects product_id UPDATE for an inactive supplier", async () => {
  await withTransaction(async (client) => {
    const {
      supplierId,
      product1Id,
      product2Id,
    } = await createTestData(client);

    // Create association while supplier is active.
    await client.query(
      `INSERT INTO supplier_products (supplier_id, product_id)
       VALUES ($1, $2)`,
      [supplierId, product1Id]
    );

    // Deactivate supplier.
    await client.query(
      `UPDATE suppliers
       SET is_active = FALSE
       WHERE id = $1`,
      [supplierId]
    );

    // Changing only product_id must be rejected.
    await assert.rejects(
      client.query(
        `UPDATE supplier_products
         SET product_id = $1
         WHERE supplier_id = $2`,
        [product2Id, supplierId]
      ),
      (error) => error.code === "23514"
    );
  });
});

// Test 3: Duplicate associations are rejected.
test("rejects duplicate supplier-product associations", async () => {
  await withTransaction(async (client) => {
    const { supplierId, product1Id } = await createTestData(client);

    await client.query(
      `INSERT INTO supplier_products (supplier_id, product_id)
       VALUES ($1, $2)`,
      [supplierId, product1Id]
    );

    await assert.rejects(
      client.query(
        `INSERT INTO supplier_products (supplier_id, product_id)
         VALUES ($1, $2)`,
        [supplierId, product1Id]
      ),
      (error) => error.code === "23505"
    );
  });
});

// Test 4: Invalid supplier foreign key is rejected.
test("rejects association with a nonexistent supplier", async () => {
  await withTransaction(async (client) => {
    const { product1Id } = await createTestData(client);

    await assert.rejects(
      client.query(
        `INSERT INTO supplier_products (supplier_id, product_id)
         VALUES ($1, $2)`,
        [999999999999, product1Id]
      ),
      (error) => error.code === "23503"
    );
  });
});

// Test 5: Invalid product foreign key is rejected.
test("rejects association with a nonexistent product", async () => {
  await withTransaction(async (client) => {
    const { supplierId } = await createTestData(client);

    await assert.rejects(
      client.query(
        `INSERT INTO supplier_products (supplier_id, product_id)
         VALUES ($1, $2)`,
        [supplierId, 999999999999]
      ),
      (error) => error.code === "23503"
    );
  });
});

// Test 6: Concurrent PATCH requests must not overwrite each other's changes.
test("preserves both changes from concurrent supplier updates", async () => {
  const uniqueId = randomUUID();

  // Create a supplier that both updates will modify.
  const supplierResult = await pool.query(
    `INSERT INTO suppliers (name, email, phone)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [
      "Concurrent Update Supplier",
      `concurrent-${uniqueId}@example.com`,
      "+91 9876543210",
    ]
  );

  const supplierId = Number(supplierResult.rows[0].id);

  try {
    // Run two PATCH operations at nearly the same time.
    const [contactUpdate, phoneUpdate] = await Promise.all([
      updateSupplier(supplierId, {
        contact_name: "Rahul",
      }),

      updateSupplier(supplierId, {
        phone: "+91 9999999999",
      }),
    ]);

    assert.equal(contactUpdate.contact_name, "Rahul");
    assert.equal(phoneUpdate.phone, "+91 9999999999");

    // Verify the final database state.
    const finalResult = await pool.query(
      `SELECT contact_name, phone
       FROM suppliers
       WHERE id = $1`,
      [supplierId]
    );

    assert.equal(finalResult.rows[0].contact_name, "Rahul");
    assert.equal(finalResult.rows[0].phone, "+91 9999999999");
  } finally {
    // Clean up the test supplier.
    await pool.query(
      "DELETE FROM suppliers WHERE id = $1",
      [supplierId]
    );
  }
});