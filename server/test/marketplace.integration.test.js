const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const db = require("../src/config/database");
const app = require("../src/app");

test("store publication, private inventory and fulfillment stay scoped to their owners", async (t) => {
  assert.equal(process.env.NODE_ENV, "test");
  const key = randomUUID(),
    client = await db.connect();
  // All HTTP requests in this test use one outer transaction. Service-level
  // transactions use savepoints so failures can exercise real rollback.
  await client.query("BEGIN");
  const query = (sql, params) => client.query(sql, params);
  const nested = {
    query: (sql, params) =>
      query(
        {
          BEGIN: "SAVEPOINT market_service",
          COMMIT: "RELEASE SAVEPOINT market_service",
          ROLLBACK: "ROLLBACK TO SAVEPOINT market_service",
        }[sql] || sql,
        params,
      ),
    release() {},
  };
  t.mock.method(db, "query", query);
  t.mock.method(db, "connect", async () => nested);
  try {
    const accounts = [];
    for (const name of ["Owner A", "Owner B", "Buyer"]) {
      const { rows } = await query(
        "INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,'test','customer') RETURNING id",
        [name, name.replace(" ", "") + key + "@example.test"],
      );
      accounts.push(
        "Bearer " +
          jwt.sign(
            { sub: rows[0].id, role: "customer" },
            process.env.JWT_SECRET,
          ),
      );
    }
    const [a, b, buyer] = accounts;
    const call = (method, path, token, body) => {
      const r = request(app)[method]("/api" + path);
      if (token) r.set("Authorization", token);
      return body ? r.send(body) : r;
    };
    await call("get", "/market/owner/categories").expect(401);
    assert.ok(
      (
        await call("get", "/market/owner/categories", a).expect(200)
      ).body.categories.includes("Home goods"),
    );
    const searchPath =
      "/market/stores?q=" +
      encodeURIComponent(("wORKsHoP_% " + key).toUpperCase());
    for (const [prefix, token] of [
      ["a", a],
      ["b", b],
    ]) {
      await call("put", "/market/owner", token, {
        name: prefix + " Workshop_% " + key,
        slug: prefix + key,
        description: "",
        category: "Food",
        contact: "Pickup desk",
        pickup: "Front counter",
      }).expect(200);
    }
    const store = "/market/stores/a" + key;
    await call("get", store).expect(404);
    assert.deepEqual((await call("get", searchPath)).body.stores, []);
    const {
      body: { id },
    } = await call("post", "/market/owner/products", a, {
      name: "Cup",
      category: key,
      description: "",
      price: 5,
      quantity: 2,
    }).expect(201);
    await call("post", "/market/owner/products/" + id + "/stock", b, {
      delta: 2,
    }).expect(404);
    await call("get", "/market/owner/products", b).expect(200, {
      products: [],
    });
    await call("put", "/market/owner/publication", a, {
      published: true,
    }).expect(200);
    const found = (await call("get", searchPath + "&category=food").expect(200))
      .body;
    assert.deepEqual(
      found.stores.map((s) => s.slug),
      ["a" + key],
    );
    assert.ok(found.categories.includes("Food"));
    assert.deepEqual(
      (await call("get", searchPath + "&category=Other")).body.stores,
      [],
    );
    assert.deepEqual(
      (
        await call(
          "get",
          "/market/stores?q=" + encodeURIComponent("Workshop_%X" + key),
        )
      ).body.stores,
      [],
    );
    const archived = (
      await call("post", "/market/owner/products", a, {
        name: "Old cup",
        category: key,
        description: "",
        price: 2,
        quantity: 1,
      }).expect(201)
    ).body.id;
    await call(
      "patch",
      "/market/owner/products/" + archived + "/visibility",
      a,
      { archived: true },
    ).expect(204);
    const secondProduct = (
      await call("post", "/market/owner/products", b, {
        name: "Second seller item",
        category: "Food",
        description: "",
        price: 8,
        quantity: 0,
      }).expect(201)
    ).body.id;
    await call("put", "/market/owner/publication", b, {
      published: true,
    }).expect(200);
    const directory = (await call("get", searchPath).expect(200)).body.stores;
    assert.deepEqual(
      directory.map((s) => s.products),
      [
        [{ id, name: "Cup", price: "5.00", quantity: 2 }],
        [
          {
            id: secondProduct,
            name: "Second seller item",
            price: "8.00",
            quantity: 0,
          },
        ],
      ],
    );
    const storefront = (
      await call("get", "/market/stores/" + found.stores[0].slug).expect(200)
    ).body;
    assert.deepEqual(
      storefront.products.map((p) => p.id),
      [id],
    );
    assert.equal(storefront.products[0].category, key);
    assert.ok(
      (
        await call("get", "/market/owner/categories", a)
      ).body.categories.includes(key),
    );
    assert.ok(
      !(
        await call("get", "/market/owner/categories", b)
      ).body.categories.includes(key),
    );
    const buyerDetails = {
      name: "Pickup Buyer",
      phone: "+1 415 555 0199",
      address: "21 Market Road",
      city: "Portland",
      region: "Oregon",
      postalCode: "97201",
      country: "US",
    };
    await call("post", store + "/orders", buyer, {
      items: [{ productId: id, price: 5, quantity: 1 }],
    }).expect(400);
    for (const [price, quantity, status] of [
      [4, 1, 409],
      [5, 3, 409],
    ]) {
      await call("post", store + "/orders", buyer, {
        items: [{ productId: id, price, quantity }],
        buyerDetails,
      }).expect(status);
    }
    const checkout = () =>
      call("post", store + "/orders", buyer, {
        items: [{ productId: id, price: 5, quantity: 2 }],
        buyerDetails,
      }).set("Idempotency-Key", key);
    const firstCheckout = await checkout().expect(201);
    const replay = await checkout().expect(201);
    assert.deepEqual(replay.body, firstCheckout.body);
    const {
      body: { orders },
    } = await call("get", "/market/owner/orders", a).expect(200);
    assert.equal(orders.length, 1);
    const detail = "/market/owner/orders/" + orders[0].id;
    assert.deepEqual(
      (await call("get", detail, a)).body.order.buyer_details,
      buyerDetails,
    );
    await call("get", detail, b).expect(404);
    await call("get", "/market/purchases", b).expect(200, { orders: [] });
    await call("patch", detail, a, { status: "processing" }).expect(204);
    assert.equal(
      (await call("get", "/market/purchases", buyer)).body.orders[0].status,
      "processing",
    );
    await call("get", "/reports/stock-summary", b).expect(403);
    await call("post", "/auth/ws-ticket", b, {}).expect(403);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
