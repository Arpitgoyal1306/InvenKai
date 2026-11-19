const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const authenticateToken = require("../src/middleware/auth.middleware");

const originalSecret = process.env.JWT_SECRET;

test("rejects a request without an authorization token", () => {
  const req = { headers: {} };
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  let nextCalled = false;

  authenticateToken(req, res, () => {
    nextCalled = true;
  });

  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("rejects an invalid token", () => {
  const req = {
    headers: {
      authorization: "Bearer invalid-token",
    },
  };

  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  let nextCalled = false;

  authenticateToken(req, res, () => {
    nextCalled = true;
  });

  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("rejects an expired token", () => {
  const token = jwt.sign(
    { role: "customer" },
    process.env.JWT_SECRET,
    {
      subject: "42",
      expiresIn: -1,
    },
  );

  const req = {
    headers: {
      authorization: `Bearer ${token}`,
    },
  };

  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  let nextCalled = false;

  authenticateToken(req, res, () => {
    nextCalled = true;
  });

  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("accepts a valid token and attaches the user to the request", () => {
  const token = jwt.sign(
    { role: "customer" },
    process.env.JWT_SECRET,
    {
      subject: "42",
      expiresIn: "1h",
    },
  );

  const req = {
    headers: {
      authorization: `Bearer ${token}`,
    },
  };

  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  let nextCalled = false;

  authenticateToken(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.deepEqual(req.user, {
    id: "42",
    role: "customer",
  });
});