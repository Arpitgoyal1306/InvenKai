const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createOrderReceiptProcessor,
} = require("../src/workers/order-receipt.processor");

test("creates a receipt using the order and its items", async () => {
  const calls = [];

  const expectedReceipt = {
    id: "1",
    order_id: "101",
    receipt_number: "INV-101",
    issued_at: new Date(),
  };

  const db = {
    async query(sql, params) {
      calls.push({ sql, params });

      if (sql.includes("FROM orders o")) {
        return {
          rowCount: 2,
          rows: [
            {
              order_id: "101",
              user_id: "10",
              total_amount: "30.00",
              item_id: "1",
              product_id: "20",
              product_name: "Keyboard",
              sku: "KEY-001",
              unit_price: "15.00",
              quantity: 2,
              line_total: "30.00",
            },
          ],
        };
      }

      if (sql.includes("INSERT INTO receipts")) {
        return {
          rowCount: 1,
          rows: [expectedReceipt],
        };
      }

      throw new Error("Unexpected database query");
    },
  };

  const processor = createOrderReceiptProcessor({ db });
  const result = await processor({ data: { orderId: "101" } });

  assert.deepEqual(result, expectedReceipt);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].params, [
    "101",
    "INV-101",
    "10",
    "30.00",
    JSON.stringify([
      {
        orderItemId: "1",
        productId: "20",
        productName: "Keyboard",
        sku: "KEY-001",
        unitPrice: "15.00",
        quantity: 2,
        lineTotal: "30.00",
      },
    ]),
  ]);
});

test("returns the existing receipt when the same order is processed again", async () => {
  let insertCount = 0;

  const existingReceipt = {
    id: "1",
    order_id: "101",
    receipt_number: "INV-101",
    issued_at: new Date(),
  };

  const db = {
    async query(sql) {
      if (sql.includes("FROM orders o")) {
        return {
          rowCount: 1,
          rows: [
            {
              order_id: "101",
              user_id: "10",
              total_amount: "30.00",
              item_id: null,
            },
          ],
        };
      }

      if (sql.includes("INSERT INTO receipts")) {
        insertCount += 1;
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes("FROM receipts")) {
        return {
          rowCount: 1,
          rows: [existingReceipt],
        };
      }

      throw new Error("Unexpected database query");
    },
  };

  const processor = createOrderReceiptProcessor({ db });
  const result = await processor({ data: { orderId: "101" } });

  assert.deepEqual(result, existingReceipt);
  assert.equal(insertCount, 1);
});

test("rejects an invalid order ID without querying the database", async () => {
  let queryCount = 0;

  const db = {
    async query() {
      queryCount += 1;
    },
  };

  const processor = createOrderReceiptProcessor({ db });

  await assert.rejects(
    processor({ data: { orderId: "0" } }),
    /valid orderId/,
  );

  assert.equal(queryCount, 0);
});

test("rejects when the requested order does not exist", async () => {
  const db = {
    async query() {
      return { rowCount: 0, rows: [] };
    },
  };

  const processor = createOrderReceiptProcessor({ db });

  await assert.rejects(
    processor({ data: { orderId: "999" } }),
    /Order 999 was not found/,
  );
});

test("propagates receipt insertion errors", async () => {
  const db = {
    async query(sql) {
      if (sql.includes("FROM orders o")) {
        return {
          rowCount: 1,
          rows: [
            {
              order_id: "101",
              user_id: "10",
              total_amount: "30.00",
              item_id: null,
            },
          ],
        };
      }

      if (sql.includes("INSERT INTO receipts")) {
        throw new Error("Database insertion failed");
      }

      throw new Error("Unexpected database query");
    },
  };

  const processor = createOrderReceiptProcessor({ db });

  await assert.rejects(
    processor({ data: { orderId: "101" } }),
    /Database insertion failed/,
  );
});

const {
  createOrderOutboxDispatcher,
} = require("../src/services/order-outbox-dispatcher.service");

function createDispatcherMocks({ redisReady = true, enqueueError = null } = {}) {
  const events = [
    {
      id: "1",
      order_id: "101",
      payload: { orderId: "101" },
      attempts: 1,
      claim_token: "11111111-1111-4111-8111-111111111111",
    },
  ];

  const queries = [];
  const enqueuedOrders = [];
  let queueCreated = false;
  let queueClosed = false;
  let redisConnectCalls = 0;

  const db = {
    async query(sql, params) {
      queries.push({ sql, params });

      if (sql.includes("WITH candidates AS")) {
        return { rows: events };
      }

      if (sql.includes("SET locked_until = CURRENT_TIMESTAMP")) {
        return { rows: (params?.[2] || []).map((id) => ({ id })) };
      }

      if (sql.includes("SET status = 'dispatched'")) {
        return { rows: [] };
      }

      if (sql.includes("SET status = 'pending'")) {
        return { rows: [] };
      }

      throw new Error("Unexpected database query");
    },
  };

  const redisManager = {
    isRedisReady() {
      return redisReady;
    },
    async connectRedis() {
      redisConnectCalls += 1;
      return redisReady;
    },
  };

  async function createQueue() {
    queueCreated = true;

    return {
      async enqueueOrderReceipt(orderId) {
        enqueuedOrders.push(String(orderId));

        if (enqueueError) {
          throw enqueueError;
        }
      },
      async close() {
        queueClosed = true;
      },
    };
  }

  return {
    db,
    redisManager,
    createQueue,
    events,
    queries,
    enqueuedOrders,
    get queueCreated() {
      return queueCreated;
    },
    get queueClosed() {
      return queueClosed;
    },
    get redisConnectCalls() {
      return redisConnectCalls;
    },
  };
}

test("dispatches pending events and marks them as dispatched", async () => {
  const mocks = createDispatcherMocks();

  const dispatcher = createOrderOutboxDispatcher({
    db: mocks.db,
    createQueue: mocks.createQueue,
    redisManager: mocks.redisManager,
  });

  const result = await dispatcher.dispatchBatch();

  assert.deepEqual(result, {
    claimed: 1,
    dispatched: 1,
    failed: 0,
  });

  assert.deepEqual(mocks.enqueuedOrders, ["101"]);
  assert.equal(mocks.queueCreated, true);

  assert.ok(
    mocks.queries.some((query) =>
      query.sql.includes("SET status = 'dispatched'"),
    ),
  );

  await dispatcher.close();
  assert.equal(mocks.queueClosed, true);
});

test("releases an event for retry when queue enqueueing fails", async () => {
  const mocks = createDispatcherMocks({
    enqueueError: new Error("Redis enqueue failed"),
  });

  const dispatcher = createOrderOutboxDispatcher({
    db: mocks.db,
    createQueue: mocks.createQueue,
    redisManager: mocks.redisManager,
  });

  const result = await dispatcher.dispatchBatch();

  assert.deepEqual(result, {
    claimed: 1,
    dispatched: 0,
    failed: 1,
  });

  assert.ok(
    mocks.queries.some((query) =>
      query.sql.includes("SET status = 'pending'"),
    ),
  );

  assert.equal(mocks.queueClosed, true);

  await dispatcher.close();
});

test("does not create a queue when Redis is unavailable", async () => {
  const mocks = createDispatcherMocks({ redisReady: false });

  const dispatcher = createOrderOutboxDispatcher({
    db: mocks.db,
    createQueue: mocks.createQueue,
    redisManager: mocks.redisManager,
  });

  const result = await dispatcher.dispatchBatch();

  assert.deepEqual(result, {
    claimed: 1,
    dispatched: 0,
    failed: 1,
  });

  assert.equal(mocks.redisConnectCalls, 1);
  assert.equal(mocks.queueCreated, false);

  assert.ok(
    mocks.queries.some((query) =>
      query.sql.includes("SET status = 'pending'"),
    ),
  );

  await dispatcher.close();
});
