const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../src/app");
const pool = require("../src/config/database");

function bearer(role, id = "1") {
  return (
    "Bearer " +
    jwt.sign({ sub: id, role, authProvider: "google" }, process.env.JWT_SECRET, { expiresIn: "5m" })
  );
}

test("workspace management actions enforce staff and admin roles", async () => {
  const staffOnly = [
    ["post", "/api/categories"],
    ["patch", "/api/products/1/threshold"],
    ["get", "/api/suppliers/1/products"],
    ["put", "/api/suppliers/1/products/1"],
    ["delete", "/api/suppliers/1/products/1"],
  ];
  const adminOnly = [
    ["get", "/api/operations/summary"],
    ["get", "/api/operations/failed-receipts"],
    ["post", "/api/operations/failed-receipts/1/retry"],
  ];
  for (const [method, path] of [...staffOnly, ...adminOnly]) {
    await request(app)[method](path).expect(401);
    await request(app)
      [method](path)
      .set("Authorization", bearer("customer"))
      .expect(403);
  }
  for (const [method, path] of adminOnly) {
    await request(app)
      [method](path)
      .set("Authorization", bearer("inventory_manager"))
      .expect(403);
  }
});

test("receipt reads distinguish pending from inaccessible orders", async (t) => {
  await request(app).get("/api/orders/9/receipt").expect(401);
  const query = t.mock.method(pool, "query", async (sql, params) => {
    assert.match(sql, /o\.user_id=\$2/);
    return {
      rows:
        params[0] === "9" && params[1] === "7"
          ? [{ receipt_number: null }]
          : [],
    };
  });
  const path = "/api/orders/9/receipt";
  const result = await request(app)
    .get(path)
    .set("Authorization", bearer("customer", "7"))
    .expect(200);
  assert.deepEqual(result.body, { receipt: null });
  await request(app)
    .get(path)
    .set("Authorization", bearer("admin", "8"))
    .expect(404);
  assert.equal(query.mock.callCount(), 2);
});

test("invalid threshold is rejected before a product write", async (t) => {
  const query = t.mock.method(pool, "query", () =>
    assert.fail("unexpected database access"),
  );
  for (const threshold of [-1, 2.5, 2147483648, "5"]) {
    await request(app)
      .patch("/api/products/4/threshold")
      .set("Authorization", bearer("admin"))
      .send({ low_stock_threshold: threshold })
      .expect(400);
  }
  assert.equal(query.mock.callCount(), 0);
});
