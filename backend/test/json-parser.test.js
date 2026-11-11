
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const app = require("../src/app");

test("returns 400 for malformed JSON", async () => {
  const response = await request(app)
    .post("/api/auth/register")
    .set("Content-Type", "application/json")
    .send('{"username":');

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    message: "Invalid JSON request body",
  });
});

test("does not classify unknown routes as malformed JSON", async () => {
  const response = await request(app).get("/this-route-does-not-exist");

  assert.equal(response.status, 404);
  assert.deepEqual(response.body, {
    message: "Route not found",
  });
});
