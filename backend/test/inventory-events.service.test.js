const test = require("node:test");
const assert = require("node:assert/strict");

const {
  INVENTORY_CHANNEL,
  createInventoryEventPublisher,
} = require("../src/services/inventory-events.service");

test("publishes inventory event when Redis is ready", async () => {
  let publishedChannel;
  let publishedMessage;

  const publisher = createInventoryEventPublisher({
    getRedisClient: () => ({
      isReady: true,
      publish: async (channel, message) => {
        publishedChannel = channel;
        publishedMessage = message;
      },
    }),
    now: () => new Date("2026-11-13T10:00:00.000Z"),
  });

  const result = await publisher.publishInventoryUpdated({
    productId: 42,
    quantity: 9,
  });

  assert.equal(result, true);
  assert.equal(publishedChannel, INVENTORY_CHANNEL);

  assert.deepEqual(JSON.parse(publishedMessage), {
    type: "inventory.updated",
    data: {
      productId: 42,
      quantity: 9,
    },
    timestamp: "2026-11-13T10:00:00.000Z",
  });
});

test("returns false when Redis is unavailable", async () => {
  const publisher = createInventoryEventPublisher({
    getRedisClient: () => null,
  });

  const result = await publisher.publishInventoryUpdated({
    productId: 42,
    quantity: 9,
  });

  assert.equal(result, false);
});

test("returns false when Redis publish fails", async () => {
  const publisher = createInventoryEventPublisher({
    getRedisClient: () => ({
      isReady: true,
      publish: async () => {
        throw new Error("Redis publish failed");
      },
    }),
    logger: { error: () => {} },
  });

  const result = await publisher.publishInventoryUpdated({
    productId: 42,
    quantity: 9,
  });

  assert.equal(result, false);
});

test("returns false when getting Redis client throws", async () => {
  const publisher = createInventoryEventPublisher({
    getRedisClient: () => {
      throw new Error("Redis unavailable");
    },
    logger: { error: () => {} },
  });

  const result = await publisher.publishInventoryUpdated({
    productId: 42,
    quantity: 9,
  });

  assert.equal(result, false);
});

test("returns false when timestamp generation fails", async () => {
  const publisher = createInventoryEventPublisher({
    getRedisClient: () => ({
      isReady: true,
      publish: async () => {},
    }),
    now: () => {
      throw new Error("Clock unavailable");
    },
    logger: { error: () => {} },
  });

  const result = await publisher.publishInventoryUpdated({
    productId: 42,
    quantity: 9,
  });

  assert.equal(result, false);
});

test("returns false when Redis publish times out", async () => {
  let timeoutCallback;
  let timeoutDuration;
  let clearedTimeout;

  const publisher = createInventoryEventPublisher({
    getRedisClient: () => ({
      isReady: true,
      publish: () => new Promise(() => {}),
    }),
    timeoutMs: 1000,
    setTimeoutFn: (callback, delay) => {
      timeoutCallback = callback;
      timeoutDuration = delay;
      return 123;
    },
    clearTimeoutFn: (timerId) => {
      clearedTimeout = timerId;
    },
    logger: { error: () => {} },
  });

  const resultPromise = publisher.publishInventoryUpdated({
    productId: 42,
    quantity: 9,
  });

  assert.equal(timeoutDuration, 1000);
  assert.equal(typeof timeoutCallback, "function");

  timeoutCallback();

  const result = await resultPromise;

  assert.equal(result, false);
  assert.equal(clearedTimeout, 123);
});

test("clears the timeout when Redis publish succeeds", async () => {
  let clearedTimeout;

  const publisher = createInventoryEventPublisher({
    getRedisClient: () => ({
      isReady: true,
      publish: async () => 1,
    }),
    setTimeoutFn: () => 456,
    clearTimeoutFn: (timerId) => {
      clearedTimeout = timerId;
    },
  });

  const result = await publisher.publishInventoryUpdated({
    productId: 42,
    quantity: 9,
  });

  assert.equal(result, true);
  assert.equal(clearedTimeout, 456);
});
