const { test, mock } = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../src/config/database");

const {
  getInventoryByProductId,
  decreaseStock,
  increaseStock,
  getInventoryTransactions,
} = require("../src/services/inventory.service");

function mockClient(queryHandler) {
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

test("getInventoryByProductId returns inventory when found", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [{ product_id: 1, quantity: 10 }],
  }));

  try {
    const inventory = await getInventoryByProductId(1);

    assert.equal(inventory.product_id, 1);
    assert.equal(inventory.quantity, 10);
  } finally {
    queryMock.mock.restore();
  }
});

test("getInventoryByProductId returns null when not found", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    assert.equal(await getInventoryByProductId(999), null);
  } finally {
    queryMock.mock.restore();
  }
});

test("increaseStock updates inventory and records history in one transaction", async () => {
  const { calls, connectMock, client } = mockClient(async (sql) => {
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
    const result = await increaseStock(1, 5, "1");

    assert.equal(result.quantity, 15);
    assert.deepEqual(
      calls.map((call) => call.sql.trim().split(/\s+/)[0]),
      ["BEGIN", "SELECT", "UPDATE", "INSERT", "COMMIT"],
    );

    assert.deepEqual(calls[3].values, [1, "1", "increase", 5, 10, 15]);
    assert.equal(client.release.mock.callCount(), 1);
    assert.equal(connectMock.mock.callCount(), 1);
  } finally {
    connectMock.mock.restore();
  }
});

test("decreaseStock updates inventory and records history in one transaction", async () => {
  const { calls, connectMock, client } = mockClient(async (sql) => {
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
    const result = await decreaseStock(1, 3, "1");

    assert.equal(result.quantity, 7);
    assert.deepEqual(calls[3].values, [1, "1", "decrease", 3, 10, 7]);
    assert.equal(calls.at(-1).sql, "COMMIT");
    assert.equal(client.release.mock.callCount(), 1);
  } finally {
    connectMock.mock.restore();
  }
});

test("increaseStock rolls back when inventory does not exist", async () => {
  const { calls, connectMock, client } = mockClient(async () => ({
    rowCount: 0,
    rows: [],
  }));

  try {
    await assert.rejects(
      increaseStock(999, 5, "1"),
      /Product inventory not found/,
    );

    assert.equal(calls.at(-1).sql, "ROLLBACK");
    assert.equal(client.release.mock.callCount(), 1);
  } finally {
    connectMock.mock.restore();
  }
});

test("decreaseStock rejects insufficient stock and rolls back", async () => {
  const { calls, connectMock } = mockClient(async (sql) => {
    if (sql.includes("SELECT product_id, quantity")) {
      return {
        rowCount: 1,
        rows: [{ product_id: 1, quantity: 2 }],
      };
    }

    return { rowCount: 1, rows: [] };
  });

  try {
    await assert.rejects(
      decreaseStock(1, 5, "1"),
      /Product inventory not found or insufficient stock/,
    );

    assert.equal(calls.at(-1).sql, "ROLLBACK");
  } finally {
    connectMock.mock.restore();
  }
});

test("increaseStock rejects stock overflow and rolls back", async () => {
  const { calls, connectMock } = mockClient(async (sql) => {
    if (sql.includes("SELECT product_id, quantity")) {
      return {
        rowCount: 1,
        rows: [{ product_id: 1, quantity: 2147483640 }],
      };
    }

    return { rowCount: 1, rows: [] };
  });

  try {
    await assert.rejects(
      increaseStock(1, 10, "1"),
      /Stock quantity limit exceeded/,
    );

    assert.equal(calls.at(-1).sql, "ROLLBACK");
  } finally {
    connectMock.mock.restore();
  }
});

test("stock change rolls back when history insertion fails", async () => {
  const { calls, connectMock, client } = mockClient(async (sql) => {
    if (sql.includes("SELECT product_id, quantity")) {
      return {
        rowCount: 1,
        rows: [{ product_id: 1, quantity: 10 }],
      };
    }

    if (sql.includes("INSERT INTO inventory_transactions")) {
      throw new Error("History insertion failed");
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
    await assert.rejects(increaseStock(1, 5, "1"), /History insertion failed/);

    assert.equal(calls.at(-1).sql, "ROLLBACK");
    assert.equal(client.release.mock.callCount(), 1);
  } finally {
    connectMock.mock.restore();
  }
});

test("stock change rejects invalid inputs without connecting", async () => {
  const connectMock = mock.method(pool, "connect", async () => {
    throw new Error("Database should not be connected");
  });

  try {
    await assert.rejects(increaseStock(0, 5, "1"), /positive integers/);
    await assert.rejects(decreaseStock(1, 0, "1"), /positive integers/);
    await assert.rejects(increaseStock(1, 5, null), /user ID/);

    assert.equal(connectMock.mock.callCount(), 0);
  } finally {
    connectMock.mock.restore();
  }
});

test("getInventoryTransactions returns filtered paginated history", async () => {
  const rows = [
    {
      id: 1,
      product_id: 1,
      transaction_type: "increase",
      quantity: 5,
    },
  ];

  const queryMock = mock.method(pool, "query", async () => ({ rows }));

  try {
    const result = await getInventoryTransactions({
      productId: 1,
      limit: 10,
      offset: 0,
    });

    assert.deepEqual(result, rows);
    assert.match(
      queryMock.mock.calls[0].arguments[0],
      /WHERE product_id = \$1/,
    );
    assert.match(
      queryMock.mock.calls[0].arguments[0],
      /ORDER BY created_at DESC/,
    );
    assert.deepEqual(queryMock.mock.calls[0].arguments[1], [1, 10, 0]);
  } finally {
    queryMock.mock.restore();
  }
});
