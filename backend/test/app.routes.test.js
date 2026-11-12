require("dotenv").config();

const request = require("supertest");
const { test } = require("node:test");
const assert = require("node:assert");
const jwt = require("jsonwebtoken");

const app = require("../src/app");



test("GET / should return 200", async () => {
    const res = await request(app).get("/");

    assert.strictEqual(res.statusCode, 200);
});

test("GET /unknown should return 404", async () => {
    const res = await request(app).get("/unknown");

    assert.strictEqual(res.statusCode, 404);
});

test("GET /api/auth/me without token should return 401", async () => {
    const res = await request(app).get("/api/auth/me");

    assert.strictEqual(res.statusCode, 401);
});
