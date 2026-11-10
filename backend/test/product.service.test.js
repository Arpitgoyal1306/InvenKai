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
// CREATE PRODUCT TESTS
// --------------------------------------------------

test("createProduct creates a product successfully", async () => {
  const mockProduct = {
    id: "1",
    category_id: "2",
    name: "Laptop",
    description: "Gaming laptop",
    sku: "LAP-001",
    price: "75000.00",
  };

  const queryMock = mock.method(pool, "query", async () => ({
    rows: [mockProduct],
  }));

  try {
    const product = await createProduct({
      category_id: 2,
      name: " Laptop ",
      description: " Gaming laptop ",
      sku: " LAP-001 ",
      price: 75000,
    });

    assert.deepEqual(product, mockProduct);
    assert.equal(queryMock.mock.calls.length, 1);

    assert.deepEqual(queryMock.mock.calls[0].arguments[1], [
      2,
      "Laptop",
      "Gaming laptop",
      "LAP-001",
      75000,
    ]);

    assert.match(queryMock.mock.calls[0].arguments[0], /INSERT INTO products/i);

    assert.match(queryMock.mock.calls[0].arguments[0], /RETURNING \*/i);
  } finally {
    queryMock.mock.restore();
  }
});

test("createProduct accepts a null description", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [{ id: "1" }],
  }));

  try {
    await createProduct({
      category_id: 2,
      name: "Laptop",
      sku: "LAP-001",
      price: 75000,
    });

    assert.equal(queryMock.mock.calls[0].arguments[1][2], null);
  } finally {
    queryMock.mock.restore();
  }
});

test("createProduct rejects missing or invalid required fields", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried");
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

    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});

test("createProduct rejects invalid category IDs", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    for (const categoryId of [0, -1, 1.5, "0", "abc", "9223372036854775808"]) {
      await assert.rejects(
        createProduct({
          category_id: categoryId,
          name: "Laptop",
          sku: "LAP-001",
          price: 75000,
        }),
        { statusCode: 400 },
      );
    }

    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});

test("createProduct rejects invalid product names", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    for (const name of ["", "   ", 123, "A".repeat(201)]) {
      await assert.rejects(
        createProduct({
          category_id: 2,
          name,
          sku: "LAP-001",
          price: 75000,
        }),
        { statusCode: 400 },
      );
    }

    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});

test("createProduct rejects invalid SKUs", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    for (const sku of ["", "   ", 123, "A".repeat(101)]) {
      await assert.rejects(
        createProduct({
          category_id: 2,
          name: "Laptop",
          sku,
          price: 75000,
        }),
        { statusCode: 400 },
      );
    }

    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});

test("createProduct rejects invalid prices", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    for (const price of [-1, 1.234, 100000000, "75000", NaN, Infinity]) {
      await assert.rejects(
        createProduct({
          category_id: 2,
          name: "Laptop",
          sku: "LAP-001",
          price,
        }),
        { statusCode: 400 },
      );
    }

    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});

test("createProduct rejects unknown fields", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    await assert.rejects(
      createProduct({
        category_id: 2,
        name: "Laptop",
        sku: "LAP-001",
        price: 75000,
        stock: 100,
      }),
      { statusCode: 400 },
    );

    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});

test("createProduct maps duplicate SKU errors to HTTP 409", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    const error = new Error("Duplicate SKU");
    error.code = "23505";
    throw error;
  });

  try {
    await assert.rejects(
      createProduct({
        category_id: 2,
        name: "Laptop",
        sku: "LAP-001",
        price: 75000,
      }),
      {
        message: "A product with this SKU already exists",
        statusCode: 409,
      },
    );
  } finally {
    queryMock.mock.restore();
  }
});

test("createProduct maps invalid category foreign-key errors to HTTP 400", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    const error = new Error("Foreign key violation");
    error.code = "23503";
    throw error;
  });

  try {
    await assert.rejects(
      createProduct({
        category_id: 999,
        name: "Laptop",
        sku: "LAP-001",
        price: 75000,
      }),
      {
        message: "The specified category does not exist",
        statusCode: 400,
      },
    );
  } finally {
    queryMock.mock.restore();
  }
});

test("createProduct propagates unexpected database errors", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    throw new Error("Database connection failed");
  });

  try {
    await assert.rejects(
      createProduct({
        category_id: 2,
        name: "Laptop",
        sku: "LAP-001",
        price: 75000,
      }),
      /Database connection failed/,
    );
  } finally {
    queryMock.mock.restore();
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

  const queryMock = mock.method(pool, "query", async () => ({
    rows: mockProducts,
  }));

  try {
    const products = await getProducts(10, 20);

    assert.deepEqual(products, mockProducts);
    assert.equal(queryMock.mock.calls.length, 1);

    assert.deepEqual(queryMock.mock.calls[0].arguments[1], [10, 20]);

    assert.match(queryMock.mock.calls[0].arguments[0], /ORDER BY id/i);
    assert.match(queryMock.mock.calls[0].arguments[0], /LIMIT \$1/i);
    assert.match(queryMock.mock.calls[0].arguments[0], /OFFSET \$2/i);
  } finally {
    queryMock.mock.restore();
  }
});

test("getProducts uses default pagination", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    await getProducts();

    assert.deepEqual(queryMock.mock.calls[0].arguments[1], [10, 0]);
  } finally {
    queryMock.mock.restore();
  }
});

test("getProducts rejects invalid pagination values", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    for (const [limit, offset] of [
      [-1, 0],
      [0, 0],
      [101, 0],
      [1.5, 0],
      [10, -1],
      [10, 1.5],
    ]) {
      await assert.rejects(getProducts(limit, offset), {
        statusCode: 400,
      });
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

  const queryMock = mock.method(pool, "query", async () => ({
    rows: [mockProduct],
  }));

  try {
    const product = await getProductById("1");

    assert.deepEqual(product, mockProduct);
    assert.equal(queryMock.mock.calls.length, 1);
    assert.deepEqual(queryMock.mock.calls[0].arguments[1], ["1"]);

    assert.match(queryMock.mock.calls[0].arguments[0], /WHERE id = \$1/i);
  } finally {
    queryMock.mock.restore();
  }
});

test("getProductById returns null when product does not exist", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    const product = await getProductById("999");

    assert.equal(product, null);
    assert.equal(queryMock.mock.calls.length, 1);
  } finally {
    queryMock.mock.restore();
  }
});

test("getProductById rejects invalid product IDs without querying", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    for (const id of [0, -1, 1.5, "0", "abc", "9223372036854775808"]) {
      await assert.rejects(getProductById(id), {
        statusCode: 400,
      });
    }

    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});

// --------------------------------------------------
// UPDATE PRODUCT TEST HELPERS
// --------------------------------------------------

function createProductClientMock(queryHandler) {
  const queries = [];
  let released = false;

  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return queryHandler(sql, params);
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
  const updatedProduct = {
    ...existingProduct,
    name: "Gaming Laptop",
  };

  const clientMock = createProductClientMock(async (sql) => {
    if (/SELECT/i.test(sql)) {
      return { rows: [existingProduct] };
    }

    if (/UPDATE products/i.test(sql)) {
      return { rows: [updatedProduct] };
    }

    return { rows: [] };
  });

  try {
    const result = await updateProduct("1", {
      name: "Gaming Laptop",
    });

    assert.deepEqual(result, updatedProduct);
    assert.equal(clientMock.queries.length, 4);

    assert.match(clientMock.queries[0].sql, /BEGIN/i);
    assert.match(clientMock.queries[1].sql, /SELECT/i);
    assert.match(clientMock.queries[1].sql, /FOR UPDATE/i);
    assert.match(clientMock.queries[2].sql, /UPDATE products/i);
    assert.match(clientMock.queries[3].sql, /COMMIT/i);

    assert.deepEqual(clientMock.queries[2].params, [
      "2",
      "Gaming Laptop",
      "Gaming laptop",
      "LAP-001",
      75000,
      "1",
    ]);

    assert.equal(clientMock.wasReleased(), true);
  } finally {
    clientMock.connectMock.mock.restore();
  }
});

test("updateProduct preserves existing values during partial updates", async () => {
  const updatedProduct = {
    ...existingProduct,
    price: "80000.00",
  };

  const clientMock = createProductClientMock(async (sql) => {
    if (/SELECT/i.test(sql)) {
      return { rows: [existingProduct] };
    }

    if (/UPDATE products/i.test(sql)) {
      return { rows: [updatedProduct] };
    }

    return { rows: [] };
  });

  try {
    const result = await updateProduct("1", { price: 80000 });

    assert.deepEqual(result, updatedProduct);

    assert.deepEqual(clientMock.queries[2].params, [
      "2",
      "Laptop",
      "Gaming laptop",
      "LAP-001",
      80000,
      "1",
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
    await assert.rejects(updateProduct("1", {}), {
      statusCode: 400,
    });

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
    await assert.rejects(updateProduct("0", { name: "New name" }), {
      statusCode: 400,
    });

    await assert.rejects(
      updateProduct("9223372036854775808", {
        name: "New name",
      }),
      { statusCode: 400 },
    );

    await assert.rejects(
      updateProduct("1", {
        stock: 100,
      }),
      { statusCode: 400 },
    );

    assert.equal(connectMock.mock.calls.length, 0);
  } finally {
    connectMock.mock.restore();
  }
});

test("updateProduct returns 404 when product does not exist", async () => {
  const clientMock = createProductClientMock(async () => ({
    rows: [],
  }));

  try {
    await assert.rejects(updateProduct("999", { name: "New name" }), {
      message: "Product not found",
      statusCode: 404,
    });

    assert.match(clientMock.queries[0].sql, /BEGIN/i);
    assert.match(clientMock.queries[1].sql, /SELECT/i);
    assert.match(clientMock.queries[2].sql, /ROLLBACK/i);

    assert.equal(clientMock.wasReleased(), true);
  } finally {
    clientMock.connectMock.mock.restore();
  }
});

test("updateProduct rolls back when merged product data is invalid", async () => {
  const invalidExistingProduct = {
    ...existingProduct,
    name: "   ",
  };

  const clientMock = createProductClientMock(async (sql) => {
    if (/SELECT/i.test(sql)) {
      return { rows: [invalidExistingProduct] };
    }

    return { rows: [] };
  });

  try {
    await assert.rejects(
      updateProduct("1", {
        description: "Updated description",
      }),
      { statusCode: 400 },
    );

    assert.equal(
      clientMock.queries.some(({ sql }) => /UPDATE products/i.test(sql)),
      false,
    );

    assert.match(clientMock.queries.at(-1).sql, /ROLLBACK/i);
    assert.equal(clientMock.wasReleased(), true);
  } finally {
    clientMock.connectMock.mock.restore();
  }
});

test("updateProduct maps duplicate SKU errors to HTTP 409", async () => {
  const clientMock = createProductClientMock(async (sql) => {
    if (/SELECT/i.test(sql)) {
      return { rows: [existingProduct] };
    }

    if (/UPDATE products/i.test(sql)) {
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
    if (/SELECT/i.test(sql)) {
      return { rows: [existingProduct] };
    }

    if (/UPDATE products/i.test(sql)) {
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
  const deletedProduct = {
    id: "1",
    category_id: "2",
    name: "Laptop",
    description: "Gaming laptop",
    sku: "LAP-001",
    price: "75000.00",
  };

  const queryMock = mock.method(pool, "query", async () => ({
    rows: [deletedProduct],
  }));

  try {
    const result = await deleteProduct("1");

    assert.deepEqual(result, deletedProduct);
    assert.equal(queryMock.mock.calls.length, 1);

    assert.deepEqual(queryMock.mock.calls[0].arguments[1], ["1"]);

    assert.match(
      queryMock.mock.calls[0].arguments[0],
      /DELETE FROM products/i,
    );

    assert.match(
      queryMock.mock.calls[0].arguments[0],
      /WHERE id = \$1/i,
    );

    assert.match(
      queryMock.mock.calls[0].arguments[0],
      /RETURNING \*/i,
    );
  } finally {
    queryMock.mock.restore();
  }
});

test("deleteProduct returns 404 when product does not exist", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

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
      message:
        "Cannot delete product because it has associated inventory, transaction history, or supplier records",
      statusCode: 409,
    });

    assert.equal(queryMock.mock.calls.length, 1);
  } finally {
    queryMock.mock.restore();
  }
});

test("deleteProduct rejects invalid product IDs without querying", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    for (const id of [
      0,
      -1,
      1.5,
      "0",
      "abc",
      "9223372036854775808",
    ]) {
      await assert.rejects(deleteProduct(id), {
        statusCode: 400,
      });
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
    await assert.rejects(
      deleteProduct("1"),
      /Database connection failed/,
    );
  } finally {
    queryMock.mock.restore();
  }
});

test("deleteProduct uses parameterized SQL", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [{ id: "1" }],
  }));

  try {
    await deleteProduct("1");

    const [sql, params] = queryMock.mock.calls[0].arguments;

    assert.deepEqual(params, ["1"]);
    assert.match(sql, /WHERE id = \$1/i);
  } finally {
    queryMock.mock.restore();
  }
});
