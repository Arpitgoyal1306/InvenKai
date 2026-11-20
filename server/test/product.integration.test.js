require("dotenv").config();

if (process.env.NODE_ENV !== "test") {
  throw new Error(
    "product.integration.test.js must run with NODE_ENV=test",
  );
}

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL is required");
}

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const path = require("node:path");

const pool = require("../src/config/database");

const {
  createProduct,
  getProducts,
  getProductById,
  updateProduct,
  archiveProduct,
} = require("../src/services/product.service");

before(async () => {
  await pool.verifyDatabaseIdentity();
});

async function createCategory() {
  const uniqueId = randomUUID();

  const result = await pool.query(
    `INSERT INTO categories (name)
     VALUES ($1)
     RETURNING id`,
    [`Product Integration ${uniqueId}`],
  );

  return result.rows[0].id;
}

async function createProductFixture(options = {}) {
  const uniqueId = randomUUID();
  const categoryId = await createCategory();

  const result = await pool.query(
    `INSERT INTO products
      (category_id, name, description, sku, price)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      categoryId,
      options.name || "Integration Product",
      options.description ?? "Integration test product",
      `TEST-${uniqueId}`,
      options.price ?? 100,
    ],
  );

  return {
    categoryId,
    productId: result.rows[0].id,
    sku: `TEST-${uniqueId}`,
  };
}

async function cleanupProductFixture(fixture) {
  if (!fixture) return;

  const { productId, categoryId, supplierId } = fixture;

  if (productId) {
    await pool.query("DELETE FROM supplier_products WHERE product_id = $1", [
      productId,
    ]);

    await pool.query(
      "DELETE FROM inventory_transactions WHERE product_id = $1",
      [productId],
    );

    await pool.query("DELETE FROM inventory WHERE product_id = $1", [
      productId,
    ]);

    await pool.query("DELETE FROM products WHERE id = $1", [productId]);
  }

  if (supplierId) {
    await pool.query("DELETE FROM suppliers WHERE id = $1", [supplierId]);
  }

  if (categoryId) {
    await pool.query("DELETE FROM categories WHERE id = $1", [categoryId]);
  }
}

// 1. CREATE PRODUCT
test("creates a product in PostgreSQL", async () => {
  const categoryId = await createCategory();
  let productId;

  try {
    const uniqueId = randomUUID();

    const product = await createProduct({
      category_id: String(categoryId),
      name: "Created Integration Product",
      description: "Created through product service",
      sku: `CREATE-${uniqueId}`,
      price: 499.99,
    });

    productId = product.id;

    assert.ok(product.id);
    assert.equal(product.name, "Created Integration Product");
    assert.equal(product.sku, `CREATE-${uniqueId}`);
    assert.equal(Number(product.price), 499.99);
    assert.equal(String(product.category_id), String(categoryId));

    const result = await pool.query("SELECT * FROM products WHERE id = $1", [
      product.id,
    ]);

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].sku, `CREATE-${uniqueId}`);

    const inventoryResult = await pool.query(
      `SELECT product_id, quantity
       FROM inventory
       WHERE product_id = $1`,
      [product.id],
    );

    assert.equal(inventoryResult.rows.length, 1);
    assert.equal(String(inventoryResult.rows[0].product_id), String(product.id));
    assert.equal(inventoryResult.rows[0].quantity, 0);
  } finally {
    if (productId) {
      await pool.query("DELETE FROM inventory WHERE product_id = $1", [
        productId,
      ]);

      await pool.query("DELETE FROM products WHERE id = $1", [productId]);
    }

    await pool.query("DELETE FROM categories WHERE id = $1", [categoryId]);
  }
});

// 2. DUPLICATE SKU
test("rejects duplicate SKUs using PostgreSQL unique constraint", async () => {
  const fixture = await createProductFixture();

  try {
    await assert.rejects(
      createProduct({
        category_id: String(fixture.categoryId),
        name: "Duplicate SKU Product",
        sku: fixture.sku,
        price: 200,
      }),
      (error) => error.statusCode === 409,
    );
  } finally {
    await cleanupProductFixture(fixture);
  }
});

// 3. INVALID CATEGORY
test("rejects a nonexistent category", async () => {
  const uniqueId = randomUUID();

  await assert.rejects(
    createProduct({
      category_id: "9223372036854775807",
      name: "Invalid Category Product",
      sku: `INVALID-${uniqueId}`,
      price: 100,
    }),
    (error) => error.statusCode === 400,
  );
});

// 4. GET PRODUCT BY ID
test("retrieves a product from PostgreSQL by ID", async () => {
  const fixture = await createProductFixture();

  try {
    const product = await getProductById(String(fixture.productId));

    assert.ok(product);
    assert.equal(String(product.id), String(fixture.productId));
    assert.equal(String(product.category_id), String(fixture.categoryId));
    assert.equal(product.sku, fixture.sku);
  } finally {
    await cleanupProductFixture(fixture);
  }
});

// 5. GET ALL PRODUCTS
test("retrieves products with pagination from PostgreSQL", async () => {
  const fixture = await createProductFixture();
  const client = await pool.connect();

  try {
    // Keep the count and page query on one stable snapshot while other
    // integration tests modify the shared products table.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");

    // Fetch the product directly to establish its position.
    const positionResult = await client.query(
      `SELECT COUNT(*) AS position
       FROM products
       WHERE id < $1`,
      [fixture.productId],
    );

    const position = Number(positionResult.rows[0].position);

    // Calculate the page containing our fixture.
    const offset = Math.floor(position / 10) * 10;

    const totalResult = await client.query("SELECT COUNT(*) AS total FROM products");
    const products = await getProducts(10, offset, client);

    assert.ok(Array.isArray(products));
    assert.ok(products.length <= 10);
    assert.ok(Number(totalResult.rows[0].total) > position);

    const ids = products.map((product) => BigInt(product.id));

    for (let i = 1; i < ids.length; i++) {
      assert.ok(ids[i] > ids[i - 1]);
    }

    assert.ok(
      products.some(
        (product) => String(product.id) === String(fixture.productId),
      ),
    );
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    await cleanupProductFixture(fixture);
  }
});


// 6. UPDATE PRODUCT
test("updates a product and persists changes in PostgreSQL", async () => {
  const fixture = await createProductFixture();

  try {
    const updatedProduct = await updateProduct(String(fixture.productId), {
      name: "Updated Integration Product",
      price: 250.5,
    });

    assert.equal(updatedProduct.name, "Updated Integration Product");
    assert.equal(Number(updatedProduct.price), 250.5);

    const result = await pool.query(
      "SELECT name, price FROM products WHERE id = $1",
      [fixture.productId],
    );

    assert.equal(result.rows[0].name, "Updated Integration Product");
    assert.equal(Number(result.rows[0].price), 250.5);
  } finally {
    await cleanupProductFixture(fixture);
  }
});

// 7. PARTIAL UPDATE
test("preserves unchanged fields during a partial update", async () => {
  const fixture = await createProductFixture({
    name: "Original Product Name",
    description: "Original description",
    price: 100,
  });

  try {
    const updatedProduct = await updateProduct(String(fixture.productId), {
      name: "New Product Name",
    });

    assert.equal(updatedProduct.name, "New Product Name");
    assert.equal(updatedProduct.description, "Original description");
    assert.equal(Number(updatedProduct.price), 100);
    assert.equal(updatedProduct.sku, fixture.sku);
  } finally {
    await cleanupProductFixture(fixture);
  }
});

// 8. CONCURRENT UPDATES
test("preserves independent changes from concurrent product updates", async () => {
  const fixture = await createProductFixture({
    name: "Concurrent Original",
    price: 100,
  });

  try {
    const [nameUpdate, priceUpdate] = await Promise.all([
      updateProduct(String(fixture.productId), {
        name: "Concurrent Updated",
      }),

      updateProduct(String(fixture.productId), {
        price: 350,
      }),
    ]);

    assert.equal(nameUpdate.name, "Concurrent Updated");
    assert.equal(Number(priceUpdate.price), 350);

    const finalProduct = await getProductById(String(fixture.productId));

    assert.equal(finalProduct.name, "Concurrent Updated");
    assert.equal(Number(finalProduct.price), 350);
  } finally {
    await cleanupProductFixture(fixture);
  }
});

// 9. DELETE PRODUCT WITHOUT DEPENDENCIES
test("archives a product without dependent records", async () => {
  const fixture = await createProductFixture();

  try {
    const archivedProduct = await archiveProduct(String(fixture.productId));

    assert.equal(String(archivedProduct.id), String(fixture.productId));

    const result = await pool.query("SELECT id FROM products WHERE id = $1", [
      fixture.productId,
    ]);

    assert.equal(result.rows.length, 1);
    assert.equal(archivedProduct.archived, true);
    assert.equal(await getProductById(String(fixture.productId)), null);
  } finally {
    await cleanupProductFixture(fixture);
  }
});

// 10. DELETE PRODUCT WITH INVENTORY
test("archives without removing inventory", async () => {
  const fixture = await createProductFixture();

  try {
    await pool.query(
      `INSERT INTO inventory (product_id, quantity)
       VALUES ($1, $2)`,
      [fixture.productId, 0],
    );

    assert.equal((await archiveProduct(String(fixture.productId))).archived, true);
  } finally {
    await cleanupProductFixture(fixture);
  }
});

// 11. DELETE PRODUCT WITH TRANSACTION HISTORY
test("archives without removing transaction history", async () => {
  const fixture = await createProductFixture();

  try {
    await pool.query(
      `INSERT INTO inventory_transactions (
        product_id,
        performed_by,
        transaction_type,
        quantity,
        quantity_before,
        quantity_after
      )
      VALUES ($1, NULL, 'increase', 5, 0, 5)`,
      [fixture.productId],
    );

    assert.equal((await archiveProduct(String(fixture.productId))).archived, true);
  } finally {
    await cleanupProductFixture(fixture);
  }
});

// 12. DELETE PRODUCT WITH SUPPLIER ASSOCIATION
test("archives without removing supplier associations", async () => {
  const fixture = await createProductFixture();
  const uniqueId = randomUUID();

  try {
    const supplierResult = await pool.query(
      `INSERT INTO suppliers (name, email)
       VALUES ($1, $2)
       RETURNING id`,
      ["Product Integration Supplier", `supplier-${uniqueId}@example.com`],
    );

    fixture.supplierId = supplierResult.rows[0].id;

    await pool.query(
      `INSERT INTO supplier_products (supplier_id, product_id)
       VALUES ($1, $2)`,
      [fixture.supplierId, fixture.productId],
    );

    assert.equal((await archiveProduct(String(fixture.productId))).archived, true);
  } finally {
    await cleanupProductFixture(fixture);
  }
});

// 13. BACKFILL MIGRATION IDEMPOTENCY & PRESERVATION
test("backfill migration creates missing inventory records and preserves existing quantities", async () => {
  const { jiti, MigrationBuilder } = await import("node-pg-migrate");
  const migrationPath = path.resolve(
    __dirname,
    "../migrations/1794300000000_backfill-product-inventory.js",
  );
  const backfillMigration = await jiti.import(migrationPath);

  const client = await pool.connect();

  async function applyBackfillMigration(direction = "up") {
    const pgm = new MigrationBuilder({}, {}, false, console);
    await backfillMigration[direction](pgm);
    const sqlSteps = pgm.getSqlSteps();

    for (const sql of sqlSteps) {
      await client.query(sql);
    }

    return sqlSteps;
  }

  try {
    // Run inside an isolated transaction with session-local temporary tables
    // cloned from public schema so the migration SQL executes against real
    // PostgreSQL table definitions and constraints without modifying any
    // shared rows in public.products or public.inventory.
    await client.query("BEGIN");

    await client.query(`
      CREATE TEMP SEQUENCE temp_categories_id_seq;
      CREATE TEMP SEQUENCE temp_products_id_seq;
      CREATE TEMP SEQUENCE temp_inventory_id_seq;

      CREATE TEMP TABLE categories (
        LIKE public.categories INCLUDING ALL
      ) ON COMMIT DROP;
      ALTER TABLE pg_temp.categories
        ALTER COLUMN id SET DEFAULT nextval('temp_categories_id_seq');

      CREATE TEMP TABLE products (
        LIKE public.products INCLUDING ALL,
        FOREIGN KEY (category_id) REFERENCES pg_temp.categories(id) ON DELETE RESTRICT
      ) ON COMMIT DROP;
      ALTER TABLE pg_temp.products
        ALTER COLUMN id SET DEFAULT nextval('temp_products_id_seq');

      CREATE TEMP TABLE inventory (
        LIKE public.inventory INCLUDING ALL,
        FOREIGN KEY (product_id) REFERENCES pg_temp.products(id) ON DELETE RESTRICT
      ) ON COMMIT DROP;
      ALTER TABLE pg_temp.inventory
        ALTER COLUMN id SET DEFAULT nextval('temp_inventory_id_seq');
    `);

    const categoryResult = await client.query(
      `INSERT INTO categories (name)
       VALUES ('Migration Test Category')
       RETURNING id`,
    );
    const categoryId = categoryResult.rows[0].id;

    const productsResult = await client.query(
      `INSERT INTO products (category_id, name, description, sku, price)
       VALUES ($1, 'Product Missing Inventory', 'Test', 'MIG-NO-INV', 100),
              ($1, 'Product With Inventory', 'Test', 'MIG-HAS-INV', 200)
       RETURNING id`,
      [categoryId],
    );

    const productWithoutInventoryId = productsResult.rows[0].id;
    const productWithInventoryId = productsResult.rows[1].id;

    await client.query(
      `INSERT INTO inventory (product_id, quantity)
       VALUES ($1, 25)`,
      [productWithInventoryId],
    );

    const firstRunSteps = await applyBackfillMigration("up");
    assert.ok(firstRunSteps.length > 0);

    const inv1 = await client.query(
      "SELECT quantity FROM inventory WHERE product_id = $1",
      [productWithoutInventoryId],
    );
    assert.equal(inv1.rows.length, 1);
    assert.equal(inv1.rows[0].quantity, 0);

    const inv2 = await client.query(
      "SELECT quantity FROM inventory WHERE product_id = $1",
      [productWithInventoryId],
    );
    assert.equal(inv2.rows.length, 1);
    assert.equal(inv2.rows[0].quantity, 25);

    const secondRunSteps = await applyBackfillMigration("up");
    assert.ok(secondRunSteps.length > 0);

    const inv1After = await client.query(
      "SELECT quantity FROM inventory WHERE product_id = $1",
      [productWithoutInventoryId],
    );
    assert.equal(inv1After.rows.length, 1);
    assert.equal(inv1After.rows[0].quantity, 0);

    const inv2After = await client.query(
      "SELECT quantity FROM inventory WHERE product_id = $1",
      [productWithInventoryId],
    );
    assert.equal(inv2After.rows.length, 1);
    assert.equal(inv2After.rows[0].quantity, 25);

    const downSteps = await applyBackfillMigration("down");
    assert.deepEqual(downSteps, []);

    const inv1AfterDown = await client.query(
      "SELECT quantity FROM inventory WHERE product_id = $1",
      [productWithoutInventoryId],
    );
    assert.equal(inv1AfterDown.rows.length, 1);
    assert.equal(inv1AfterDown.rows[0].quantity, 0);

    const inv2AfterDown = await client.query(
      "SELECT quantity FROM inventory WHERE product_id = $1",
      [productWithInventoryId],
    );
    assert.equal(inv2AfterDown.rows.length, 1);
    assert.equal(inv2AfterDown.rows[0].quantity, 25);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
});
