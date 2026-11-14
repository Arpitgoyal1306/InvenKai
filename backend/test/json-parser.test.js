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
  assert.match(response.headers["content-type"], /application\/json/);
  assert.deepEqual(response.body, {
    message: "Invalid JSON request body",
  });
});

test("valid JSON reaches normal route validation", async () => {
  const response = await request(app)
    .post("/api/auth/register")
    .send({});

  assert.equal(response.status, 400);
  assert.notEqual(
    response.body.message,
    "Invalid JSON request body"
  );
  assert.match(response.headers["content-type"], /application\/json/);
});

test("forwards oversized JSON errors instead of treating them as malformed JSON", async () => {
  const largePayload = JSON.stringify({
    data: "x".repeat(1024 * 1024),
  });

  const response = await request(app)
    .post("/api/auth/register")
    .set("Content-Type", "application/json")
    .send(largePayload);

  assert.equal(response.status, 413);
  assert.notEqual(
    response.body.message,
    "Invalid JSON request body"
  );
});

test("preserves 404 behavior for unknown routes", async () => {
  const response = await request(app).get("/this-route-does-not-exist");

  assert.equal(response.status, 404);
  assert.deepEqual(response.body, {
    message: "Route not found",
  });
});
