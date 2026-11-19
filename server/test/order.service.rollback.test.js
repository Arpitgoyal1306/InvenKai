const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createOrder } = require("../src/services/order.service");

test("createOrder discards the client when rollback fails", async () => {
  const operationError = new Error("Order item insertion failed");
  const rollbackError = new Error("Rollback failed");

  let releasedWithError;

  const client = {
    async query(sql) {
      if (sql === "BEGIN") {
        return { rows: [], rowCount: null };
      }

      if (sql.includes("FROM products p")) {
        return {
          rows: [
            {
              id: "101",
              name: "Test Product",
              sku: "TEST-101",
              price: "15.00",
              available_quantity: 5,
            },
          ],
          rowCount: 1,
        };
      }

      if (sql.includes("INSERT INTO orders")) {
        return {
          rows: [
            {
              id: "501",
              user_id: "42",
              status: "placed",
              total_amount: "0.00",
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        };
      }

      if (sql.includes("INSERT INTO order_items")) {
        throw operationError;
      }

      if (sql === "ROLLBACK") {
        throw rollbackError;
      }

      throw new Error(`Unexpected SQL in test: ${sql}`);
    },

    release(error) {
      releasedWithError = error;
    },
  };

  const fakeDb = {
    async connect() {
      return client;
    },
  };

  await assert.rejects(
    createOrder("42", [{ productId: "101", quantity: 2 }], fakeDb),
    (error) => {
      assert.equal(error, operationError);
      return true;
    },
  );

  assert.equal(
    releasedWithError,
    rollbackError,
    "The client should be discarded using the rollback error",
  );
});
