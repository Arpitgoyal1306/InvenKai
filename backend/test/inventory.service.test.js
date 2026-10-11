const { test, mock } = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../src/config/database");
const {
  getInventoryByProductId,
  decreaseStock,
} = require("../src/services/inventory.service");

test("getInventoryByProductId returns inventory when found", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [
      {
        product_id: 1,
        quantity: 10,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ],
  }));

  try {
    const inventory = await getInventoryByProductId(1);

    assert.equal(inventory.product_id, 1);
    assert.equal(inventory.quantity, 10);
    assert.equal(queryMock.mock.calls.length, 1);
  } finally {
    queryMock.mock.restore();
  }
});

test("getInventoryByProductId returns null when not found", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [],
  }));

  try {
    const inventory = await getInventoryByProductId(999);

    assert.equal(inventory, null);
    assert.equal(queryMock.mock.calls.length, 1);
  } finally {
    queryMock.mock.restore();
  }
});

test("decreaseStock returns updated stock when sufficient stock exists", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rowCount: 1,
    rows: [{ product_id: 1, quantity: 7, updated_at: new Date() }],
  }));

  try {
    const inventory = await decreaseStock(1, 3);

    assert.equal(inventory.product_id, 1);
    assert.equal(inventory.quantity, 7);
    assert.equal(queryMock.mock.calls.length, 1);
    assert.match(queryMock.mock.calls[0].arguments[0], /quantity >= \$2/);
  } finally {
    queryMock.mock.restore();
  }
});

test("decreaseStock rejects insufficient stock or missing inventory", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rowCount: 0,
    rows: [],
  }));

  try {
    await assert.rejects(
      decreaseStock(1, 3),
      /Product inventory not found or insufficient stock/,
    );
    assert.equal(queryMock.mock.calls.length, 1);
  } finally {
    queryMock.mock.restore();
  }
});

test("decreaseStock rejects invalid inputs without querying the database", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    throw new Error("Database should not be queried");
  });

  try {
    await assert.rejects(decreaseStock(0, 3), /positive integers/);
    await assert.rejects(decreaseStock(1, 0), /positive integers/);
    await assert.rejects(decreaseStock(1.5, 3), /positive integers/);
    assert.equal(queryMock.mock.calls.length, 0);
  } finally {
    queryMock.mock.restore();
  }
});
