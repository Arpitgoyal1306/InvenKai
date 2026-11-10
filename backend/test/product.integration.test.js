const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

const pool = require("../src/config/database");

const {
  createProduct,
  getProducts,
  getProductById,
  updateProduct,
  deleteProduct,
} = require("../src/services/product.service");

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
  } finally {
    if (productId) {
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

  try {
    const products = await getProducts(10, 0);

    assert.ok(Array.isArray(products));
    assert.ok(products.length <= 10);

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
test("deletes a product without dependent records", async () => {
  const fixture = await createProductFixture();

  try {
    const deletedProduct = await deleteProduct(String(fixture.productId));

    assert.equal(String(deletedProduct.id), String(fixture.productId));

    const result = await pool.query("SELECT id FROM products WHERE id = $1", [
      fixture.productId,
    ]);

    assert.equal(result.rows.length, 0);
  } finally {
    await cleanupProductFixture(fixture);
  }
});

// 10. DELETE PRODUCT WITH INVENTORY
test("prevents deletion of a product with inventory", async () => {
  const fixture = await createProductFixture();

  try {
    await pool.query(
      `INSERT INTO inventory (product_id, quantity)
       VALUES ($1, $2)`,
      [fixture.productId, 0],
    );

    await assert.rejects(
      deleteProduct(String(fixture.productId)),
      (error) => error.statusCode === 409,
    );
  } finally {
    await cleanupProductFixture(fixture);
  }
});

// 11. DELETE PRODUCT WITH TRANSACTION HISTORY
test("prevents deletion of a product with transaction history", async () => {
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

    await assert.rejects(
      deleteProduct(String(fixture.productId)),
      (error) => error.statusCode === 409,
    );
  } finally {
    await cleanupProductFixture(fixture);
  }
});

// 12. DELETE PRODUCT WITH SUPPLIER ASSOCIATION
test("prevents deletion of a product associated with a supplier", async () => {
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

    await assert.rejects(
      deleteProduct(String(fixture.productId)),
      (error) => error.statusCode === 409,
    );
  } finally {
    await cleanupProductFixture(fixture);
  }
});
