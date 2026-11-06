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

test("GET inventory rejects requests without a token", async () => {
  const response = await request(app).get("/api/inventory/1");

  assert.equal(response.status, 401);
});

test("PATCH inventory rejects customers", async () => {
  const token = createToken("customer");

  const response = await request(app)
    .patch("/api/inventory/1/decrease")
    .set("Authorization", `Bearer ${token}`)
    .send({ quantity: 1 });

  assert.equal(response.status, 403);
});

test("GET inventory rejects an invalid product ID", async () => {
  const token = createToken("customer");

  const response = await request(app)
    .get("/api/inventory/abc")
    .set("Authorization", `Bearer ${token}`);

  assert.equal(response.status, 400);
});

test("PATCH inventory rejects an invalid quantity", async () => {
  const token = createToken("inventory_manager");

  const response = await request(app)
    .patch("/api/inventory/1/decrease")
    .set("Authorization", `Bearer ${token}`)
    .send({ quantity: 0 });

  assert.equal(response.status, 400);
});

test("PATCH increase stock successfully for inventory manager", async () => {
  const token = createToken("inventory_manager");

  const queryMock = mock.method(pool, "query", async () => ({
    rowCount: 1,
    rows: [{ product_id: 1, quantity: 15, updated_at: new Date() }],
  }));

  try {
    const response = await request(app)
      .patch("/api/inventory/1/increase")
      .set("Authorization", `Bearer ${token}`)
      .send({ quantity: 5 });

    assert.equal(response.status, 200);
    assert.equal(response.body.message, "Stock increased successfully");
    assert.equal(response.body.inventory.quantity, 15);
    assert.equal(queryMock.mock.calls.length, 1);
  } finally {
    queryMock.mock.restore();
  }
});

test("PATCH increase stock successfully for admin", async () => {
  const token = createToken("admin");

  const queryMock = mock.method(pool, "query", async () => ({
    rowCount: 1,
    rows: [{ product_id: 1, quantity: 20, updated_at: new Date() }],
  }));

  try {
    const response = await request(app)
      .patch("/api/inventory/1/increase")
      .set("Authorization", `Bearer ${token}`)
      .send({ quantity: 5 });

    assert.equal(response.status, 200);
    assert.equal(response.body.inventory.quantity, 20);
  } finally {
    queryMock.mock.restore();
  }
});

test("PATCH increase stock rejects requests without a token", async () => {
  const response = await request(app)
    .patch("/api/inventory/1/increase")
    .send({ quantity: 5 });

  assert.equal(response.status, 401);
});

test("PATCH increase stock rejects customers", async () => {
  const token = createToken("customer");

  const response = await request(app)
    .patch("/api/inventory/1/increase")
    .set("Authorization", `Bearer ${token}`)
    .send({ quantity: 5 });

  assert.equal(response.status, 403);
});

test("PATCH increase stock rejects an invalid product ID", async () => {
  const token = createToken("inventory_manager");

  const response = await request(app)
    .patch("/api/inventory/abc/increase")
    .set("Authorization", `Bearer ${token}`)
    .send({ quantity: 5 });

  assert.equal(response.status, 400);
});

test("PATCH increase stock rejects invalid quantities", async () => {
  const token = createToken("inventory_manager");

  for (const quantity of [0, -5, 1.5, undefined]) {
    const response = await request(app)
      .patch("/api/inventory/1/increase")
      .set("Authorization", `Bearer ${token}`)
      .send(quantity === undefined ? {} : { quantity });

    assert.equal(response.status, 400);
  }
});

test("PATCH increase stock returns 404 when inventory does not exist", async () => {
  const token = createToken("inventory_manager");

  const queryMock = mock.method(pool, "query", async () => ({
    rowCount: 0,
    rows: [],
  }));

  try {
    const response = await request(app)
      .patch("/api/inventory/999/increase")
      .set("Authorization", `Bearer ${token}`)
      .send({ quantity: 5 });

    assert.equal(response.status, 404);
    assert.equal(response.body.message, "Product inventory not found");
  } finally {
    queryMock.mock.restore();
  }
});

test("PATCH increase stock returns 409 when stock limit is exceeded", async () => {
  const token = createToken("inventory_manager");
  let queryCount = 0;

  const queryMock = mock.method(pool, "query", async () => {
    queryCount++;

    if (queryCount === 1) {
      return { rowCount: 0, rows: [] };
    }

    return {
      rowCount: 1,
      rows: [{ product_id: 1 }],
    };
  });

  try {
    const response = await request(app)
      .patch("/api/inventory/1/increase")
      .set("Authorization", `Bearer ${token}`)
      .send({ quantity: 5 });

    assert.equal(response.status, 409);
    assert.equal(response.body.message, "Stock quantity limit exceeded");

    assert.equal(queryMock.mock.calls.length, 2);
  } finally {
    queryMock.mock.restore();
  }
});

test("PATCH increase stock handles database errors", async () => {
  const token = createToken("inventory_manager");

  const queryMock = mock.method(pool, "query", async () => {
    throw new Error("Database connection failed");
  });

  try {
    const response = await request(app)
      .patch("/api/inventory/1/increase")
      .set("Authorization", `Bearer ${token}`)
      .send({ quantity: 5 });

    assert.equal(response.status, 500);
    assert.equal(response.body.message, "Failed to increase stock");
  } finally {
    queryMock.mock.restore();
  }
});