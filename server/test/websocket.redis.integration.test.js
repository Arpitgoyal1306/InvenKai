const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once, EventEmitter } = require("node:events");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("node:crypto");
const request = require("supertest");
const app = require("../src/app");
const WebSocket = require("ws");

const redis = require("../src/config/redis");

const { createWebSocketService } = require("../src/services/websocket.service");

const pool = require("../src/config/database");

after(() => pool.end());

const ORIGIN = process.env.CLIENT_URL || "http://localhost:5173";

async function inventoryEvent(socket, operation, timeoutMs = 5000) {
  const controller = new AbortController();
  const waitingFor = `inventory.updated after ${operation}`;
  const onClose = () => controller.abort(new Error(`Socket closed while waiting for ${waitingFor}`));
  socket.once("close", onClose);
  const timer = setTimeout(() => {
    controller.abort(new Error(`Timed out after ${timeoutMs} ms waiting for ${waitingFor}`));
  }, timeoutMs);
  try {
    const [message] = await once(socket, "message", { signal: controller.signal });
    return JSON.parse(message);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    socket.off("close", onClose);
  }
}

async function withCleanup(run, diagnostic) {
  const cleanups = [];
  let primaryError;
  try {
    await run(cleanup => cleanups.push(cleanup));
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const errors = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      if (!primaryError) throw new AggregateError(errors, "WebSocket integration cleanup failed");
      for (const error of errors) diagnostic(`Cleanup also failed: ${error.message}`);
    }
  }
}

test("inventory event deadline identifies the operation and removes event listeners", async () => {
  const socket = new EventEmitter();
  await assert.rejects(inventoryEvent(socket, "checkout", 10), /waiting for inventory.updated after checkout/);
  assert.equal(socket.listenerCount("error"), 0);
  assert.equal(socket.listenerCount("message"), 0);
  assert.equal(socket.listenerCount("close"), 0);
});

test("integration cleanup runs every release on success and preserves a failed assertion", async () => {
  for (const fail of [false, true]) {
    const released = [];
    const diagnostics = [];
    const primary = new assert.AssertionError({ message: "stock mismatch" });
    const result = withCleanup(async register => {
      register(() => released.push("database"));
      register(() => {
        released.push("redis");
        if (fail) throw new Error("close failed");
      });
      register(() => released.push("socket"));
      if (fail) throw primary;
    }, message => diagnostics.push(message));
    if (fail) await assert.rejects(result, error => error === primary);
    else await result;
    assert.deepEqual(released, ["socket", "redis", "database"]);
    assert.equal(diagnostics.length, Number(fail));
  }
});

for (const exerciseFailure of [false, true]) {
  const name = exerciseFailure
    ? "releases live resources after a missing inventory event"
    : "delivers inventory events through real Redis Pub/Sub";
  test(name, { skip: !process.env.TEST_REDIS_URL }, async t => {
    assert.equal(process.env.NODE_ENV, "test");
    let verifyReleased;
    const workflow = withCleanup(async register => {
      await pool.verifyDatabaseIdentity();
      register(() => redis.closeRedis());
      const connected = await redis.connectRedis();

      assert.equal(connected, true);

      const publisher = redis.client;

      const service = createWebSocketService({
        getRedisClient: () => publisher,
        allowedOrigin: ORIGIN,
      });

      const server = http.createServer();
      register(() => server.listening && new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      }));
      register(() => service.close());
      service.attach(server);

      server.listen(0, "127.0.0.1");
      await once(server, "listening");

      const address = server.address();
      const url = `ws://127.0.0.1:${address.port}/ws`;

      // Start the dedicated Redis subscriber before publishing.
      assert.equal(await service.startSubscriber(), true);

      const suffix = randomUUID();
      const user = await pool.query(
        "INSERT INTO users(name, email, password_hash, role) VALUES ($1, $2, $3, 'admin') RETURNING id",
        ["Socket Test", suffix + "@example.test", "unused"],
      );
      const userId = user.rows[0].id;
      register(() => pool.query("DELETE FROM users WHERE id = $1", [userId]));
      const category = await pool.query("INSERT INTO categories(name) VALUES ($1) RETURNING id", [suffix]);
      const categoryId = category.rows[0].id;
      register(() => pool.query("DELETE FROM categories WHERE id = $1", [categoryId]));
      const token = jwt.sign({ sub: userId, role: "admin" }, process.env.JWT_SECRET);
      const product = await request(app).post("/api/products").set("Authorization", `Bearer ${token}`)
        .send({ category_id: categoryId, name: "Socket stock", sku: suffix, price: 5 }).expect(201);
      const productId = product.body.product.id;
      register(() => pool.query("DELETE FROM products WHERE id = $1", [productId]));
      register(() => pool.query("DELETE FROM inventory WHERE product_id = $1", [productId]));
      register(() => pool.query("DELETE FROM orders WHERE user_id = $1", [userId]));
      register(() => pool.query("DELETE FROM inventory_transactions WHERE product_id = $1", [productId]));
      const { body } = await request(app)
        .post("/api/auth/ws-ticket")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const socket = new WebSocket(`${url}?ticket=${body.ticket}`, {
        headers: {
          Origin: ORIGIN,
        },
      });

      register(async () => {
        if (socket.readyState === WebSocket.CLOSED) return;
        const closed = new Promise(resolve => socket.once("close", resolve));
        socket.on("error", () => {}); // Terminating a connecting socket emits an error.
        socket.terminate();
        await closed;
      });
      await once(socket, "open");

      verifyReleased = async () => {
        assert.equal(socket.readyState, WebSocket.CLOSED);
        assert.equal(server.listening, false);
        assert.equal(publisher.isOpen, false);
        const remaining = await pool.query(
          "SELECT id FROM users WHERE id = $1 UNION ALL SELECT id FROM products WHERE id = $2 UNION ALL SELECT id FROM categories WHERE id = $3",
          [userId, productId, categoryId],
        );
        assert.equal(remaining.rowCount, 0);
      };
      if (exerciseFailure) {
        await inventoryEvent(socket, "deliberately omitted update", 25);
        return;
      }

      const [event] = await Promise.all([
        inventoryEvent(socket, "manual stock increase"),
        request(app).patch(`/api/inventory/${productId}/increase`)
          .set("Authorization", `Bearer ${token}`).send({ quantity: 12 }).expect(200),
      ]);
      assert.equal(event.type, "inventory.updated");
      assert.deepEqual(event.data, { productId: Number(productId), quantity: 12 });
      assert.ok(Number.isFinite(Date.parse(event.timestamp)));

      const [checkoutEvent] = await Promise.all([
        inventoryEvent(socket, "checkout"),
        request(app).post("/api/orders").set("Authorization", `Bearer ${token}`)
          .send({ items: [{ productId, quantity: 2 }] }).expect(201),
      ]);
      assert.equal(checkoutEvent.type, "inventory.updated");
      assert.deepEqual(checkoutEvent.data, { productId: Number(productId), quantity: 10 });
    }, message => t.diagnostic(message));
    if (exerciseFailure) {
      await assert.rejects(workflow, /waiting for inventory.updated after deliberately omitted update/);
    } else {
      await workflow;
    }
    await verifyReleased();
  });
}
