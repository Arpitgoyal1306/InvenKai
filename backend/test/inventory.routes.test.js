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

function mockTransactionClient(queryHandler) {
  const calls = [];

  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return queryHandler(sql, values, calls);
    },
    release: mock.fn(),
  };

  const connectMock = mock.method(pool, "connect", async () => client);

  return { client, calls, connectMock };
}

// ---------------- AUTHENTICATION ----------------

test("GET inventory rejects requests without a token", async () => {
  const response = await request(app).get("/api/inventory/1");

  assert.equal(response.status, 401);
});

test("GET inventory history rejects requests without a token", async () => {
  const response = await request(app).get("/api/inventory/history");

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

// ---------------- INCREASE STOCK ----------------

test("PATCH increase stock successfully for inventory manager", async () => {
  const token = createToken("inventory_manager");

  const { calls, connectMock, client } = mockTransactionClient(async (sql) => {
    if (sql.includes("SELECT product_id, quantity")) {
      return {
        rowCount: 1,
        rows: [{ product_id: 1, quantity: 10 }],
      };
    }

    if (sql.includes("UPDATE inventory")) {
      return {
        rowCount: 1,
        rows: [{ product_id: 1, quantity: 15 }],
      };
    }

    return { rowCount: 1, rows: [] };
  });

  try {
    const response = await request(app)
      .patch("/api/inventory/1/increase")
      .set("Authorization", `Bearer ${token}`)
      .send({ quantity: 5 });

    assert.equal(response.status, 200);
    assert.equal(response.body.message, "Stock increased successfully");
    assert.equal(response.body.inventory.quantity, 15);

    assert.equal(calls.length, 5);
    assert.equal(
      calls[3].sql.includes("INSERT INTO inventory_transactions"),
      true,
    );
    assert.equal(calls[3].values[1], "1");
    assert.equal(calls[3].values[2], "increase");

    assert.equal(client.release.mock.callCount(), 1);
  } finally {
    connectMock.mock.restore();
  }
});

test("PATCH increase stock successfully for admin", async () => {
  const token = createToken("admin");

  const { connectMock } = mockTransactionClient(async (sql) => {
    if (sql.includes("SELECT product_id, quantity")) {
      return {
        rowCount: 1,
        rows: [{ product_id: 1, quantity: 15 }],
      };
    }

    if (sql.includes("UPDATE inventory")) {
      return {
        rowCount: 1,
        rows: [{ product_id: 1, quantity: 20 }],
      };
    }

    return { rowCount: 1, rows: [] };
  });

  try {
    const response = await request(app)
      .patch("/api/inventory/1/increase")
      .set("Authorization", `Bearer ${token}`)
      .send({ quantity: 5 });

    assert.equal(response.status, 200);
    assert.equal(response.body.inventory.quantity, 20);
  } finally {
    connectMock.mock.restore();
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

  const { connectMock } = mockTransactionClient(async () => ({
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
    connectMock.mock.restore();
  }
});

test("PATCH increase stock returns 409 when stock limit is exceeded", async () => {
  const token = createToken("inventory_manager");

  const { connectMock } = mockTransactionClient(async (sql) => {
    if (sql.includes("SELECT product_id, quantity")) {
      return {
        rowCount: 1,
        rows: [{ product_id: 1, quantity: 2147483640 }],
      };
    }

    return { rowCount: 1, rows: [] };
  });

  try {
    const response = await request(app)
      .patch("/api/inventory/1/increase")
      .set("Authorization", `Bearer ${token}`)
      .send({ quantity: 10 });

    assert.equal(response.status, 409);
    assert.equal(response.body.message, "Stock quantity limit exceeded");
  } finally {
    connectMock.mock.restore();
  }
});

test("PATCH increase stock handles database errors", async () => {
  const token = createToken("inventory_manager");

  const connectMock = mock.method(pool, "connect", async () => {
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
    connectMock.mock.restore();
  }
});

// ---------------- DECREASE STOCK ----------------

test("PATCH decrease stock successfully records history", async () => {
  const token = createToken("inventory_manager");

  const { calls, connectMock } = mockTransactionClient(async (sql) => {
    if (sql.includes("SELECT product_id, quantity")) {
      return {
        rowCount: 1,
        rows: [{ product_id: 1, quantity: 10 }],
      };
    }

    if (sql.includes("UPDATE inventory")) {
      return {
        rowCount: 1,
        rows: [{ product_id: 1, quantity: 7 }],
      };
    }

    return { rowCount: 1, rows: [] };
  });

  try {
    const response = await request(app)
      .patch("/api/inventory/1/decrease")
      .set("Authorization", `Bearer ${token}`)
      .send({ quantity: 3 });

    assert.equal(response.status, 200);
    assert.equal(response.body.message, "Stock decreased successfully");
    assert.equal(response.body.inventory.quantity, 7);

    assert.equal(
      calls[3].sql.includes("INSERT INTO inventory_transactions"),
      true,
    );
    assert.equal(calls[3].values[2], "decrease");
  } finally {
    connectMock.mock.restore();
  }
});

test("PATCH decrease stock returns 409 when stock is insufficient", async () => {
  const token = createToken("inventory_manager");

  const { connectMock } = mockTransactionClient(async (sql) => {
    if (sql.includes("SELECT product_id, quantity")) {
      return {
        rowCount: 1,
        rows: [{ product_id: 1, quantity: 2 }],
      };
    }

    return { rowCount: 1, rows: [] };
  });

  try {
    const response = await request(app)
      .patch("/api/inventory/1/decrease")
      .set("Authorization", `Bearer ${token}`)
      .send({ quantity: 5 });

    assert.equal(response.status, 409);
    assert.equal(
      response.body.message,
      "Product inventory not found or insufficient stock",
    );
  } finally {
    connectMock.mock.restore();
  }
});

// ---------------- INVENTORY HISTORY ----------------

test("GET inventory history returns transactions", async () => {
  const token = createToken("customer");

  const transactions = [
    {
      id: "1",
      product_id: "1",
      performed_by: "1",
      transaction_type: "increase",
      quantity: 5,
      quantity_before: 10,
      quantity_after: 15,
    },
  ];

  const queryMock = mock.method(pool, "query", async () => ({
    rows: transactions,
  }));

  try {
    const response = await request(app)
      .get("/api/inventory/history")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.transactions, transactions);
    assert.deepEqual(response.body.pagination, {
      limit: 20,
      offset: 0,
    });
  } finally {
    queryMock.mock.restore();
  }
});

test("GET inventory history supports product filtering and pagination", async () => {
  const token = createToken("inventory_manager");

  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    const response = await request(app)
      .get("/api/inventory/history?productId=1&limit=10&offset=20")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.pagination, {
      limit: 10,
      offset: 20,
    });

    assert.deepEqual(queryMock.mock.calls[0].arguments[1], [1, 10, 20]);
  } finally {
    queryMock.mock.restore();
  }
});

test("GET inventory history rejects invalid query parameters", async () => {
  const token = createToken("inventory_manager");

  const invalidQueries = [
    "?productId=abc",
    "?productId=0",
    "?limit=0",
    "?limit=101",
    "?offset=-1",
    "?limit=1.5",
  ];

  for (const query of invalidQueries) {
    const response = await request(app)
      .get(`/api/inventory/history${query}`)
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 400);
  }
});

test("GET inventory history handles database errors", async () => {
  const token = createToken("inventory_manager");

  const queryMock = mock.method(pool, "query", async () => {
    throw new Error("Dadtabase connection failed");
  });

  try {
    const response = await request(app)
      .get("/api/inventory/history")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 500);
    assert.equal(response.body.message, "Failed to fetch inventory history");
  } finally {
    queryMock.mock.restore();
  }
});

test("PATCH increase stock rejects quantity above PostgreSQL INTEGER limit", async () => {
  const token = createToken("inventory_manager");

  const response = await request(app)
    .patch("/api/inventory/1/increase")
    .set("Authorization", `Bearer ${token}`)
    .send({ quantity: 2147483648 });

  assert.equal(response.status, 400);
});

test("PATCH decrease stock rejects quantity above PostgreSQL INTEGER limit", async () => {
  const token = createToken("inventory_manager");

  const response = await request(app)
    .patch("/api/inventory/1/decrease")
    .set("Authorization", `Bearer ${token}`)
    .send({ quantity: 2147483648 });

  assert.equal(response.status, 400);
});