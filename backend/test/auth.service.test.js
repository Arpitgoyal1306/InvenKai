const { test, mock } = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../src/config/database");
const bcrypt = require("bcrypt");
const { registerUser } = require("../src/services/auth.service");

test("registerUser creates a user with a hashed password", async (t) => {
  const query = mock.method(pool, "query", async (_sql, params) => ({
    rows: [
      {
        id: "1",
        name: params[0],
        email: params[1],
        role: "customer",
        created_at: new Date(),
      },
    ],
    rowCount: 1,
  }));

  t.after(() => mock.restoreAll());

  const user = await registerUser({
    name: "Test User",
    email: "TEST@EXAMPLE.COM",
    password: "password123",
  });

  assert.equal(user.name, "Test User");
  assert.equal(user.email, "test@example.com");
  assert.equal(user.role, "customer");
  assert.equal("password_hash" in user, false);

  const passwordHash = query.mock.calls[0].arguments[1][2];
  assert.notEqual(passwordHash, "password123");
  assert.equal(await bcrypt.compare("password123", passwordHash), true);
});

test("registerUser rejects a password shorter than 8 characters", async () => {
  await assert.rejects(
    registerUser({
      name: "Test User",
      email: "test@example.com",
      password: "short",
    }),
    { statusCode: 400 },
  );
});

test("registerUser rejects a missing name", async () => {
  await assert.rejects(
    registerUser({
      name: " ",
      email: "test@example.com",
      password: "password123",
    }),
    { statusCode: 400 },
  );
});

test("registerUser reports duplicate emails", async (t) => {
  const query = mock.method(pool, "query", async () => {
    const error = new Error("Duplicate key");
    error.code = "23505";
    error.constraint = "users_email_key";
    throw error;
  });

  t.after(() => mock.restoreAll());

  await assert.rejects(
    registerUser({
      name: "Test User",
      email: "existing@example.com",
      password: "password123",
    }),
    { statusCode: 409, message: "Email is already registered" },
  );

  assert.equal(query.mock.callCount(), 1);
});
