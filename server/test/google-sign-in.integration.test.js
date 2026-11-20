const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const request = require("supertest");
const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");
const app = require("../src/app");
const pool = require("../src/config/database");

after(() => pool.end());

test("Google callback checks state and signs in only the verified Google identity", async (t) => {
  await pool.verifyDatabaseIdentity();
  const suffix = randomUUID();
  const email = suffix + "@example.test";
  const legacyEmail = "legacy-" + email;
  const password = "test-password-for-google-link";
  const profile = {
    sub: suffix,
    email,
    email_verified: true,
    name: "Google Buyer",
    picture: "https://lh3.googleusercontent.com/sample",
  };
  const oldConfig = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "CLIENT_URL",
  ].map((key) => [key, process.env[key]]);
  process.env.GOOGLE_CLIENT_ID = "test-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  process.env.CLIENT_URL = "http://localhost:5175";

  const exchange = t.mock.method(
    OAuth2Client.prototype,
    "getToken",
    async () => ({ tokens: { id_token: "fixture" } }),
  );
  t.mock.method(OAuth2Client.prototype, "verifyIdToken", async () => ({
    getPayload: () => profile,
  }));
  const start = async () => {
    const response = await request(app).get("/api/auth/google").expect(302);
    const params = new URL(response.headers.location).searchParams;
    const cookie = response.headers["set-cookie"][0].split(";")[0];
    assert.equal(params.get("redirect_uri"), "http://localhost:5175/home");
    assert.equal(params.get("code_challenge_method"), "S256");
    profile.nonce = params.get("nonce");
    return { cookie, state: params.get("state") };
  };
  const callback = (cookie, state) =>
    request(app)
      .post("/api/auth/google/callback")
      .set("Cookie", cookie)
      .send({ code: "fixture", state });

  try {
    const attempt = await start();
    await callback(attempt.cookie, "wrong-state").expect(400);
    assert.equal(exchange.mock.callCount(), 0);
    const first = (await callback(attempt.cookie, attempt.state).expect(200))
      .body;
    assert.equal(first.user.role, "customer");
    assert.equal(first.user.avatar_url, profile.picture);
    assert.equal(
      jwt.verify(first.token, process.env.JWT_SECRET).sub,
      first.user.id,
    );
    profile.sub = suffix + "-different";
    const collision = await start();
    await callback(collision.cookie, collision.state).expect(409);
    profile.sub = suffix;
    profile.picture = "https://lh3.googleusercontent.com/updated";
    const repeat = await start();
    const second = (await callback(repeat.cookie, repeat.state).expect(200))
      .body;
    assert.equal(second.user.id, first.user.id);
    const restored = await request(app)
      .get("/api/auth/profile")
      .set("Authorization", "Bearer " + second.token)
      .expect(200);
    assert.equal(restored.body.user.avatar_url, profile.picture);

    const credentials = {
      name: "Existing Buyer",
      email: legacyEmail,
      password,
    };
    const registered = await request(app)
      .post("/api/auth/register")
      .send(credentials)
      .expect(201);
    profile.sub = suffix + "-legacy";
    profile.email = legacyEmail;
    const oldPasswordLogin = (
      await request(app).post("/api/auth/login").send(credentials).expect(200)
    ).body;
    const legacy = await start();
    await callback(legacy.cookie, legacy.state).expect(409);
    profile.hd = "example.test";
    const workspace = await start();
    const linked = (
      await callback(workspace.cookie, workspace.state).expect(200)
    ).body;
    assert.equal(linked.user.id, registered.body.user.id);
    assert.equal(linked.user.name, credentials.name);
    assert.equal(linked.user.avatar_url, profile.picture);
    await request(app).post("/api/auth/login").send(credentials).expect(401);
    await request(app)
      .get("/api/auth/profile")
      .set("Authorization", "Bearer " + oldPasswordLogin.token)
      .expect(401);
    const linkedGoogle = await start();
    const googleLogin = (
      await callback(linkedGoogle.cookie, linkedGoogle.state).expect(200)
    ).body;
    assert.equal(googleLogin.user.id, linked.user.id);
  } finally {
    await pool.query("DELETE FROM users WHERE email=ANY($1)", [
      [email, legacyEmail],
    ]);
    for (const [key, value] of oldConfig) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
