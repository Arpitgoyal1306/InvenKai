const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createOrderReceiptProcessor } = require("../src/workers/order-receipt.processor");
const { createOrderOutboxService } = require("../src/services/order-outbox.service");
const { createOrderOutboxDispatcher } = require("../src/services/order-outbox-dispatcher.service");

test("receipt processor loads order data and inserts an immutable receipt", async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM orders o")) {
        return {
          rowCount: 1,
          rows: [{
            order_id: "12", user_id: "3", total_amount: "30.00",
            item_id: "4", product_id: "5", product_name: "Pen", sku: "PEN",
            unit_price: "15.00", quantity: 2, line_total: "30.00",
          }],
        };
      }
      if (sql.includes("INSERT INTO receipts")) {
        return { rowCount: 1, rows: [{ id: "9", order_id: "12", receipt_number: "INV-12" }] };
      }
      throw new Error("Unexpected query");
    },
  };
  const process = createOrderReceiptProcessor({ db });
  const result = await process({ data: { orderId: "12" } });
  assert.equal(result.receipt_number, "INV-12");
  assert.deepEqual(calls[1].params[4], JSON.stringify([{
    orderItemId: "4", productId: "5", productName: "Pen", sku: "PEN",
    unitPrice: "15.00", quantity: 2, lineTotal: "30.00",
  }]));
});

test("receipt processor returns existing receipt on duplicate delivery", async () => {
  let insertCount = 0;
  const db = {
    async query(sql) {
      if (sql.includes("FROM orders o")) return {
        rowCount: 1,
        rows: [{ order_id: "12", user_id: "3", total_amount: "0.00", item_id: null }],
      };
      if (sql.includes("INSERT INTO receipts")) {
        insertCount += 1;
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("FROM receipts")) return {
        rowCount: 1, rows: [{ id: "9", order_id: "12", receipt_number: "INV-12" }],
      };
      throw new Error("Unexpected query");
    },
  };
  const process = createOrderReceiptProcessor({ db });
  const first = await process({ data: { orderId: "12" } });
  const second = await process({ data: { orderId: "12" } });
  assert.equal(insertCount, 2);
  assert.deepEqual(first, second);
});

test("receipt processor rejects invalid order IDs", async () => {
  const process = createOrderReceiptProcessor({ db: { query: async () => { throw new Error("should not query"); } } });
  await assert.rejects(process({ data: { orderId: "../12" } }), /valid orderId/);
});

test("outbox event is inserted with a unique event/order contract", async () => {
  let captured;
  const service = createOrderOutboxService();
  await service.addOrderReceiptEvent({
    query: async (sql, params) => { captured = { sql, params }; },
  }, "12");
  assert.match(captured.sql, /ON CONFLICT \(event_type, order_id\) DO NOTHING/);
  assert.equal(captured.params[1], "12");
  assert.deepEqual(JSON.parse(captured.params[2]), { orderId: "12" });
});

test("dispatcher republishes with order ID and marks outbox event dispatched", async () => {
  const statements = [];
  const db = {
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.includes("WITH candidates")) return {
        rows: [{ id: "1", order_id: "12", payload: { orderId: "12" }, attempts: 1 }],
      };
      return { rows: [], rowCount: 1 };
    },
  };
  const jobs = [];
  const dispatcher = createOrderOutboxDispatcher({
    db,
    createQueue: async () => ({
      enqueueOrderReceipt: async (id) => jobs.push(String(id)),
      close: async () => {},
    }),
  });
  const result = await dispatcher.dispatchBatch();
  assert.deepEqual(result, { claimed: 1, dispatched: 1, failed: 0 });
  assert.deepEqual(jobs, ["12"]);
  assert.ok(statements.some((item) => item.sql.includes("status = 'dispatched'")));
  await dispatcher.close();
});

test("dispatcher leaves failed enqueue available for retry", async () => {
  const statements = [];
  const db = {
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.includes("WITH candidates")) return {
        rows: [{ id: "2", order_id: "13", payload: { orderId: "13" }, attempts: 1 }],
      };
      return { rows: [], rowCount: 1 };
    },
  };
  const dispatcher = createOrderOutboxDispatcher({
    db,
    createQueue: async () => ({
      enqueueOrderReceipt: async () => { throw new Error("Redis down"); },
      close: async () => {},
    }),
  });
  const result = await dispatcher.dispatchBatch();
  assert.deepEqual(result, { claimed: 1, dispatched: 0, failed: 1 });
  assert.ok(statements.some((item) => item.sql.includes("status = 'pending'") && item.params[1] === "Redis down"));
  await dispatcher.close();
});
