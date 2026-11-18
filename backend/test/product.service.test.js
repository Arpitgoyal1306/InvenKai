const { test, mock } = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../src/config/database");

const {
  createProduct,
  getProducts,
  getProductById,
  updateProduct,
  deleteProduct,
} = require("../src/services/product.service");

// --------------------------------------------------
// PRODUCT TRANSACTION MOCK
// --------------------------------------------------

function createProductClientMock(queryHandler) {
  const queries = [];
  let released = false;

  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return queryHandler(sql, params, queries);
    },

    release: () => {
      released = true;
    },
  };

  const connectMock = mock.method(pool, "connect", async () => client);

  return {
    client,
    queries,
    connectMock,
    wasReleased: () => released,
  };
}

// --------------------------------------------------
// CREATE PRODUCT TESTS
// --------------------------------------------------

const mockProduct = {
  id: "1",
  category_id: "2",
  name: "Laptop",
  description: "Gaming laptop",
  sku: "LAP-001",
  price: "75000.00",
};

const validProductData = {
  category_id: 2,
  name: "Laptop",
  sku: "LAP-001",
  price: 75000,
};

test("createProduct creates product and inventory in one transaction", async () => {
  const clientMock = createProductClientMock(async (sql) => {
    if (sql.includes("INSERT INTO products")) {
      return { rows: [mockProduct] };
    }

    return { rows: [] };
  });

  try {
    const product = await createProduct({
      category_id: 2,
      name: " Laptop ",
      description: " Gaming laptop ",
      sku: " LAP-001 ",
      price: 75000,
    });

    assert.deepEqual(product, mockProduct);

    assert.deepEqual(
      clientMock.queries.map(({ sql }) => sql.trim().split(/\s+/)[0]),
      ["BEGIN", "INSERT", "INSERT", "COMMIT"],
    );

    assert.deepEqual(clientMock.queries[1].params, [
      2,
      "Laptop",
      "Gaming laptop",
      "LAP-001",
      75000,
    ]);

    assert.match(clientMock.queries[1].sql, /INSERT INTO products/i);

    assert.match(clientMock.queries[1].sql, /RETURNING \*/i);

    assert.match(clientMock.queries[2].sql, /INSERT INTO inventory/i);

    assert.deepEqual(clientMock.queries[2].params, ["1"]);

    assert.equal(clientMock.wasReleased(), true);
  } finally {
    clientMock.connectMock.mock.restore();
  }
});

test("createProduct accepts a null or whitespace-only description", async () => {
  const clientMock = createProductClientMock(async (sql) => {
    if (sql.includes("INSERT INTO products")) {
      return { rows: [{ id: "1" }] };
    }

    return { rows: [] };
  });

  try {
    await createProduct(validProductData);
    assert.equal(clientMock.queries[1].params[2], null);

    await createProduct({
      ...validProductData,
      description: "   ",
    });
    assert.equal(clientMock.queries[5].params[2], null);
  } finally {
    clientMock.connectMock.mock.restore();
  }
});

// --------------------------------------------------
// VALIDATION TESTS
// --------------------------------------------------

test("createProduct rejects missing or invalid required fields", async () => {
  const connectMock = mock.method(pool, "connect", async () => {
    throw new Error("Database should not be connected");
  });

  try {
    await assert.rejects(createProduct(null), { statusCode: 400 });
    await assert.rejects(createProduct([]), { statusCode: 400 });
    await assert.rejects(createProduct({}), { statusCode: 400 });

    await assert.rejects(
      createProduct({
        name: "Laptop",
        sku: "LAP-001",
        price: 75000,
      }),
      { statusCode: 400 },
    );

    await assert.rejects(
      createProduct({
        category_id: 2,
        name: "Laptop",
        sku: "LAP-001",
      }),
      { statusCode: 400 },
    );

    assert.equal(connectMock.mock.calls.length, 0);
  } finally {
    connectMock.mock.restore();
  }
});

test("createProduct rejects invalid category IDs", async () => {
  const connectMock = mock.method(pool, "connect", async () => {
    throw new Error("Database should not be connected");
  });

  try {
    for (const categoryId of [0, -1, 1.5, "0", "abc", "9223372036854775808"]) {
      await assert.rejects(
        createProduct({
          ...validProductData,
          category_id: categoryId,
        }),
        { statusCode: 400 },
      );
    }

    assert.equal(connectMock.mock.calls.length, 0);
  } finally {
    connectMock.mock.restore();
  }
});

test("createProduct rejects invalid product names", async () => {
  const connectMock = mock.method(pool, "connect", async () => {
    throw new Error("Database should not be connected");
  });

  try {
    for (const name of ["", "   ", 123, "A".repeat(201)]) {
      await assert.rejects(
        createProduct({
          ...validProductData,
          name,
        }),
        { statusCode: 400 },
      );
    }

    assert.equal(connectMock.mock.calls.length, 0);
  } finally {
    connectMock.mock.restore();
  }
});

test("createProduct rejects invalid SKUs", async () => {
  const connectMock = mock.method(pool, "connect", async () => {
    throw new Error("Database should not be connected");
  });

  try {
    for (const sku of ["", "   ", 123, "A".repeat(101)]) {
      await assert.rejects(
        createProduct({
          ...validProductData,
          sku,
        }),
        { statusCode: 400 },
      );
    }

    assert.equal(connectMock.mock.calls.length, 0);
  } finally {
    connectMock.mock.restore();
  }
});

test("createProduct rejects invalid prices", async () => {
  const connectMock = mock.method(pool, "connect", async () => {
    throw new Error("Database should not be connected");
  });

  try {
    for (const price of [-1, 1.234, 100000000, "75000", NaN, Infinity]) {
      await assert.rejects(
        createProduct({
          ...validProductData,
          price,
        }),
        { statusCode: 400 },
      );
    }

    assert.equal(connectMock.mock.calls.length, 0);
  } finally {
    connectMock.mock.restore();
  }
});

test("createProduct rejects unknown fields", async () => {
  const connectMock = mock.method(pool, "connect", async () => {
    throw new Error("Database should not be connected");
  });

  try {
    await assert.rejects(
      createProduct({
        ...validProductData,
        stock: 100,
      }),
      { statusCode: 400 },
    );

    assert.equal(connectMock.mock.calls.length, 0);
  } finally {
    connectMock.mock.restore();
  }
});

// --------------------------------------------------
// DATABASE ERROR TESTS
// --------------------------------------------------

test("createProduct maps duplicate SKU errors to HTTP 409", async () => {
  const clientMock = createProductClientMock(async (sql) => {
    if (sql.includes("INSERT INTO products")) {
      const error = new Error("Duplicate SKU");
      error.code = "23505";
      throw error;
    }

    return { rows: [] };
  });

  try {
    await assert.rejects(createProduct(validProductData), {
      message: "A product with this SKU already exists",
      statusCode: 409,
    });

    assert.match(clientMock.queries.at(-1).sql, /ROLLBACK/i);

    assert.equal(clientMock.wasReleased(), true);
  } finally {
    clientMock.connectMock.mock.restore();
  }
});

test("createProduct maps invalid category foreign-key errors to HTTP 400", async () => {
  const clientMock = createProductClientMock(async (sql) => {
    if (sql.includes("INSERT INTO products")) {
      const error = new Error("Foreign key violation");
      error.code = "23503";
      throw error;
    }

    return { rows: [] };
  });

  try {
    await assert.rejects(
      createProduct({
        ...validProductData,
        category_id: 999,
      }),
      {
        message: "The specified category does not exist",
        statusCode: 400,
      },
    );

    assert.match(clientMock.queries.at(-1).sql, /ROLLBACK/i);

    assert.equal(clientMock.wasReleased(), true);
  } finally {
    clientMock.connectMock.mock.restore();
  }
});

test("createProduct rolls back when inventory creation fails", async () => {
  const clientMock = createProductClientMock(async (sql) => {
    if (sql.includes("INSERT INTO products")) {
      return { rows: [mockProduct] };
    }

    if (sql.includes("INSERT INTO inventory")) {
      throw new Error("Inventory insertion failed");
    }

    return { rows: [] };
  });

  try {
    await assert.rejects(
      createProduct(validProductData),
      /Inventory insertion failed/,
    );

    assert.match(clientMock.queries.at(-1).sql, /ROLLBACK/i);

    assert.equal(clientMock.wasReleased(), true);
  } finally {
    clientMock.connectMock.mock.restore();
  }
});

test("createProduct propagates unexpected database errors", async () => {
  const clientMock = createProductClientMock(async (sql) => {
    if (sql.includes("INSERT INTO products")) {
      throw new Error("Database connection failed");
    }

    return { rows: [] };
  });

  try {
    await assert.rejects(
      createProduct(validProductData),
      /Database connection failed/,
    );

    assert.match(clientMock.queries.at(-1).sql, /ROLLBACK/i);

    assert.equal(clientMock.wasReleased(), true);
  } finally {
    clientMock.connectMock.mock.restore();
  }
});

// --------------------------------------------------
// READ PRODUCT TESTS
// --------------------------------------------------

test("getProducts returns products with pagination", async () => {
  const mockProducts = [
    { id: "1", name: "Laptop", sku: "LAP-001" },
    { id: "2", name: "Mouse", sku: "MOU-001" },
  ];
  const queryMock = mock.method(pool, "query", async () => ({ rows: mockProducts }));

  try {
    const products = await getProducts(10, 20);
    assert.deepEqual(products, mockProducts);
    assert.deepEqual(queryMock.mock.calls[0].arguments[1], [10, 20]);
    assert.match(queryMock.mock.calls[0].arguments[0], /ORDER BY id/i);
    assert.match(queryMock.mock.calls[0].arguments[0], /LIMIT \$1/i);
    assert.match(queryMock.mock.calls[0].arguments[0], /OFFSET \$2/i);
  } finally {
    queryMock.mock.restore();
  }
});

test("getProducts uses default pagination", async () => {
  const queryMock = mock.method(pool, "query", async () => ({ rows: [] }));

  try {
    await getProducts();
    assert.deepEqual(queryMock.mock.calls[0].arguments[1], [10, 0]);
  } finally {
    queryMock.mock.restore();
  }
});

test("getProducts rejects invalid pagination values", async () => {
  const queryMock = mock.method(pool, "query", async () => ({ rows: [] }));

  try {
    for (const [limit, offset] of [[-1, 0], [0, 0], [101, 0], [1.5, 0], [10, -1], [10, 1.5]]) {
      await assert.rejects(getProducts(limit, offset), { statusCode: 400 });
    }
    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});

test("getProductById returns a product when found", async () => {
  const mockProduct = {
    id: "1",
    category_id: "2",
    name: "Laptop",
    sku: "LAP-001",
    price: "75000.00",
  };
  const queryMock = mock.method(pool, "query", async () => ({ rows: [mockProduct] }));

  try {
    assert.deepEqual(await getProductById("1"), mockProduct);
    assert.deepEqual(queryMock.mock.calls[0].arguments[1], ["1"]);
    assert.match(queryMock.mock.calls[0].arguments[0], /WHERE id = \$1/i);
  } finally {
    queryMock.mock.restore();
  }
});

test("getProductById returns null when product does not exist", async () => {
  const queryMock = mock.method(pool, "query", async () => ({ rows: [] }));

  try {
    assert.equal(await getProductById("999"), null);
    assert.equal(queryMock.mock.calls.length, 1);
  } finally {
    queryMock.mock.restore();
  }
});

test("getProductById rejects invalid product IDs without querying", async () => {
  const queryMock = mock.method(pool, "query", async () => ({ rows: [] }));

  try {
    for (const id of [0, -1, 1.5, "0", "abc", "9223372036854775808"]) {
      await assert.rejects(getProductById(id), { statusCode: 400 });
    }
    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});

const existingProduct = {
  id: "1",
  category_id: "2",
  name: "Laptop",
  description: "Gaming laptop",
  sku: "LAP-001",
  price: "75000.00",
};

// --------------------------------------------------
// UPDATE PRODUCT TESTS
// --------------------------------------------------

test("updateProduct updates a product successfully inside a transaction", async () => {
  const updatedProduct = { ...existingProduct, name: "Gaming Laptop" };
  const clientMock = createProductClientMock(async (sql) => {
    if (sql.includes("SELECT")) return { rows: [existingProduct] };
    if (sql.includes("UPDATE products")) return { rows: [updatedProduct] };
    return { rows: [] };
  });

  try {
    assert.deepEqual(await updateProduct("1", { name: "Gaming Laptop" }), updatedProduct);
    assert.match(clientMock.queries[0].sql, /BEGIN/i);
    assert.match(clientMock.queries[1].sql, /FOR UPDATE/i);
    assert.match(clientMock.queries[2].sql, /UPDATE products/i);
    assert.match(clientMock.queries[3].sql, /COMMIT/i);
    assert.deepEqual(clientMock.queries[2].params, [
      "2", "Gaming Laptop", "Gaming laptop", "LAP-001", 75000, "1",
    ]);
    assert.equal(clientMock.wasReleased(), true);
  } finally {
    clientMock.connectMock.mock.restore();
  }
});

test("updateProduct preserves existing values during partial updates", async () => {
  const updatedProduct = { ...existingProduct, price: "80000.00" };
  const clientMock = createProductClientMock(async (sql) => {
    if (sql.includes("SELECT")) return { rows: [existingProduct] };
    if (sql.includes("UPDATE products")) return { rows: [updatedProduct] };
    return { rows: [] };
  });

  try {
    assert.deepEqual(await updateProduct("1", { price: 80000 }), updatedProduct);
    assert.deepEqual(clientMock.queries[2].params, [
      "2", "Laptop", "Gaming laptop", "LAP-001", 80000, "1",
    ]);
    assert.equal(clientMock.wasReleased(), true);
  } finally {
    clientMock.connectMock.mock.restore();
  }
});

test("updateProduct rejects empty updates without connecting", async () => {
  const connectMock = mock.method(pool, "connect", async () => {
    throw new Error("Database should not be connected");
  });

  try {
    await assert.rejects(updateProduct("1", {}), { statusCode: 400 });
    assert.equal(connectMock.mock.calls.length, 0);
  } finally {
    connectMock.mock.restore();
  }
});

test("updateProduct rejects invalid IDs and fields without connecting", async () => {
  const connectMock = mock.method(pool, "connect", async () => {
    throw new Error("Database should not be connected");
  });

  try {
    await assert.rejects(updateProduct("0", { name: "New name" }), { statusCode: 400 });
    await assert.rejects(updateProduct("9223372036854775808", { name: "New name" }), { statusCode: 400 });
    await assert.rejects(updateProduct("1", { stock: 100 }), { statusCode: 400 });
    assert.equal(connectMock.mock.calls.length, 0);
  } finally {
    connectMock.mock.restore();
  }
});

test("updateProduct returns 404 when product does not exist", async () => {
  const clientMock = createProductClientMock(async () => ({ rows: [] }));

  try {
    await assert.rejects(updateProduct("999", { name: "New name" }), {
      message: "Product not found",
      statusCode: 404,
    });
    assert.match(clientMock.queries.at(-1).sql, /ROLLBACK/i);
    assert.equal(clientMock.wasReleased(), true);
  } finally {
    clientMock.connectMock.mock.restore();
  }
});

test("updateProduct rolls back when merged product data is invalid", async () => {
  const invalidExistingProduct = { ...existingProduct, name: "   " };
  const clientMock = createProductClientMock(async (sql) => {
    if (sql.includes("SELECT")) return { rows: [invalidExistingProduct] };
    return { rows: [] };
  });

  try {
    await assert.rejects(updateProduct("1", { description: "Updated description" }), {
      statusCode: 400,
    });
    assert.equal(clientMock.queries.some(({ sql }) => sql.includes("UPDATE products")), false);
    assert.match(clientMock.queries.at(-1).sql, /ROLLBACK/i);
    assert.equal(clientMock.wasReleased(), true);
  } finally {
    clientMock.connectMock.mock.restore();
  }
});

test("updateProduct maps duplicate SKU errors to HTTP 409", async () => {
  const clientMock = createProductClientMock(async (sql) => {
    if (sql.includes("SELECT")) return { rows: [existingProduct] };
    if (sql.includes("UPDATE products")) {
      const error = new Error("Duplicate SKU");
      error.code = "23505";
      throw error;
    }
    return { rows: [] };
  });

  try {
    await assert.rejects(updateProduct("1", { sku: "LAP-002" }), {
      statusCode: 409,
      message: "A product with this SKU already exists",
    });
    assert.match(clientMock.queries.at(-1).sql, /ROLLBACK/i);
    assert.equal(clientMock.wasReleased(), true);
  } finally {
    clientMock.connectMock.mock.restore();
  }
});

test("updateProduct maps invalid category errors to HTTP 400", async () => {
  const clientMock = createProductClientMock(async (sql) => {
    if (sql.includes("SELECT")) return { rows: [existingProduct] };
    if (sql.includes("UPDATE products")) {
      const error = new Error("Foreign key violation");
      error.code = "23503";
      throw error;
    }
    return { rows: [] };
  });

  try {
    await assert.rejects(updateProduct("1", { category_id: 999 }), {
      statusCode: 400,
      message: "The specified category does not exist",
    });
    assert.match(clientMock.queries.at(-1).sql, /ROLLBACK/i);
    assert.equal(clientMock.wasReleased(), true);
  } finally {
    clientMock.connectMock.mock.restore();
  }
});

// --------------------------------------------------
// DELETE PRODUCT TESTS
// --------------------------------------------------

test("deleteProduct deletes a product successfully", async () => {
  const deletedProduct = { ...existingProduct };
  const queryMock = mock.method(pool, "query", async () => ({ rows: [deletedProduct] }));

  try {
    assert.deepEqual(await deleteProduct("1"), deletedProduct);
    assert.deepEqual(queryMock.mock.calls[0].arguments[1], ["1"]);
    assert.match(queryMock.mock.calls[0].arguments[0], /DELETE FROM products/i);
    assert.match(queryMock.mock.calls[0].arguments[0], /WHERE id = \$1/i);
    assert.match(queryMock.mock.calls[0].arguments[0], /RETURNING \*/i);
  } finally {
    queryMock.mock.restore();
  }
});

test("deleteProduct returns 404 when product does not exist", async () => {
  const queryMock = mock.method(pool, "query", async () => ({ rows: [] }));

  try {
    await assert.rejects(deleteProduct("999"), {
      message: "Product not found",
      statusCode: 404,
    });
    assert.equal(queryMock.mock.calls.length, 1);
  } finally {
    queryMock.mock.restore();
  }
});

test("deleteProduct maps foreign-key errors to HTTP 409", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    const error = new Error("Foreign key violation");
    error.code = "23503";
    throw error;
  });

  try {
    await assert.rejects(deleteProduct("1"), {
      message: "Cannot delete product because it has associated inventory, transaction history, or supplier records",
      statusCode: 409,
    });
    assert.equal(queryMock.mock.calls.length, 1);
  } finally {
    queryMock.mock.restore();
  }
});

test("deleteProduct rejects invalid product IDs without querying", async () => {
  const queryMock = mock.method(pool, "query", async () => ({ rows: [] }));

  try {
    for (const id of [0, -1, 1.5, "0", "abc", "9223372036854775808"]) {
      await assert.rejects(deleteProduct(id), { statusCode: 400 });
    }
    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});

test("deleteProduct propagates unexpected database errors", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    throw new Error("Database connection failed");
  });

  try {
    await assert.rejects(deleteProduct("1"), /Database connection failed/);
  } finally {
    queryMock.mock.restore();
  }
});

test("deleteProduct uses parameterized SQL", async () => {
  const queryMock = mock.method(pool, "query", async () => ({ rows: [{ id: "1" }] }));

  try {
    await deleteProduct("1");
    const [sql, params] = queryMock.mock.calls[0].arguments;
    assert.deepEqual(params, ["1"]);
    assert.match(sql, /WHERE id = \$1/i);
  } finally {
    queryMock.mock.restore();
  }
});

test("createProduct, updateProduct, and deleteProduct preserve null and primitive thrown values", async () => {
  const createClientMock = createProductClientMock(async (sql) => {
    if (sql.includes("INSERT INTO products")) {
      throw null;
    }
    if (sql.includes("ROLLBACK")) {
      throw new Error("Rollback failed");
    }
    return { rows: [] };
  });

  try {
    await assert.rejects(
      createProduct(validProductData),
      (err) => err === null,
    );
    assert.equal(createClientMock.wasReleased(), true);
  } finally {
    createClientMock.connectMock.mock.restore();
  }

  const updateClientMock = createProductClientMock(async (sql) => {
    if (sql.includes("SELECT")) {
      throw "primitive-update-error";
    }
    if (sql.includes("ROLLBACK")) {
      throw new Error("Rollback failed");
    }
    return { rows: [] };
  });

  try {
    await assert.rejects(
      updateProduct("1", { name: "Updated Laptop" }),
      (err) => err === "primitive-update-error",
    );
    assert.equal(updateClientMock.wasReleased(), true);
  } finally {
    updateClientMock.connectMock.mock.restore();
  }

  const deleteQueryMock = mock.method(pool, "query", async () => {
    throw null;
  });

  try {
    await assert.rejects(
      deleteProduct("1"),
      (err) => err === null,
    );
  } finally {
    deleteQueryMock.mock.restore();
  }
});

// --------------------------------------------------
// DATABASE CONFIGURATION AND TEST ISOLATION TESTS
// --------------------------------------------------

test("normalizeDatabaseIdentity parses valid connection strings into host, port, databaseName and key", () => {
  const identity = pool.normalizeDatabaseIdentity(
    "postgres://user:secret@db.example.com:5433/invenkai_test?sslmode=require",
  );

  assert.equal(identity.host, "db.example.com");
  assert.equal(identity.port, "5433");
  assert.equal(identity.databaseName, "invenkai_test");
  assert.equal(identity.key, "db.example.com:5433/invenkai_test");
});

test("normalizeDatabaseIdentity rejects missing or invalid connection strings without logging credentials", () => {
  assert.equal(pool.normalizeDatabaseIdentity(null), null);
  assert.equal(pool.normalizeDatabaseIdentity(undefined), null);

  assert.throws(
    () => pool.normalizeDatabaseIdentity("not-a-valid-url"),
    { message: "Invalid PostgreSQL connection string format" },
  );

  assert.throws(
    () => pool.normalizeDatabaseIdentity("postgres://user:secret@localhost:5432/"),
    { message: "PostgreSQL connection string must include a database name" },
  );
});

test("resolveDatabaseConfig enforces TEST_DATABASE_URL in test environment and prevents dev DB reuse", () => {
  assert.throws(
    () =>
      pool.resolveDatabaseConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgres://user:pass@localhost:5432/invenkai_dev",
      }),
    { message: "TEST_DATABASE_URL is required in the test environment" },
  );

  assert.throws(
    () =>
      pool.resolveDatabaseConfig({
        NODE_ENV: "test",
        TEST_DATABASE_URL: "postgres://user:pass@localhost:5432/invenkai_db",
        DATABASE_URL: "postgres://user:pass@localhost:5432/invenkai_db",
      }),
    {
      message:
        "TEST_DATABASE_URL must point to a different database from DATABASE_URL",
    },
  );

  const config = pool.resolveDatabaseConfig({
    NODE_ENV: "test",
    TEST_DATABASE_URL: "postgres://user:pass@localhost:5432/invenkai_test",
    DATABASE_URL: "postgres://user:pass@localhost:5432/invenkai_dev",
  });
  assert.equal(config.isTestEnvironment, true);
  assert.equal(config.expectedDatabaseName, "invenkai_test");

  const prodConfig = pool.resolveDatabaseConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://user:pass@localhost:5432/invenkai_prod",
  });
  assert.equal(prodConfig.isTestEnvironment, false);
  assert.equal(prodConfig.expectedDatabaseName, "invenkai_prod");
});

test("verifyDatabaseIdentity confirms connected database name and guards against mismatch", async () => {
  const fakePool = {
    expectedDatabaseName: "invenkai_test",
    devDatabaseName: "invenkai_dev",
    query: async () => ({ rows: [{ database_name: "invenkai_test" }] }),
  };

  const name = await pool.verifyDatabaseIdentity(fakePool);
  assert.equal(name, "invenkai_test");

  const mismatchPool = {
    expectedDatabaseName: "invenkai_test",
    devDatabaseName: "invenkai_dev",
    query: async () => ({ rows: [{ database_name: "wrong_db" }] }),
  };

  await assert.rejects(
    pool.verifyDatabaseIdentity(mismatchPool),
    /Database identity mismatch/,
  );

  const devLeakPool = {
    expectedDatabaseName: "invenkai_dev",
    targetIdentity: {
      host: "db.example.com",
      port: "5432",
      databaseName: "invenkai_dev",
    },
    devIdentity: {
      host: "db.example.com",
      port: "5432",
      databaseName: "invenkai_dev",
    },
    query: async () => ({ rows: [{ database_name: "invenkai_dev" }] }),
  };

  await assert.rejects(
    pool.verifyDatabaseIdentity(devLeakPool),
    /Refusing to run tests against the development database/,
  );

  const separateHostPool = {
    expectedDatabaseName: "neondb",
    targetIdentity: {
      host: "localhost",
      port: "5432",
      databaseName: "neondb",
    },
    devIdentity: {
      host: "ep-dev.neon.tech",
      port: "5432",
      databaseName: "neondb",
    },
    query: async () => ({ rows: [{ database_name: "neondb" }] }),
  };

  const separateHostName = await pool.verifyDatabaseIdentity(separateHostPool);
  assert.equal(separateHostName, "neondb");
});
