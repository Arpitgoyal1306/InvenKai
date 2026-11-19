const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const app = require("../src/app");
const orderService = require("../src/services/order.service");

function createToken(userId = "42", role = "customer") {
  return jwt.sign(
    {
      sub: userId,
      role,
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );
}

const sampleItems = [
  {
    productId: "12",
    quantity: 2,
  },
];

const sampleOrder = {
  id: "77",
  user_id: "42",
  status: "placed",
  total_amount: "30.00",
  items: [
    {
      id: "101",
      product_id: "12",
      product_name: "Integration Test Product",
      sku: "TEST-001",
      unit_price: "15.00",
      quantity: 2,
      line_total: "30.00",
    },
  ],
};

// --------------------------------------------------
// AUTHENTICATION
// --------------------------------------------------

test("POST orders rejects requests without a token", async () => {
  const response = await request(app)
    .post("/api/orders")
    .send({ items: sampleItems });

  assert.equal(response.status, 401);
});

test("GET orders rejects requests without a token", async () => {
  const response = await request(app).get("/api/orders");

  assert.equal(response.status, 401);
});

test("GET order by ID rejects requests without a token", async () => {
  const response = await request(app).get("/api/orders/77");

  assert.equal(response.status, 401);
});

// --------------------------------------------------
// CREATE ORDER
// --------------------------------------------------

test("POST orders creates an order for an authenticated customer", async () => {
  const createMock = mock.method(
    orderService,
    "createOrder",
    async () => sampleOrder,
  );

  try {
    const response = await request(app)
      .post("/api/orders")
      .set("Authorization", `Bearer ${createToken("42", "customer")}`)
      .send({
        items: sampleItems,
        userId: "999",
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.message, "Order created successfully");
    assert.deepEqual(response.body.order, sampleOrder);

    // User ID must come from the JWT, not the request body.
    assert.deepEqual(createMock.mock.calls[0].arguments, ["42", sampleItems]);

    assert.equal(createMock.mock.calls.length, 1);
  } finally {
    createMock.mock.restore();
  }
});

test("POST orders creates an order for an authenticated admin", async () => {
  const createMock = mock.method(
    orderService,
    "createOrder",
    async () => sampleOrder,
  );

  try {
    const response = await request(app)
      .post("/api/orders")
      .set("Authorization", `Bearer ${createToken("42", "admin")}`)
      .send({ items: sampleItems });

    assert.equal(response.status, 201);
    assert.equal(response.body.message, "Order created successfully");
    assert.deepEqual(response.body.order, sampleOrder);

    assert.deepEqual(createMock.mock.calls[0].arguments, ["42", sampleItems]);

    assert.equal(createMock.mock.calls.length, 1);
  } finally {
    createMock.mock.restore();
  }
});

test("POST orders rejects an inventory manager with 403", async () => {
  const createMock = mock.method(
    orderService,
    "createOrder",
    async () => sampleOrder,
  );

  try {
    const response = await request(app)
      .post("/api/orders")
      .set("Authorization", `Bearer ${createToken("42", "inventory_manager")}`)
      .send({ items: sampleItems });

    assert.equal(response.status, 403);

    // Unauthorized users must never reach the order service.
    assert.equal(createMock.mock.calls.length, 0);
  } finally {
    createMock.mock.restore();
  }
});

test("POST orders passes missing items to service validation", async () => {
  const createMock = mock.method(orderService, "createOrder", async () => {
    const error = new Error("Order items must be a non-empty array");
    error.statusCode = 400;
    throw error;
  });

  try {
    const response = await request(app)
      .post("/api/orders")
      .set("Authorization", `Bearer ${createToken()}`)
      .send({});

    assert.equal(response.status, 400);
    assert.equal(
      response.body.message,
      "Order items must be a non-empty array",
    );

    assert.deepEqual(createMock.mock.calls[0].arguments, ["42", undefined]);
  } finally {
    createMock.mock.restore();
  }
});

test("POST orders returns 409 when inventory is insufficient", async () => {
  const createMock = mock.method(orderService, "createOrder", async () => {
    const error = new Error("Insufficient stock");
    error.statusCode = 409;
    throw error;
  });

  try {
    const response = await request(app)
      .post("/api/orders")
      .set("Authorization", `Bearer ${createToken()}`)
      .send({ items: sampleItems });

    assert.equal(response.status, 409);
    assert.equal(response.body.message, "Insufficient stock");
  } finally {
    createMock.mock.restore();
  }
});

test("POST orders handles unexpected service errors", async () => {
  const createMock = mock.method(orderService, "createOrder", async () => {
    throw new Error("Database connection failed");
  });

  try {
    const response = await request(app)
      .post("/api/orders")
      .set("Authorization", `Bearer ${createToken()}`)
      .send({ items: sampleItems });

    assert.equal(response.status, 500);
    assert.equal(response.body.message, "Failed to create order");
  } finally {
    createMock.mock.restore();
  }
});

// --------------------------------------------------
// GET ORDER HISTORY
// --------------------------------------------------

test("GET orders returns the authenticated user's orders", async () => {
  const result = {
    orders: [sampleOrder],
    pagination: {
      page: 2,
      limit: 5,
      total: 1,
      totalPages: 1,
    },
  };

  const historyMock = mock.method(
    orderService,
    "getUserOrders",
    async () => result,
  );

  try {
    const response = await request(app)
      .get("/api/orders?page=2&limit=5&userId=999")
      .set("Authorization", `Bearer ${createToken("42")}`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, result);

    assert.deepEqual(historyMock.mock.calls[0].arguments, [
      "42",
      {
        page: 2,
        limit: 5,
      },
    ]);
  } finally {
    historyMock.mock.restore();
  }
});

test("GET orders uses default pagination", async () => {
  const historyMock = mock.method(orderService, "getUserOrders", async () => ({
    orders: [],
    pagination: {
      page: 1,
      limit: 10,
      total: 0,
      totalPages: 0,
    },
  }));

  try {
    const response = await request(app)
      .get("/api/orders")
      .set("Authorization", `Bearer ${createToken()}`);

    assert.equal(response.status, 200);

    assert.deepEqual(historyMock.mock.calls[0].arguments, [
      "42",
      {
        page: 1,
        limit: 10,
      },
    ]);
  } finally {
    historyMock.mock.restore();
  }
});

test("GET orders returns 400 for invalid pagination", async () => {
  const historyMock = mock.method(orderService, "getUserOrders", async () => {
    const error = new Error("Invalid pagination values");
    error.statusCode = 400;
    throw error;
  });

  try {
    const response = await request(app)
      .get("/api/orders?page=-1")
      .set("Authorization", `Bearer ${createToken()}`);

    assert.equal(response.status, 400);
    assert.equal(response.body.message, "Invalid pagination values");
  } finally {
    historyMock.mock.restore();
  }
});

test("GET orders handles unexpected service errors", async () => {
  const historyMock = mock.method(orderService, "getUserOrders", async () => {
    throw new Error("Database connection failed");
  });

  try {
    const response = await request(app)
      .get("/api/orders")
      .set("Authorization", `Bearer ${createToken()}`);

    assert.equal(response.status, 500);
    assert.equal(response.body.message, "Failed to retrieve orders");
  } finally {
    historyMock.mock.restore();
  }
});

// --------------------------------------------------
// GET ORDER BY ID
// --------------------------------------------------

test("GET order by ID returns the requested user's order", async () => {
  const detailMock = mock.method(
    orderService,
    "getOrderById",
    async () => sampleOrder,
  );

  try {
    const response = await request(app)
      .get("/api/orders/77")
      .set("Authorization", `Bearer ${createToken("42")}`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.order, sampleOrder);

    assert.deepEqual(detailMock.mock.calls[0].arguments, ["42", "77"]);
  } finally {
    detailMock.mock.restore();
  }
});

test("GET order by ID returns 404 when order is not accessible", async () => {
  const detailMock = mock.method(orderService, "getOrderById", async () => {
    const error = new Error("Order not found");
    error.statusCode = 404;
    throw error;
  });

  try {
    const response = await request(app)
      .get("/api/orders/999")
      .set("Authorization", `Bearer ${createToken()}`);

    assert.equal(response.status, 404);
    assert.equal(response.body.message, "Order not found");
  } finally {
    detailMock.mock.restore();
  }
});

test("GET order by ID returns 400 for an invalid order ID", async () => {
  const detailMock = mock.method(orderService, "getOrderById", async () => {
    const error = new Error("ID must be a positive integer");
    error.statusCode = 400;
    throw error;
  });

  try {
    const response = await request(app)
      .get("/api/orders/invalid")
      .set("Authorization", `Bearer ${createToken()}`);

    assert.equal(response.status, 400);
    assert.equal(response.body.message, "ID must be a positive integer");
  } finally {
    detailMock.mock.restore();
  }
});

test("GET order by ID handles unexpected service errors", async () => {
  const detailMock = mock.method(orderService, "getOrderById", async () => {
    throw new Error("Database connection failed");
  });

  try {
    const response = await request(app)
      .get("/api/orders/77")
      .set("Authorization", `Bearer ${createToken()}`);

    assert.equal(response.status, 500);
    assert.equal(response.body.message, "Failed to retrieve order");
  } finally {
    detailMock.mock.restore();
  }
});
