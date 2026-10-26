const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const jwt = require("jsonwebtoken");

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

test("GET inventory rejects requests without a token", async () => {
  const response = await request(app).get("/api/inventory/1");

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
