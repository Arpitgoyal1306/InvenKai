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
    const empty = await call("get", "/market/owner/products", b).expect(200);
    assert.deepEqual(empty.body.products, []);
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
    assert.deepEqual(
      (await call("get", "/market/purchases", b).expect(200)).body.orders,
      [],
    );
    await call("patch", detail, a, { status: "processing" }).expect(204);
    assert.equal(
      (await call("get", "/market/purchases", buyer)).body.orders[0].status,
      "processing",
    );
    for (const [offset, expected, hasMore] of [
      [0, "a", true],
      [1, "b", false],
    ]) {
      const page = (
        await call("get", searchPath + `&limit=1&offset=${offset}`).expect(200)
      ).body;
      assert.deepEqual(
        page.stores.map((s) => s.slug),
        [expected + key],
      );
      assert.deepEqual(page.pagination, { limit: 1, offset, hasMore });
    }
    const ownerProducts = (
      await call("get", "/market/owner/products?limit=1&offset=1", a).expect(
        200,
      )
    ).body;
    assert.deepEqual(
      ownerProducts.products.map((p) => p.id),
      [id],
    );
    assert.equal(ownerProducts.pagination.hasMore, false);
    const filteredProducts = (
      await call("get", store + "?q=CUP&limit=1").expect(200)
    ).body;
    assert.deepEqual(
      filteredProducts.products.map((p) => p.id),
      [id],
    );
    const quote = (
      await call(
        "get",
        store + `/cart-products?ids=${id},${secondProduct},${archived}`,
      ).expect(200)
    ).body;
    assert.deepEqual(
      quote.products.map((p) => [p.id, p.quantity]),
      [[id, 0]],
    );
    const ownerOrders = await call(
      "get",
      `/market/owner/orders?limit=1&q=${orders[0].id}&status=processing`,
      a,
    ).expect(200);
    assert.deepEqual(
      ownerOrders.body.orders.map((o) => o.id),
      [orders[0].id],
    );
    const filteredDay = new Date().toISOString().slice(0, 10);
    const dated = await call(
      "get",
      "/market/owner/orders?date=" + filteredDay,
      a,
    ).expect(200);
    assert.deepEqual(
      dated.body.orders.map((o) => o.id),
      [orders[0].id],
    );
    for (const [path, token] of [
      ["/market/owner/orders", a],
      ["/market/purchases", buyer],
    ]) {
      const page = await call("get", path + "?limit=1&offset=1", token).expect(
        200,
      );
      assert.deepEqual(page.body.orders, []);
      assert.equal(page.body.pagination.hasMore, false);
      await call("get", path + "?limit=101", token).expect(400);
    }
    const summary = (await call("get", "/market/owner/summary", a).expect(200))
      .body;
    assert.equal(summary.lowProducts, 1);
    assert.equal(summary.activeProducts, 1);
    assert.equal(summary.newOrders, 0);
    assert.equal(Number(summary.sales), 10);

    await t.test(
      "owner history reaches past the first 100 scoped rows",
      async () => {
        await query(
          `INSERT INTO inventory_transactions
           (product_id, transaction_type, quantity, quantity_before, quantity_after)
         SELECT $1, 'increase', 1, n - 1, n FROM generate_series(1, 102) n`,
          [id],
        );
        const path = "/market/owner/history";
        await call("get", path).expect(401);
        const { body: first } = await call("get", path, a).expect(200);
        assert.equal(first.history.length, 20);
        assert.deepEqual(first.pagination, {
          limit: 20,
          offset: 0,
          hasMore: true,
        });
        const window = "?limit=2&offset=100";
        const { body: older } = await call("get", path + window, a).expect(200);
        assert.deepEqual(
          older.history.map((row) => [row.name, row.quantity_after]),
          [
            ["Cup", 2],
            ["Cup", 1],
          ],
        );
        assert.deepEqual(older.pagination, {
          limit: 2,
          offset: 100,
          hasMore: true,
        });
        const { body: secondSeller } = await call(
          "get",
          path + window,
          b,
        ).expect(200);
        assert.deepEqual(secondSeller.history, []);
        assert.equal(secondSeller.pagination.hasMore, false);
        await call("get", path + "?limit=101", a).expect(400);
        await call("get", path + "?offset=-1", a).expect(400);
      },
    );

    await t.test(
      "warehouse stock, suppliers and reports stay separate from seller inventory",
      async () => {
        await call(
          "post",
          "/market/owner/products/" + secondProduct + "/stock",
          b,
          { delta: 4 },
        ).expect(204);
        const staffId = (
          await query(
            "INSERT INTO users(name,email,password_hash,role) VALUES('Warehouse Staff',$1,'test','inventory_manager') RETURNING id",
            [key + "@example.test"],
          )
        ).rows[0].id;
        const staff =
          "Bearer " +
          jwt.sign(
            { sub: staffId, role: "inventory_manager" },
            process.env.JWT_SECRET,
          );
        const categoryId = (
          await query("SELECT id FROM categories WHERE name=$1", [key])
        ).rows[0].id;
        const stockBefore = (
          await call("get", "/reports/stock-summary", staff).expect(200)
        ).body;
        const movementPath =
          "/reports/stock-movement?startDate=" +
          filteredDay +
          "&endDate=" +
          filteredDay;
        const movementBefore = (
          await call("get", movementPath, staff).expect(200)
        ).body;
        const central = (
          await call("post", "/products", staff, {
            category_id: categoryId,
            name: "Warehouse cup",
            sku: key,
            price: 10,
            low_stock_threshold: 5,
          }).expect(201)
        ).body.product.id;
        await call("patch", "/inventory/" + id + "/increase", staff, {
          quantity: 3,
        }).expect(404);
        await call(
          "patch",
          "/inventory/" + secondProduct + "/decrease",
          staff,
          { quantity: 1 },
        ).expect(409);
        await call("get", "/inventory/" + id, staff).expect(404);
        const sellerStock = (
          await query("SELECT quantity FROM inventory WHERE product_id=$1", [
            secondProduct,
          ])
        ).rows[0];
        assert.equal(sellerStock.quantity, 4);
        await call("patch", "/inventory/" + central + "/increase", staff, {
          quantity: 3,
        }).expect(200);
        const stock = (
          await call("get", "/reports/stock-summary", staff).expect(200)
        ).body;
        assert.equal(stock.product_count, stockBefore.product_count + 1);
        assert.equal(
          stock.total_stock_quantity,
          stockBefore.total_stock_quantity + 3,
        );
        const category = (
          await call(
            "get",
            "/reports/category-stock?categoryId=" + categoryId,
            staff,
          ).expect(200)
        ).body.categories[0];
        assert.equal(category.product_count, 1);
        assert.equal(category.total_stock_quantity, 3);
        const low = (await call("get", "/reports/low-stock", staff).expect(200))
          .body;
        assert.ok(low.products.some((p) => p.product_id === central));
        assert.ok(
          !low.products.some(
            (p) => p.product_id === id || p.product_id === archived,
          ),
        );
        const history = (
          await call("get", "/inventory/history?productId=" + id, staff).expect(
            200,
          )
        ).body;
        assert.deepEqual(history.transactions, []);
        const movement = (await call("get", movementPath, staff).expect(200))
          .body;
        assert.equal(movement.total_added, movementBefore.total_added + 3);
        assert.equal(movement.total_removed, movementBefore.total_removed);
        const supplierId = (
          await query(
            "INSERT INTO suppliers(name,email) VALUES($1,$2) RETURNING id",
            [key, key + "@supplier.example.test"],
          )
        ).rows[0].id;
        const association = "/suppliers/" + supplierId + "/products";
        await call("put", association + "/" + secondProduct, staff).expect(404);
        await call("put", association + "/" + central, staff).expect(204);
        await call("put", association + "/" + central, staff).expect(204);
        const linked = await call(
          "get",
          association + "?linked=true",
          staff,
        ).expect(200);
        assert.deepEqual(
          linked.body.products.map((p) => p.id),
          [central],
        );

        await query("UPDATE products SET archived=true WHERE id=$1", [central]);
        await call("get", "/inventory/" + central, staff).expect(404);
        const archivedHistory = await call(
          "get",
          "/inventory/history?productId=" + central,
          staff,
        ).expect(200);
        assert.equal(archivedHistory.body.transactions.length, 1);
        const archivedSummary = await call(
          "get",
          "/reports/stock-summary",
          staff,
        ).expect(200);
        assert.deepEqual(archivedSummary.body, stockBefore);
      },
    );

    await call("get", "/reports/stock-summary", b).expect(403);
    await call("post", "/auth/ws-ticket", b, {}).expect(403);

    const receiptPath = "/orders/" + orders[0].id + "/receipt";
    await call("post", receiptPath).expect(401);
    await call("post", receiptPath, a).expect(404);
    const pending = await call("get", receiptPath, buyer).expect(200);
    assert.deepEqual(pending.body, { receipt: null });
    const issued = await call("post", receiptPath, buyer).expect(200);
    assert.equal(issued.body.receipt.receipt_number, "INV-" + orders[0].id);
    assert.equal(issued.body.receipt.items[0].productName, "Cup");
    assert.deepEqual(
      (await call("post", receiptPath, buyer).expect(200)).body,
      issued.body,
    );
    assert.deepEqual(
      (await call("get", receiptPath, buyer).expect(200)).body,
      issued.body,
    );

    const productPath = "/market/owner/products/" + id;
    const editedProduct = {
      name: "Updated cup",
      description: "",
      category: key,
      price: 5,
    };
    const photo =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPioAAAAASUVORK5CYII=";
    await call("put", productPath, a, { ...editedProduct, photo }).expect(200);
    await call("put", productPath, a, editedProduct).expect(200);
    const productsAfterEdit = await call("get", store).expect(200);
    assert.equal(productsAfterEdit.body.products[0].photo, photo);

    await call("delete", productPath, b).expect(404);
    await call("delete", productPath, a).expect(204);
    await call("patch", productPath + "/visibility", a, {
      archived: false,
    }).expect(404);
    await call("put", productPath, a, editedProduct).expect(404);
    await call("post", productPath + "/stock", a, { delta: 2 }).expect(404);
    const ownerList = await call("get", "/market/owner/products", a).expect(
      200,
    );
    assert.ok(!ownerList.body.products.some((product) => product.id === id));
    assert.deepEqual((await call("get", store).expect(200)).body.products, []);
    assert.deepEqual(
      (await call("get", store + "/cart-products?ids=" + id).expect(200)).body
        .products,
      [],
    );
    const deletedHistory = await call("get", "/market/owner/history", a).expect(
      200,
    );
    assert.ok(
      deletedHistory.body.history.some(
        (row) => row.name === editedProduct.name,
      ),
    );
    assert.deepEqual(
      (await call("get", receiptPath, buyer).expect(200)).body,
      issued.body,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
