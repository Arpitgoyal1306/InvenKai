const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const TEST_JWT_SECRET = "invenkai-test-only-secret-do-not-use-in-production";
process.env.JWT_SECRET = TEST_JWT_SECRET;

const app = require("../src/app");
const {
  createWebSocketTicketController,
} = require("../src/controllers/websocket-ticket.controller");

function createToken(role) {
  return jwt.sign(
    {
      sub: "test-user-123",
      role,
    },
    TEST_JWT_SECRET,
    { expiresIn: "5m" },
  );
}

test("POST /api/auth/ws-ticket rejects a request without a token", async () => {
  const response = await request(app).post("/api/auth/ws-ticket");

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    message: "Authentication token required",
  });
});

test("POST /api/auth/ws-ticket rejects an invalid token", async () => {
  const response = await request(app)
    .post("/api/auth/ws-ticket")
    .set("Authorization", "Bearer invalid-token");

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    message: "Invalid or expired token",
  });
});

test("POST /api/auth/ws-ticket rejects customers", async () => {
  const token = createToken("customer");

  const response = await request(app)
    .post("/api/auth/ws-ticket")
    .set("Authorization", `Bearer ${token}`);

  assert.equal(response.status, 403);
});

test("POST /api/auth/ws-ticket returns 503 when Redis is unavailable", async () => {
  const token = createToken("admin");

  const response = await request(app)
    .post("/api/auth/ws-ticket")
    .set("Authorization", `Bearer ${token}`);

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    message: "Ticket service is temporarily unavailable",
  });
});

test("ticket controller returns an issued ticket", async () => {
  const controller = createWebSocketTicketController({
    issueTicketFn: async ({ userId, role }) => {
      assert.equal(userId, "test-user-123");
      assert.equal(role, "inventory_manager");

      return {
        ticket: "test-ticket",
        expiresIn: 30,
      };
    },
  });

  const req = {
    user: {
      id: "test-user-123",
      role: "inventory_manager",
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

  await controller(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ticket: "test-ticket",
    expiresIn: 30,
  });
});

test("ticket controller returns 503 when ticket issuance fails", async () => {
  const controller = createWebSocketTicketController({
    issueTicketFn: async () => {
      const error = new Error("Ticket service is temporarily unavailable");
      error.statusCode = 503;
      throw error;
    },
  });

  const req = {
    user: {
      id: "test-user-123",
      role: "admin",
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

  await controller(req, res);

  assert.equal(res.statusCode, 503);
});
