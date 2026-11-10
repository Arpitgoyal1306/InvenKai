const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const pool = require("../src/config/database");
const app = require("../src/app");

function createToken(role) {
  return jwt.sign(
    {
      sub: "1",
      role,
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );
}

const product = {
  id: "1",
  category_id: "2",
  name: "Laptop",
  description: "Gaming laptop",
  sku: "LAP-001",
  price: "75000.00",
};

// --------------------------------------------------
// AUTHENTICATION AND AUTHORIZATION
// --------------------------------------------------

test("GET products rejects requests without a token", async () => {
  const response = await request(app).get("/api/products");
  assert.equal(response.status, 401);
});

test("POST products rejects requests without a token", async () => {
  const response = await request(app).post("/api/products").send(product);

  assert.equal(response.status, 401);
});

test("POST products rejects customers", async () => {
  const response = await request(app)
    .post("/api/products")
    .set("Authorization", `Bearer ${createToken("customer")}`)
    .send(product);

  assert.equal(response.status, 403);
});

test("PATCH products rejects customers", async () => {
  const response = await request(app)
    .patch("/api/products/1")
    .set("Authorization", `Bearer ${createToken("customer")}`)
    .send({ name: "Updated Laptop" });

  assert.equal(response.status, 403);
});

test("DELETE products rejects inventory managers", async () => {
  const response = await request(app)
    .delete("/api/products/1")
    .set("Authorization", `Bearer ${createToken("inventory_manager")}`);

  assert.equal(response.status, 403);
});

test("DELETE products rejects requests without a token", async () => {
  const response = await request(app).delete("/api/products/1");
  assert.equal(response.status, 401);
});

// --------------------------------------------------
// CREATE PRODUCT
// --------------------------------------------------

test("POST products creates a product for inventory manager", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [product],
  }));

  try {
    const response = await request(app)
      .post("/api/products")
      .set("Authorization", `Bearer ${createToken("inventory_manager")}`)
      .send({
        category_id: 2,
        name: "Laptop",
        description: "Gaming laptop",
        sku: "LAP-001",
        price: 75000,
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.message, "Product created successfully");
    assert.deepEqual(response.body.product, product);
    assert.equal(queryMock.mock.calls.length, 1);
  } finally {
    queryMock.mock.restore();
  }
});

test("POST products creates a product for admin", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [product],
  }));

  try {
    const response = await request(app)
      .post("/api/products")
      .set("Authorization", `Bearer ${createToken("admin")}`)
      .send({
        category_id: 2,
        name: "Laptop",
        sku: "LAP-001",
        price: 75000,
      });

    assert.equal(response.status, 201);
  } finally {
    queryMock.mock.restore();
  }
});

test("POST products rejects invalid product data", async () => {
  const response = await request(app)
    .post("/api/products")
    .set("Authorization", `Bearer ${createToken("inventory_manager")}`)
    .send({
      category_id: 2,
      name: " ",
      sku: "LAP-001",
      price: 75000,
    });

  assert.equal(response.status, 400);
});

test("POST products returns 409 for duplicate SKU", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    const error = new Error("Duplicate SKU");
    error.code = "23505";
    throw error;
  });

  try {
    const response = await request(app)
      .post("/api/products")
      .set("Authorization", `Bearer ${createToken("admin")}`)
      .send({
        category_id: 2,
        name: "Laptop",
        sku: "LAP-001",
        price: 75000,
      });

    assert.equal(response.status, 409);
  } finally {
    queryMock.mock.restore();
  }
});

// --------------------------------------------------
// GET ALL PRODUCTS
// --------------------------------------------------

test("GET products returns products with pagination", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [product],
  }));

  try {
    const response = await request(app)
      .get("/api/products?limit=10&offset=0")
      .set("Authorization", `Bearer ${createToken("customer")}`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.products, [product]);
    assert.deepEqual(response.body.pagination, {
      limit: 10,
      offset: 0,
    });
  } finally {
    queryMock.mock.restore();
  }
});

test("GET products uses default pagination", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    const response = await request(app)
      .get("/api/products")
      .set("Authorization", `Bearer ${createToken("customer")}`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.pagination, {
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(queryMock.mock.calls[0].arguments[1], [10, 0]);
  } finally {
    queryMock.mock.restore();
  }
});

test("GET products rejects invalid pagination", async () => {
  const token = createToken("customer");

  for (const query of [
    "?limit=0",
    "?limit=-1",
    "?limit=101",
    "?limit=1.5",
    "?offset=-1",
  ]) {
    const response = await request(app)
      .get(`/api/products${query}`)
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 400);
  }
});

// --------------------------------------------------
// GET PRODUCT BY ID
// --------------------------------------------------

test("GET product by ID returns a product", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [product],
  }));

  try {
    const response = await request(app)
      .get("/api/products/1")
      .set("Authorization", `Bearer ${createToken("customer")}`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.product, product);
    assert.deepEqual(queryMock.mock.calls[0].arguments[1], ["1"]);
  } finally {
    queryMock.mock.restore();
  }
});

test("GET product by ID supports PostgreSQL BIGINT IDs", async () => {
  const largeId = "9223372036854775807";

  const queryMock = mock.method(pool, "query", async () => ({
    rows: [{ ...product, id: largeId }],
  }));

  try {
    const response = await request(app)
      .get(`/api/products/${largeId}`)
      .set("Authorization", `Bearer ${createToken("customer")}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.product.id, largeId);
    assert.deepEqual(queryMock.mock.calls[0].arguments[1], [largeId]);
  } finally {
    queryMock.mock.restore();
  }
});

test("GET product by ID rejects invalid IDs", async () => {
  const token = createToken("customer");

  for (const id of ["abc", "0", "-1", "1.5", "9223372036854775808"]) {
    const response = await request(app)
      .get(`/api/products/${id}`)
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 400);
  }
});

test("GET product by ID returns 404 when product does not exist", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    const response = await request(app)
      .get("/api/products/999")
      .set("Authorization", `Bearer ${createToken("customer")}`);

    assert.equal(response.status, 404);
    assert.equal(response.body.message, "Product not found");
  } finally {
    queryMock.mock.restore();
  }
});

// --------------------------------------------------
// UPDATE PRODUCT
// --------------------------------------------------

test("PATCH products updates a product for inventory manager", async () => {
  const updatedProduct = {
    ...product,
    name: "Gaming Laptop",
  };

  const client = {
    query: async (sql) => {
      if (/SELECT/i.test(sql)) {
        return { rows: [product] };
      }

      if (/UPDATE products/i.test(sql)) {
        return { rows: [updatedProduct] };
      }

      return { rows: [] };
    },
    release: () => {},
  };

  const connectMock = mock.method(pool, "connect", async () => client);

  try {
    const response = await request(app)
      .patch("/api/products/1")
      .set("Authorization", `Bearer ${createToken("inventory_manager")}`)
      .send({ name: "Gaming Laptop" });

    assert.equal(response.status, 200);
    assert.equal(response.body.message, "Product updated successfully");
    assert.deepEqual(response.body.product, updatedProduct);
  } finally {
    connectMock.mock.restore();
  }
});

test("PATCH products rejects empty updates", async () => {
  const response = await request(app)
    .patch("/api/products/1")
    .set("Authorization", `Bearer ${createToken("inventory_manager")}`)
    .send({});

  assert.equal(response.status, 400);
});

test("PATCH products returns 404 when product does not exist", async () => {
  const client = {
    query: async () => ({ rows: [] }),
    release: () => {},
  };

  const connectMock = mock.method(pool, "connect", async () => client);

  try {
    const response = await request(app)
      .patch("/api/products/999")
      .set("Authorization", `Bearer ${createToken("admin")}`)
      .send({ name: "Updated Laptop" });

    assert.equal(response.status, 404);
    assert.equal(response.body.message, "Product not found");
  } finally {
    connectMock.mock.restore();
  }
});

test("PATCH products returns 409 for duplicate SKU", async () => {
  const client = {
    query: async (sql) => {
      if (/SELECT/i.test(sql)) {
        return { rows: [product] };
      }

      if (/UPDATE products/i.test(sql)) {
        const error = new Error("Duplicate SKU");
        error.code = "23505";
        throw error;
      }

      return { rows: [] };
    },
    release: () => {},
  };

  const connectMock = mock.method(pool, "connect", async () => client);

  try {
    const response = await request(app)
      .patch("/api/products/1")
      .set("Authorization", `Bearer ${createToken("admin")}`)
      .send({ sku: "EXISTING-SKU" });

    assert.equal(response.status, 409);
  } finally {
    connectMock.mock.restore();
  }
});

// --------------------------------------------------
// DELETE PRODUCT
// --------------------------------------------------

test("DELETE products deletes a product for admin", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [product],
  }));

  try {
    const response = await request(app)
      .delete("/api/products/1")
      .set("Authorization", `Bearer ${createToken("admin")}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.message, "Product deleted successfully");
    assert.deepEqual(response.body.product, product);
  } finally {
    queryMock.mock.restore();
  }
});

test("DELETE products returns 404 when product does not exist", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    const response = await request(app)
      .delete("/api/products/999")
      .set("Authorization", `Bearer ${createToken("admin")}`);

    assert.equal(response.status, 404);
    assert.equal(response.body.message, "Product not found");
  } finally {
    queryMock.mock.restore();
  }
});

test("DELETE products returns 409 when product has dependent records", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    const error = new Error("Foreign key violation");
    error.code = "23503";
    throw error;
  });

  try {
    const response = await request(app)
      .delete("/api/products/1")
      .set("Authorization", `Bearer ${createToken("admin")}`);

    assert.equal(response.status, 409);
  } finally {
    queryMock.mock.restore();
  }
});
