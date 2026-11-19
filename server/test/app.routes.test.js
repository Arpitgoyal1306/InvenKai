const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const jwt = require("jsonwebtoken");

// Use a test-only secret before importing the app.
// dotenv will not overwrite an already-set environment variable.
const TEST_JWT_SECRET = "invenkai-test-only-secret-do-not-use-in-production";
process.env.JWT_SECRET = TEST_JWT_SECRET;

const app = require("../src/app");

function createToken(payload, secret = TEST_JWT_SECRET, options = {}) {
  return jwt.sign(payload, secret, options);
}

// ---------------- MAIN API ROUTES ----------------

test("GET / returns the API running message", async () => {
  const response = await request(app).get("/");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    message: "InvenKai API is running",
  });
});

test("unknown URL returns 404 with the standard not-found message", async () => {
  const response = await request(app).get("/unknown-route");

  assert.equal(response.status, 404);
  assert.deepEqual(response.body, {
    message: "Route not found",
  });
});

test("unknown API URL returns 404 with the standard not-found message", async () => {
  const response = await request(app).get("/api/unknown-route");

  assert.equal(response.status, 404);
  assert.deepEqual(response.body, {
    message: "Route not found",
  });
});

// ---------------- JWT AUTHENTICATION ----------------

test("GET /api/auth/me rejects a request without a token", async () => {
  const response = await request(app).get("/api/auth/me");

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    message: "Authentication token required",
  });
});

test("GET /api/auth/me rejects a malformed token", async () => {
  const response = await request(app)
    .get("/api/auth/me")
    .set("Authorization", "Bearer this-is-not-a-valid-jwt");

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    message: "Invalid or expired token",
  });
});

test("GET /api/auth/me rejects a token signed with the wrong secret", async () => {
  const token = createToken(
    {
      sub: "test-user-123",
      role: "inventory_manager",
    },
    "another-test-only-secret",
  );

  const response = await request(app)
    .get("/api/auth/me")
    .set("Authorization", `Bearer ${token}`);

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    message: "Invalid or expired token",
  });
});

test("GET /api/auth/me rejects an expired token", async () => {
  const token = createToken({
    sub: "test-user-123",
    role: "inventory_manager",
    exp: Math.floor(Date.now() / 1000) - 60,
  });

  const response = await request(app)
    .get("/api/auth/me")
    .set("Authorization", `Bearer ${token}`);

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    message: "Invalid or expired token",
  });
});

test("GET /api/auth/me accepts a valid JWT and returns the user", async () => {
  const token = createToken({
    sub: "test-user-123",
    role: "inventory_manager",
  });

  const response = await request(app)
    .get("/api/auth/me")
    .set("Authorization", `Bearer ${token}`);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    user: {
      id: "test-user-123",
      role: "inventory_manager",
    },
  });
});
