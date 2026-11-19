const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createWebSocketTicketService,
  TICKET_TTL_SECONDS,
} = require("../src/services/websocket-ticket.service");


function createMockRedis() {
  const store = new Map();

  return {
    isReady: true,
    store,

    async set(key, value, options) {
      assert.equal(options.EX, TICKET_TTL_SECONDS);
      assert.equal(options.NX, true);

      if (store.has(key)) {
        return null;
      }

      store.set(key, {
        value,
        expiresAt: Date.now() + options.EX * 1000,
      });

      return "OK";
    },

    async eval(_script, { keys }) {
      const key = keys[0];
      const entry = store.get(key);

      if (!entry) {
        return null;
      }

      if (Date.now() >= entry.expiresAt) {
        store.delete(key);
        return null;
      }

      store.delete(key);
      return entry.value;
    },

    expireAll() {
      for (const entry of store.values()) {
        entry.expiresAt = 0;
      }
    },
  };
}


test("rejects a ticket after its TTL expires", async () => {
  const client = createMockRedis();

  const service = createWebSocketTicketService({
    getRedisClient: () => client,
  });

  const issued = await service.issueTicket({
    userId: "42",
    role: "inventory_manager",
  });

  client.expireAll();

  assert.equal(await service.consumeTicket(issued.ticket), null);
});


test("issues a ticket for an authorized inventory manager", async () => {
  const client = createMockRedis();

  const service = createWebSocketTicketService({
    getRedisClient: () => client,
  });

  const result = await service.issueTicket({
    userId: "42",
    role: "inventory_manager",
  });

  assert.equal(typeof result.ticket, "string");
  assert.match(result.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.expiresIn, 30);
  assert.equal(client.store.size, 1);
});

test("issues a ticket for an admin", async () => {
  const client = createMockRedis();

  const service = createWebSocketTicketService({
    getRedisClient: () => client,
  });

  const result = await service.issueTicket({
    userId: "7",
    role: "admin",
  });

  assert.equal(typeof result.ticket, "string");
});

test("rejects customers from obtaining a ticket", async () => {
  const service = createWebSocketTicketService({
    getRedisClient: () => createMockRedis(),
  });

  await assert.rejects(
    service.issueTicket({
      userId: "42",
      role: "customer",
    }),
    { statusCode: 403 },
  );
});

test("fails closed when Redis is unavailable", async () => {
  const service = createWebSocketTicketService({
    getRedisClient: () => null,
  });

  await assert.rejects(
    service.issueTicket({
      userId: "42",
      role: "admin",
    }),
    { statusCode: 503 },
  );
});

test("consumes a valid ticket exactly once", async () => {
  const client = createMockRedis();

  const service = createWebSocketTicketService({
    getRedisClient: () => client,
  });

  const issued = await service.issueTicket({
    userId: "42",
    role: "inventory_manager",
  });

  const consumed = await service.consumeTicket(issued.ticket);

  assert.deepEqual(consumed, {
    userId: "42",
    role: "inventory_manager",
  });

  assert.equal(await service.consumeTicket(issued.ticket), null);
});

test("rejects malformed tickets", async () => {
  const service = createWebSocketTicketService({
    getRedisClient: () => createMockRedis(),
  });

  assert.equal(await service.consumeTicket("invalid-ticket"), null);
});

test("only one concurrent consumer can use a ticket", async () => {
  const client = createMockRedis();

  const service = createWebSocketTicketService({
    getRedisClient: () => client,
  });

  const issued = await service.issueTicket({
    userId: "42",
    role: "admin",
  });

  const results = await Promise.all([
    service.consumeTicket(issued.ticket),
    service.consumeTicket(issued.ticket),
  ]);

  const successful = results.filter(Boolean);

  assert.equal(successful.length, 1);
});
