const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const request = require("supertest");

if (process.env.NODE_ENV !== "test") throw new Error("Requires NODE_ENV=test");
const app = require("../src/app");
const pool = require("../src/config/database");
const redis = require("../src/config/redis");
const { CATALOG_VERSION_KEY } = require("../src/services/product-cache.service");

before(() => pool.verifyDatabaseIdentity());
after(() => pool.end());

test("registration, login and staff permissions use the persisted user role", async () => {
  const credentials = { name: "Test User", email: `auth-${randomUUID()}@example.test`, password: "workflow-test-password" };
  const registered = await request(app).post("/api/auth/register").send(credentials).expect(201);
  const id = registered.body.user.id;
  try {
    const paths = ["/api/inventory/history", "/api/suppliers", "/api/suppliers/1"];
    for (const role of ["customer", "inventory_manager", "admin"]) {
      if (role !== "customer") await pool.query("UPDATE users SET role = $1 WHERE id = $2", [role, id]);
      const { body } = await request(app).post("/api/auth/login").send(credentials).expect(200);
      const auth = `Bearer ${body.token}`;
      const me = await request(app).get("/api/auth/me").set("Authorization", auth).expect(200);
      assert.equal(me.body.user.role, role);
      for (const path of paths) {
        const response = await request(app).get(path).set("Authorization", auth);
        if (role === "customer") assert.equal(response.status, 403);
        else if (path === "/api/suppliers/1") assert.ok([200, 404].includes(response.status));
        else assert.equal(response.status, 200);
      }
    }
  } finally {
    await pool.query("DELETE FROM users WHERE id = $1", [id]);
  }
});

test("account settings persist contact details and protect sign-in email changes", async () => {
  const key = randomUUID();
  const credentials = {name:"Profile User",email:`profile-${key}@example.test`,password:"workflow-test-password"};
  const {body:{user}} = await request(app).post("/api/auth/register").send(credentials).expect(201);
  try {
    const {body:{token}} = await request(app).post("/api/auth/login").send(credentials).expect(200);
    const auth = "Bearer " + token;
    const path = "/api/auth/profile";
    await request(app).get(path).expect(401);
    await request(app).patch(path).expect(401);
    const patch = body => request(app).patch(path).set("Authorization",auth).send(body);
    const details = {name:"Updated Name",email:credentials.email, phone:"+91 98100 12345",pickup_address:{city:"Delhi"},role:"admin"};
    await patch({...details,phone:"invalid"}).expect(400);
    await patch(details).expect(200);
    const email = `new-profile-${key}@example.test`;
    await patch({...details,email}).expect(403);
    await patch({...details,email,currentPassword:"wrong-password"}).expect(403);
    await patch({...details,email,currentPassword:credentials.password}).expect(200);
    const {body:{user:profile}} = await request(app).get(path).set("Authorization",auth).expect(200);
    assert.deepEqual(profile,{id:user.id,name:details.name,email,role:"customer",phone:details.phone,pickup_address:details.pickup_address});
    await request(app).post("/api/auth/login").send(credentials).expect(401);
    await request(app).post("/api/auth/login").send({...credentials,email}).expect(200);
  } finally {
    await pool.query("DELETE FROM users WHERE id=$1", [user.id]);
  }
});

test("product updates invalidate Redis and concurrent stock deductions serialize", {
  skip: !process.env.TEST_REDIS_URL,
}, async () => {
  const jwt = require("jsonwebtoken");
  const suffix = randomUUID();
  const category = await pool.query("INSERT INTO categories(name) VALUES ($1) RETURNING id", [suffix]);
  const categoryId = category.rows[0].id;
  let userId;
  let productId;
  try {
    assert.equal(await redis.connectRedis(), true);
    const user = await pool.query(
      "INSERT INTO users(name, email, password_hash, role) VALUES ($1, $2, $3, 'admin') RETURNING id",
      ["Stock Test", suffix + "@example.test", "unused"],
    );
    userId = user.rows[0].id;
    const auth = `Bearer ${jwt.sign({ sub: userId, role: "admin" }, process.env.JWT_SECRET)}`;
    const created = await request(app).post("/api/products").set("Authorization", auth)
      .send({ category_id: categoryId, name: "Original", sku: suffix, price: 10 }).expect(201);
    productId = created.body.product.id;
    const path = `/api/products/${productId}`;
    await request(app).get(path).set("Authorization", auth).expect(200);
    const version = await redis.client.get(CATALOG_VERSION_KEY);
    const cached = await redis.client.get(`products:detail:v1:version:${version}:${productId}`);
    assert.equal(JSON.parse(cached).name, "Original");
    await request(app).patch(path).set("Authorization", auth).send({ name: "Updated" }).expect(200);
    assert.notEqual(await redis.client.get(CATALOG_VERSION_KEY), version);
    const updated = await request(app).get(path).set("Authorization", auth).expect(200);
    assert.equal(updated.body.product.name, "Updated");

    const stock = `/api/inventory/${productId}`;
    const adjust = action => request(app).patch(`${stock}/${action}`).set("Authorization", auth).send({ quantity: 1 });
    await adjust("increase").expect(200);
    const deductions = await Promise.all([adjust("decrease"), adjust("decrease")]);
    assert.deepEqual(deductions.map(r => r.status).sort(), [200, 409]);
    const current = await request(app).get(stock).set("Authorization", auth).expect(200);
    assert.equal(current.body.inventory.quantity, 0);
    const history = await request(app).get("/api/inventory/history").query({ productId })
      .set("Authorization", auth).expect(200);
    assert.equal(history.body.transactions.length, 2);
  } finally {
    await redis.closeRedis();
    await pool.query("DELETE FROM inventory_transactions WHERE product_id = $1", [productId]);
    await pool.query("DELETE FROM inventory WHERE product_id = $1", [productId]);
    await pool.query("DELETE FROM products WHERE id = $1", [productId]);
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    await pool.query("DELETE FROM categories WHERE id = $1", [categoryId]);
  }
});
