const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createOrderOutboxDispatcher,
} = require("../src/services/order-outbox-dispatcher.service");

const TOKEN = "11111111-1111-4111-8111-111111111111";

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
      const result = redisConnectResults[redisConnectCalls] ?? false;
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
    get redisConnectCalls() { return redisConnectCalls; },
    get markDispatchedCalls() { return markDispatchedCalls; },
  };
}

function event(id, orderId, attempts = 1) {
  return {
    id: String(id),
    order_id: String(orderId),
    payload: { orderId: String(orderId) },
    attempts,
    claim_token: TOKEN,
  };
}

test("dispatcher recovers when Redis becomes available", async () => {
  const mocks = createMocks({
    redisInitiallyReady: false,
    redisConnectResults: [false, true],
    events: [event(1, 101)],
  });

  const dispatcher = createOrderOutboxDispatcher({
    db: mocks.db,
    redisManager: mocks.redisManager,
    createQueue: mocks.createQueue,
  });

  const firstResult = await dispatcher.dispatchBatch();
  assert.deepEqual(firstResult, { claimed: 1, dispatched: 0, failed: 1 });
  assert.deepEqual(mocks.enqueuedOrders, []);

  const secondResult = await dispatcher.dispatchBatch();
  assert.deepEqual(secondResult, { claimed: 1, dispatched: 1, failed: 0 });
  assert.deepEqual(mocks.enqueuedOrders, ["101"]);
  assert.equal(mocks.redisConnectCalls, 2);

  await dispatcher.close();
});

test("releases event when marking dispatched fails after enqueue", async () => {
  const mocks = createMocks({
    failMarkDispatched: true,
    events: [event(1, 101)],
  });

  const dispatcher = createOrderOutboxDispatcher({
    db: mocks.db,
    redisManager: mocks.redisManager,
    createQueue: mocks.createQueue,
  });

  const result = await dispatcher.dispatchBatch();

  assert.deepEqual(result, { claimed: 1, dispatched: 0, failed: 1 });
  assert.deepEqual(mocks.enqueuedOrders, ["101"]);
  assert.ok(mocks.queries.some((query) => query.sql.includes("SET status = 'pending'")));
  assert.equal(mocks.queueCloseCount.value, 1);

  const markQuery = mocks.queries.find((query) => query.sql.includes("SET status = 'dispatched'"));
  const retryQuery = mocks.queries.find((query) => query.sql.includes("SET status = 'pending'"));
  assert.match(markQuery.sql, /claim_token = \$2::uuid/);
  assert.match(retryQuery.sql, /claim_token = \$3::uuid/);
  assert.equal(markQuery.params[1], TOKEN);
  assert.equal(retryQuery.params[2], TOKEN);

  await dispatcher.close();
});

test("reclaims expired processing events with a new lease token", async () => {
  const mocks = createMocks({ events: [event(5, 205, 3)] });

  const dispatcher = createOrderOutboxDispatcher({
    db: mocks.db,
    redisManager: mocks.redisManager,
    createQueue: mocks.createQueue,
  });

  const result = await dispatcher.dispatchBatch();
  assert.deepEqual(result, { claimed: 1, dispatched: 1, failed: 0 });
  assert.deepEqual(mocks.enqueuedOrders, ["205"]);

  const claimQuery = mocks.queries.find((query) => query.sql.includes("WITH candidates AS"));
  const markQuery = mocks.queries.find((query) => query.sql.includes("SET status = 'dispatched'"));

  assert.match(claimQuery.sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(claimQuery.sql, /locked_until < CURRENT_TIMESTAMP/);
  assert.match(claimQuery.sql, /claim_token = \$3::uuid/);
  assert.match(markQuery.sql, /claim_token = \$2::uuid/);

  await dispatcher.close();
});

test("uses exponential retry scheduling and records the error", async () => {
  const mocks = createMocks({ events: [event(8, 308, 4)] });

  const dispatcher = createOrderOutboxDispatcher({
    db: mocks.db,
    redisManager: {
      isRedisReady() { return true; },
      async connectRedis() { return true; },
    },
    createQueue: async () => ({
      async enqueueOrderReceipt() { throw new Error("Temporary Redis failure"); },
      async close() {},
    }),
  });

  const result = await dispatcher.dispatchBatch();
  assert.deepEqual(result, { claimed: 1, dispatched: 0, failed: 1 });

  const retryQuery = mocks.queries.find((query) => query.sql.includes("SET status = 'pending'"));
  assert.ok(retryQuery);
  assert.match(retryQuery.sql, /POWER\(2, attempts\)/);
  assert.match(retryQuery.sql, /LEAST/);
  assert.match(retryQuery.sql, /claim_token = \$3::uuid/);
  assert.equal(retryQuery.params[0], "8");
  assert.equal(retryQuery.params[1], "Temporary Redis failure");
  assert.equal(retryQuery.params[2], TOKEN);

  await dispatcher.close();
});

test("does not overwrite an outbox lease reclaimed during a slow enqueue", async () => {
  const queries = [];
  let newClaimWasMade = false;

  const db = {
    async query(sql, params) {
      queries.push({ sql, params });

      if (sql.includes("WITH candidates AS")) {
        return {
          rows: [{
            ...event(15, 415, 2),
            claim_token: TOKEN,
          }],
        };
      }

      if (sql.includes("SET status = 'dispatched'")) {
        assert.notEqual(params[1], "99999999-9999-4999-8999-999999999999");
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes("SET status = 'pending'")) {
        return { rowCount: 0, rows: [] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const dispatcher = createOrderOutboxDispatcher({
    db,
    redisManager: {
      isRedisReady: () => true,
      async connectRedis() { return true; },
    },
    createQueue: async () => ({
      async enqueueOrderReceipt() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        newClaimWasMade = true;
      },
      async close() {},
    }),
  });

  const result = await dispatcher.dispatchBatch();

  assert.deepEqual(result, { claimed: 1, dispatched: 0, failed: 1 });
  assert.equal(newClaimWasMade, true);

  const claimQuery = queries.find((query) => query.sql.includes("WITH candidates AS"));
  const markQuery = queries.find((query) => query.sql.includes("SET status = 'dispatched'"));
  const releaseQuery = queries.find((query) => query.sql.includes("SET status = 'pending'"));

  assert.match(claimQuery.sql, /claim_token = \$3::uuid/);
  assert.match(markQuery.sql, /claim_token = \$2::uuid/);
  assert.equal(releaseQuery, undefined, "a stale dispatcher must not release another dispatcher's claim");

  await dispatcher.close();
});
