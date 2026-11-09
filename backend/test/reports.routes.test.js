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

// Authentication and authorization tests.

test("GET reports rejects requests without a token", async () => {
  for (const endpoint of [
    "/api/reports/stock-summary",
    "/api/reports/low-stock",
    "/api/reports/category-stock",
    "/api/reports/stock-movement?startDate=2026-11-01&endDate=2026-11-09",
  ]) {
    const response = await request(app).get(endpoint);

    assert.equal(response.status, 401);
  }
});

test("GET reports rejects customers", async () => {
  const token = createToken("customer");

  for (const endpoint of [
    "/api/reports/stock-summary",
    "/api/reports/low-stock",
    "/api/reports/category-stock",
    "/api/reports/stock-movement?startDate=2026-11-01&endDate=2026-11-09",
  ]) {
    const response = await request(app)
      .get(endpoint)
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 403);
  }
});

// Stock summary route tests.

test("GET stock summary returns overall stock statistics", async () => {
  const token = createToken("inventory_manager");

  const summary = {
    product_count: 3,
    products_with_inventory: 3,
    products_without_inventory: 0,
    total_stock_quantity: 85,
  };

  const queryMock = mock.method(pool, "query", async () => ({
    rows: [summary],
  }));

  try {
    const response = await request(app)
      .get("/api/reports/stock-summary")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, summary);
    assert.equal(queryMock.mock.callCount(), 1);
  } finally {
    queryMock.mock.restore();
  }
});

test("GET stock summary allows admins", async () => {
  const token = createToken("admin");

  const queryMock = mock.method(pool, "query", async () => ({
    rows: [
      {
        product_count: "0",
        products_with_inventory: "0",
        products_without_inventory: "0",
        total_stock_quantity: "0",
      },
    ],
  }));

  try {
    const response = await request(app)
      .get("/api/reports/stock-summary")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.product_count, 0);
  } finally {
    queryMock.mock.restore();
  }
});

// Low-stock route tests.

test("GET low-stock report returns products and count", async () => {
  const token = createToken("inventory_manager");

  const products = [
    {
      product_id: 96,
      name: "Mouse",
      sku: "TEST-MS-001",
      category_id: 43,
      quantity: 3,
      low_stock_threshold: 10,
    },
  ];

  const queryMock = mock.method(pool, "query", async () => ({
    rows: products,
  }));

  try {
    const response = await request(app)
      .get("/api/reports/low-stock")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      count: 1,
      products,
    });

    assert.equal(queryMock.mock.callCount(), 1);
  } finally {
    queryMock.mock.restore();
  }
});

test("GET low-stock report returns an empty list when no products are low", async () => {
  const token = createToken("admin");

  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    const response = await request(app)
      .get("/api/reports/low-stock")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      count: 0,
      products: [],
    });
  } finally {
    queryMock.mock.restore();
  }
});

// Category stock route tests.

test("GET category-stock returns stock statistics for all categories", async () => {
  const token = createToken("inventory_manager");

  const categories = [
    {
      category_id: 44,
      category_name: "Accessories",
      product_count: 1,
      products_with_inventory: 1,
      total_stock_quantity: 30,
    },
    {
      category_id: 43,
      category_name: "Electronics",
      product_count: 2,
      products_with_inventory: 2,
      total_stock_quantity: 55,
    },
  ];

  const queryMock = mock.method(pool, "query", async () => ({
    rows: categories,
  }));

  try {
    const response = await request(app)
      .get("/api/reports/category-stock")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { categories });
    assert.equal(queryMock.mock.callCount(), 1);
  } finally {
    queryMock.mock.restore();
  }
});

test("GET category-stock filters by categoryId", async () => {
  const token = createToken("admin");

  const categories = [
    {
      category_id: 43,
      category_name: "Electronics",
      product_count: 2,
      products_with_inventory: 2,
      total_stock_quantity: 55,
    },
  ];

  const queryMock = mock.method(pool, "query", async () => ({
    rows: categories,
  }));

  try {
    const response = await request(app)
      .get("/api/reports/category-stock?categoryId=43")
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { categories });

    assert.deepEqual(
      queryMock.mock.calls[0].arguments[1],
      [43],
    );
  } finally {
    queryMock.mock.restore();
  }
});

test("GET category-stock rejects invalid category IDs", async () => {
  const token = createToken("inventory_manager");

  for (const categoryId of ["abc", "0", "-1", "1.5"]) {
    const response = await request(app)
      .get(`/api/reports/category-stock?categoryId=${categoryId}`)
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 400);
    assert.equal(
      response.body.message,
      "categoryId must be a positive integer",
    );
  }
});

// Stock movement route tests.

test("GET stock-movement returns totals and daily breakdown", async () => {
  const token = createToken("inventory_manager");

  const queryMock = mock.method(pool, "query", async (sql) => {
    if (sql.includes("GROUP BY")) {
      return {
        rows: [
          {
            date: "2026-11-09",
            stock_added: "10",
            stock_removed: "2",
          },
        ],
      };
    }

    return {
      rows: [
        {
          total_added: "10",
          total_removed: "2",
        },
      ],
    };
  });

  try {
    const response = await request(app)
      .get(
        "/api/reports/stock-movement?startDate=2026-11-09&endDate=2026-11-09",
      )
      .set("Authorization", `Bearer ${token}`);

    assert.equal(response.status, 200);

    assert.deepEqual(response.body, {
      start_date: "2026-11-09",
      end_date: "2026-11-09",
      total_added: 10,
      total_removed: 2,
      net_change: 8,
      daily: [
        {
          date: "2026-11-09",
          stock_added: 10,
          stock_removed: 2,
          net_change: 8,
        },
      ],
    });

    assert.equal(queryMock.mock.callCount(), 2);
  } finally {
    queryMock.mock.restore();
  }
});

test("GET stock-movement rejects missing dates", async () => {
  const token = createToken("inventory_manager");

  const response = await request(app)
    .get("/api/reports/stock-movement")
    .set("Authorization", `Bearer ${token}`);

  assert.equal(response.status, 400);
  assert.equal(
    response.body.message,
    "startDate and endDate must be valid dates in YYYY-MM-DD format",
  );
});

test("GET stock-movement rejects invalid date formats", async () => {
  const token = createToken("inventory_manager");

  const response = await request(app)
    .get(
      "/api/reports/stock-movement?startDate=09-11-2026&endDate=2026-11-09",
    )
    .set("Authorization", `Bearer ${token}`);

  assert.equal(response.status, 400);
});

test("GET stock-movement rejects an end date before the start date", async () => {
  const token = createToken("inventory_manager");

  const response = await request(app)
    .get(
      "/api/reports/stock-movement?startDate=2026-11-10&endDate=2026-11-09",
    )
    .set("Authorization", `Bearer ${token}`);

  assert.equal(response.status, 400);
});
