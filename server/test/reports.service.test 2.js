const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  getStockSummary,
  getLowStockSummary,
  getCategoryStock,
  getStockMovement,
} = require("../src/services/reports.service");

// Creates a fake database that returns predefined results.
function createMockDb(results) {
  const calls = [];

  return {
    calls,

    query: async (sql, values) => {
      calls.push({ sql, values });

      const result = results.shift();

      if (result instanceof Error) {
        throw result;
      }

      return result;
    },
  };
}

// Stock summary tests.

test("getStockSummary returns correct overall stock statistics", async () => {
  const db = createMockDb([
    {
      rows: [
        {
          product_count: "3",
          products_with_inventory: "3",
          products_without_inventory: "0",
          total_stock_quantity: "85",
        },
      ],
    },
  ]);

  const result = await getStockSummary(db);

  assert.deepEqual(result, {
    product_count: 3,
    products_with_inventory: 3,
    products_without_inventory: 0,
    total_stock_quantity: 85,
  });

  assert.match(db.calls[0].sql, /LEFT JOIN inventory/i);
  assert.equal(db.calls.length, 1);
});

test("getStockSummary handles an empty database", async () => {
  const db = createMockDb([
    {
      rows: [
        {
          product_count: "0",
          products_with_inventory: "0",
          products_without_inventory: "0",
          total_stock_quantity: "0",
        },
      ],
    },
  ]);

  const result = await getStockSummary(db);

  assert.deepEqual(result, {
    product_count: 0,
    products_with_inventory: 0,
    products_without_inventory: 0,
    total_stock_quantity: 0,
  });
});

// Low-stock report tests.

test("getLowStockSummary reuses the existing low-stock query", async () => {
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

  const db = createMockDb([{ rows: products }]);

  const result = await getLowStockSummary(db);

  assert.deepEqual(result, {
    count: 1,
    products,
  });

  assert.match(db.calls[0].sql, /low_stock_threshold IS NOT NULL/i);
  assert.match(db.calls[0].sql, /quantity <= p\.low_stock_threshold/i);
});

test("getLowStockSummary returns zero when no products are low on stock", async () => {
  const db = createMockDb([{ rows: [] }]);

  const result = await getLowStockSummary(db);

  assert.deepEqual(result, {
    count: 0,
    products: [],
  });
});

// Category stock tests.

test("getCategoryStock returns stock statistics for all categories", async () => {
  const db = createMockDb([
    {
      rows: [
        {
          category_id: "44",
          category_name: "Accessories",
          product_count: "1",
          products_with_inventory: "1",
          total_stock_quantity: "30",
        },
        {
          category_id: "43",
          category_name: "Electronics",
          product_count: "2",
          products_with_inventory: "2",
          total_stock_quantity: "55",
        },
      ],
    },
  ]);

  const result = await getCategoryStock(undefined, db);

  assert.deepEqual(result, {
    categories: [
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
    ],
  });

  assert.match(db.calls[0].sql, /LEFT JOIN products/i);
  assert.match(db.calls[0].sql, /LEFT JOIN inventory/i);
  assert.match(db.calls[0].sql, /COUNT\(DISTINCT p\.id\)/i);
  assert.match(db.calls[0].sql, /GROUP BY c\.id, c\.name/i);

  assert.deepEqual(db.calls[0].values, []);
});

test("getCategoryStock filters by category ID using a parameterized query", async () => {
  const db = createMockDb([
    {
      rows: [
        {
          category_id: "43",
          category_name: "Electronics",
          product_count: "2",
          products_with_inventory: "2",
          total_stock_quantity: "55",
        },
      ],
    },
  ]);

  const result = await getCategoryStock("43", db);

  assert.equal(result.categories.length, 1);
  assert.equal(result.categories[0].category_id, 43);

  assert.match(db.calls[0].sql, /WHERE c\.id = \$1/i);
  assert.deepEqual(db.calls[0].values, [43]);
});

test("getCategoryStock rejects invalid category IDs without querying the database", async () => {
  const db = createMockDb([]);

  await assert.rejects(
    getCategoryStock("abc", db),
    {
      message: "categoryId must be a positive integer",
      statusCode: 400,
    },
  );

  await assert.rejects(
    getCategoryStock("0", db),
    {
      message: "categoryId must be a positive integer",
      statusCode: 400,
    },
  );

  await assert.rejects(
    getCategoryStock("-1", db),
    {
      message: "categoryId must be a positive integer",
      statusCode: 400,
    },
  );

  assert.equal(db.calls.length, 0);
});

// Stock movement tests.

test("getStockMovement returns overall totals and daily breakdown", async () => {
  const db = createMockDb([
    {
      rows: [
        {
          total_added: "10",
          total_removed: "2",
        },
      ],
    },
    {
      rows: [
        {
          date: "2026-11-09",
          stock_added: "10",
          stock_removed: "2",
        },
      ],
    },
  ]);

  const result = await getStockMovement(
    "2026-11-09",
    "2026-11-09",
    db,
  );

  assert.deepEqual(result, {
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

  assert.equal(db.calls.length, 2);

  assert.deepEqual(db.calls[0].values, [
    "2026-11-09",
    "2026-11-09",
  ]);

  assert.deepEqual(db.calls[1].values, [
    "2026-11-09",
    "2026-11-09",
  ]);
});

test("getStockMovement uses UTC boundaries and includes the entire end date", async () => {
  const db = createMockDb([
    {
      rows: [{ total_added: "0", total_removed: "0" }],
    },
    {
      rows: [],
    },
  ]);

  await getStockMovement("2026-11-01", "2026-11-09", db);

  for (const call of db.calls) {
    assert.match(call.sql, /AT TIME ZONE 'UTC'/i);
    assert.match(call.sql, /\$1::date/i);
    assert.match(call.sql, /\$2::date \+ INTERVAL '1 day'/i);
  }
});

test("getStockMovement returns zero totals when there are no transactions", async () => {
  const db = createMockDb([
    {
      rows: [
        {
          total_added: "0",
          total_removed: "0",
        },
      ],
    },
    {
      rows: [],
    },
  ]);

  const result = await getStockMovement(
    "2026-11-01",
    "2026-11-09",
    db,
  );

  assert.equal(result.total_added, 0);
  assert.equal(result.total_removed, 0);
  assert.equal(result.net_change, 0);
  assert.deepEqual(result.daily, []);
});

test("getStockMovement rejects invalid date formats", async () => {
  const db = createMockDb([]);

  await assert.rejects(
    getStockMovement("09-11-2026", "2026-11-09", db),
    {
      message:
        "startDate and endDate must be valid dates in YYYY-MM-DD format",
      statusCode: 400,
    },
  );

  await assert.rejects(
    getStockMovement("2026-02-30", "2026-03-01", db),
    {
      message:
        "startDate and endDate must be valid dates in YYYY-MM-DD format",
      statusCode: 400,
    },
  );

  assert.equal(db.calls.length, 0);
});

test("getStockMovement rejects an end date earlier than the start date", async () => {
  const db = createMockDb([]);

  await assert.rejects(
    getStockMovement("2026-11-10", "2026-11-09", db),
    {
      message: "endDate must be greater than or equal to startDate",
      statusCode: 400,
    },
  );

  assert.equal(db.calls.length, 0);
});

test("getStockMovement propagates database errors", async () => {
  const db = createMockDb([
    new Error("Database connection failed"),
  ]);

  await assert.rejects(
    getStockMovement("2026-11-09", "2026-11-09", db),
    /Database connection failed/,
  );
});
