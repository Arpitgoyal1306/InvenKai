
const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const pool = require("../src/config/database");
const app = require("../src/app");

test("GET /health returns 200 when database is connected", async () => {
  const queryMock = mock.method(pool, "query", async () => ({
    rows: [{ "?column?": 1 }],
  }));

  try {
    const response = await request(app).get("/health");

    assert.equal(response.status, 200);

    assert.deepEqual(response.body, {
      status: "ok",
      database: "connected",
    });

    // Verify the database connectivity query
    assert.equal(queryMock.mock.callCount(), 1);
    assert.deepEqual(
      queryMock.mock.calls[0].arguments,
      ["SELECT 1"]
    );
  } finally {
    queryMock.mock.restore();
  }
});

test("GET /health returns 503 when database is disconnected", async () => {
  const queryMock = mock.method(pool, "query", async () => {
    throw new Error("Database connection failed");
  });

  try {
    const response = await request(app).get("/health");

    assert.equal(response.status, 503);

    assert.deepEqual(response.body, {
      status: "error",
      database: "disconnected",
    });

    assert.equal(queryMock.mock.callCount(), 1);
    assert.deepEqual(
      queryMock.mock.calls[0].arguments,
      ["SELECT 1"]
    );
  } finally {
    queryMock.mock.restore();
  }
});
