
const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createOrderOutboxDispatcher,
} = require("../src/services/order-outbox-dispatcher.service");

function createMocks({
  redisInitiallyReady = true,
  redisConnectResults = [true],
  events = [],
  failMarkDispatched = false,
} = {}) {
  const queries = [];
  const enqueuedOrders = [];
  const queueCloseCount = { value: 0 };

  let redisReady = redisInitiallyReady;
  let redisConnectCalls = 0;
  let markDispatchedCalls = 0;

  const db = {
    async query(sql, params) {
      queries.push({ sql, params });

      if (sql.includes("WITH candidates AS")) {
        return { rows: events };
      }

      if (sql.includes("SET status = 'dispatched'")) {
        markDispatchedCalls += 1;

        if (failMarkDispatched && markDispatchedCalls === 1) {
          throw new Error("Database update failed");
        }

        return { rows: [] };
      }

      if (sql.includes("SET status = 'pending'")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const redisManager = {
    isRedisReady() {
      return redisReady;
    },

    async connectRedis() {
      const result =
        redisConnectResults[redisConnectCalls] ?? false;

      redisConnectCalls += 1;
      redisReady = result;

      return result;
    },
  };

  async function createQueue() {
    return {
      async enqueueOrderReceipt(orderId) {
        enqueuedOrders.push(String(orderId));
      },

      async close() {
        queueCloseCount.value += 1;
      },
    };
  }

  return {
    db,
    redisManager,
    createQueue,
    queries,
    enqueuedOrders,
    queueCloseCount,

    get redisConnectCalls() {
      return redisConnectCalls;
    },

    get markDispatchedCalls() {
      return markDispatchedCalls;
    },
  };
}

test("dispatcher recovers when Redis becomes available", async () => {
  const mocks = createMocks({
    redisInitiallyReady: false,
    redisConnectResults: [false, true],
    events: [
      {
        id: "1",
        order_id: "101",
        payload: { orderId: "101" },
        attempts: 1,
      },
    ],
  });

  const dispatcher = createOrderOutboxDispatcher({
    db: mocks.db,
    redisManager: mocks.redisManager,
    createQueue: mocks.createQueue,
  });

  // First attempt: Redis is unavailable.
  const firstResult = await dispatcher.dispatchBatch();

  assert.deepEqual(firstResult, {
    claimed: 1,
    dispatched: 0,
    failed: 1,
  });

  assert.deepEqual(mocks.enqueuedOrders, []);

  // Simulate the event becoming eligible for another attempt.
  const secondResult = await dispatcher.dispatchBatch();

  assert.deepEqual(secondResult, {
    claimed: 1,
    dispatched: 1,
    failed: 0,
  });

  assert.deepEqual(mocks.enqueuedOrders, ["101"]);
  assert.equal(mocks.redisConnectCalls, 2);

  await dispatcher.close();
});

test("releases event when marking dispatched fails after enqueue", async () => {
  const mocks = createMocks({
    failMarkDispatched: true,
    events: [
      {
        id: "1",
        order_id: "101",
        payload: { orderId: "101" },
        attempts: 1,
      },
    ],
  });

  const dispatcher = createOrderOutboxDispatcher({
    db: mocks.db,
    redisManager: mocks.redisManager,
    createQueue: mocks.createQueue,
  });

  const result = await dispatcher.dispatchBatch();

  assert.deepEqual(result, {
    claimed: 1,
    dispatched: 0,
    failed: 1,
  });

  // Redis received the job even though the database update failed.
  assert.deepEqual(mocks.enqueuedOrders, ["101"]);

  assert.ok(
    mocks.queries.some((query) =>
      query.sql.includes("SET status = 'pending'"),
    ),
  );

  assert.equal(mocks.queueCloseCount.value, 1);

  await dispatcher.close();
});

test("reclaims expired processing events", async () => {
  const mocks = createMocks({
    events: [
      {
        id: "5",
        order_id: "205",
        payload: { orderId: "205" },
        attempts: 3,
      },
    ],
  });

  const dispatcher = createOrderOutboxDispatcher({
    db: mocks.db,
    redisManager: mocks.redisManager,
    createQueue: mocks.createQueue,
  });

  const result = await dispatcher.dispatchBatch();

  assert.deepEqual(result, {
    claimed: 1,
    dispatched: 1,
    failed: 0,
  });

  const claimQuery = mocks.queries.find((query) =>
    query.sql.includes("WITH candidates AS"),
  );

  assert.match(claimQuery.sql, /status = 'pending'/);
  assert.match(claimQuery.sql, /status = 'processing'/);
  assert.match(claimQuery.sql, /locked_until < CURRENT_TIMESTAMP/);
  assert.match(claimQuery.sql, /FOR UPDATE SKIP LOCKED/);

  assert.deepEqual(mocks.enqueuedOrders, ["205"]);

  await dispatcher.close();
});

test("uses exponential retry scheduling and records the error", async () => {
  const mocks = createMocks({
    events: [
      {
        id: "8",
        order_id: "308",
        payload: { orderId: "308" },
        attempts: 4,
      },
    ],
  });

  const dispatcher = createOrderOutboxDispatcher({
    db: mocks.db,
    redisManager: {
      isRedisReady() {
        return true;
      },
      async connectRedis() {
        return true;
      },
    },
    createQueue: async () => ({
      async enqueueOrderReceipt() {
        throw new Error("Temporary Redis failure");
      },
      async close() {},
    }),
  });

  const result = await dispatcher.dispatchBatch();

  assert.deepEqual(result, {
    claimed: 1,
    dispatched: 0,
    failed: 1,
  });

  const retryQuery = mocks.queries.find((query) =>
    query.sql.includes("SET status = 'pending'"),
  );

  assert.ok(retryQuery);
  assert.match(retryQuery.sql, /POWER\(2, attempts\)/);
  assert.match(retryQuery.sql, /LEAST/);
  assert.equal(retryQuery.params[0], "8");
  assert.equal(retryQuery.params[1], "Temporary Redis failure");

  await dispatcher.close();
});
