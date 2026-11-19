const { test } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");
const pool = require("../src/config/database");
const request = require("supertest");

process.env.CLIENT_URL = "https://frontend.example";
delete process.env.TRUSTED_PROXY_IPS;
const app = require("../src/app");

test("CORS permits the configured origin to preflight authenticated requests", async () => {
  const preflight = origin => request(app)
    .options("/api/inventory/history")
    .set("Origin", origin)
    .set("Access-Control-Request-Method", "GET")
    .set("Access-Control-Request-Headers", "authorization");

  const allowed = await preflight(process.env.CLIENT_URL);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers["access-control-allow-origin"], process.env.CLIENT_URL);
  assert.match(allowed.headers["access-control-allow-headers"], /authorization/i);

  const other = await preflight("https://other.example");
  assert.equal(other.headers["access-control-allow-origin"], undefined);
});

test("login throttles repeated unsuccessful requests and supplies a retry interval", async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    await request(app).post("/api/auth/login").send({}).expect(400);
  }
  const response = await request(app).post("/api/auth/login").send({}).expect(429);
  assert.ok(Number(response.headers["retry-after"]) > 0);
  assert.match(response.body.message, /Too many login attempts/);
  await request(app).post("/api/auth/login")
    .set("X-Forwarded-For", "203.0.113.8").send({}).expect(429);
  await request(app).get("/").expect(200);
});

test("a successful login releases its slot in the unsuccessful-attempt quota", async t => {
  const password = "valid-test-password";
  const user = { id: "7", role: "customer", email: "quota@example.test", password_hash: await bcrypt.hash(password, 4) };
  t.mock.method(pool, "query", async () => ({ rows: [user] }));
  // Model a real trusted loopback proxy for this test, giving the client its own bucket.
  const original = app.get("trust proxy");
  app.set("trust proxy", ["127.0.0.1", "::1"]);
  t.after(() => app.set("trust proxy", original));
  const login = value => request(app).post("/api/auth/login")
    .set("X-Forwarded-For", "192.0.2.7").send({ email: user.email, password: value });
  for (let i = 0; i < 9; i++) await login("incorrect").expect(401);
  await login(password).expect(200);
  await login("incorrect").expect(401);
  await login("incorrect").expect(429);
});
