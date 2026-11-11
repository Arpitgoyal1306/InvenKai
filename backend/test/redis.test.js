const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createRedisManager } = require("../src/config/redis");

function createMockClient({
  connectError = null,
  initiallyReady = false,
} = {}) {
  const client = new EventEmitter();

  client.isOpen = initiallyReady;
  client.isReady = initiallyReady;
  client.connectCalls = 0;
  client.closeCalls = 0;
  client.destroyCalls = 0;

  client.connect = async () => {
    client.connectCalls++;

    if (connectError) {
      throw connectError;
    }

    client.isOpen = true;
    client.isReady = true;
  };

  client.close = async () => {
    client.closeCalls++;
    client.isOpen = false;
    client.isReady = false;
  };

  client.destroy = () => {
    client.destroyCalls++;
    client.isOpen = false;
    client.isReady = false;
  };

  return client;
}

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

test("does not create a client when REDIS_URL is missing", async () => {
  let createClientCalls = 0;

  const manager = createRedisManager({
    url: "",
    createClientFn: () => {
      createClientCalls++;
    },
    logger: createLogger(),
  });

  const result = await manager.connectRedis();

  assert.equal(result, false);
  assert.equal(createClientCalls, 0);
  assert.equal(manager.client, null);
  assert.equal(manager.isRedisReady(), false);
});

test("creates and connects a Redis client successfully", async () => {
  const mockClient = createMockClient();

  const manager = createRedisManager({
    url: "redis://localhost:6379",
    createClientFn: () => mockClient,
    logger: createLogger(),
  });

  const result = await manager.connectRedis();

  assert.equal(result, true);
  assert.equal(manager.client, mockClient);
  assert.equal(manager.isRedisReady(), true);
  assert.equal(mockClient.connectCalls, 1);
});

test("reuses the same client for repeated connection calls", async () => {
  const mockClient = createMockClient();
  let createClientCalls = 0;

  const manager = createRedisManager({
    url: "redis://localhost:6379",
    createClientFn: () => {
      createClientCalls++;
      return mockClient;
    },
    logger: createLogger(),
  });

  await manager.connectRedis();
  await manager.connectRedis();

  assert.equal(createClientCalls, 1);
  assert.equal(mockClient.connectCalls, 1);
});

test("handles concurrent connection calls without duplicate connections", async () => {
  const mockClient = createMockClient();
  let createClientCalls = 0;

  const manager = createRedisManager({
    url: "redis://localhost:6379",
    createClientFn: () => {
      createClientCalls++;
      return mockClient;
    },
    logger: createLogger(),
  });

  const results = await Promise.all([
    manager.connectRedis(),
    manager.connectRedis(),
    manager.connectRedis(),
  ]);

  assert.deepEqual(results, [true, true, true]);
  assert.equal(createClientCalls, 1);
  assert.equal(mockClient.connectCalls, 1);
});

test("handles initial connection failure without throwing", async () => {
  const mockClient = createMockClient({
    connectError: new Error("Redis unavailable"),
  });

  const manager = createRedisManager({
    url: "redis://localhost:6379",
    createClientFn: () => mockClient,
    logger: createLogger(),
  });

  const result = await manager.connectRedis();

  assert.equal(result, false);
  assert.equal(manager.isRedisReady(), false);
  assert.equal(mockClient.connectCalls, 1);
});

test("registers an error listener on the Redis client", async () => {
  const mockClient = createMockClient();

  const manager = createRedisManager({
    url: "redis://localhost:6379",
    createClientFn: () => mockClient,
    logger: createLogger(),
  });

  await manager.connectRedis();

  assert.ok(mockClient.listenerCount("error") > 0);

  assert.doesNotThrow(() => {
    mockClient.emit("error", new Error("Test Redis error"));
  });
});

test("uses capped exponential reconnection delays", async () => {
  let clientOptions;

  const mockClient = createMockClient();

  const manager = createRedisManager({
    url: "redis://localhost:6379",
    createClientFn: (options) => {
      clientOptions = options;
      return mockClient;
    },
    logger: createLogger(),
  });

  await manager.connectRedis();

  const reconnectStrategy = clientOptions.socket.reconnectStrategy;

  assert.equal(reconnectStrategy(0), 1000);
  assert.equal(reconnectStrategy(1), 2000);
  assert.equal(reconnectStrategy(2), 4000);
  assert.equal(reconnectStrategy(3), 8000);
  assert.equal(reconnectStrategy(4), 16000);
  assert.equal(reconnectStrategy(5), 30000);
  assert.equal(reconnectStrategy(10), 30000);
});

test("closes a ready Redis connection during shutdown", async () => {
  const mockClient = createMockClient();

  const manager = createRedisManager({
    url: "redis://localhost:6379",
    createClientFn: () => mockClient,
    logger: createLogger(),
  });

  await manager.connectRedis();
  await manager.closeRedis();

  assert.equal(mockClient.closeCalls, 1);
  assert.equal(mockClient.destroyCalls, 0);
  assert.equal(manager.client, null);
  assert.equal(manager.isRedisReady(), false);
});


test("destroys an open but not ready Redis connection during shutdown", async () => {
  const mockClient = createMockClient();

  const manager = createRedisManager({
    url: "redis://localhost:6379",
    createClientFn: () => mockClient,
    logger: createLogger(),
  });

  // Start a connection attempt that fails after opening the socket.
  mockClient.connect = async () => {
    mockClient.isOpen = true;
    mockClient.isReady = false;
    throw new Error("Redis unavailable");
  };

  await manager.connectRedis();
  await manager.closeRedis();

  assert.equal(mockClient.destroyCalls, 1);
  assert.equal(mockClient.closeCalls, 0);
  assert.equal(manager.client, null);
});

test("shutdown is safe when no Redis client exists", async () => {
  const manager = createRedisManager({
    url: "",
    logger: createLogger(),
  });

  await assert.doesNotReject(() => manager.closeRedis());

  assert.equal(manager.client, null);
});


test("destroys a pending Redis connection during shutdown", async () => {
  const mockClient = createMockClient();
  let rejectConnection;

  mockClient.connect = () => {
    mockClient.connectCalls++;
    mockClient.isOpen = true;
    mockClient.isReady = false;

    return new Promise((resolve, reject) => {
      rejectConnection = reject;
    });
  };

  const manager = createRedisManager({
    url: "redis://localhost:6379",
    createClientFn: () => mockClient,
    logger: createLogger(),
  });

  // Begin connecting, but leave the connection pending.
  const connectionPromise = manager.connectRedis();

  assert.equal(mockClient.isOpen, true);
  assert.equal(manager.isRedisReady(), false);

  // Shutdown must destroy the open, not-ready client.
  await manager.closeRedis();

  assert.equal(mockClient.destroyCalls, 1);
  assert.equal(mockClient.closeCalls, 0);
  assert.equal(manager.client, null);

  // Simulate the pending connection failing because shutdown destroyed it.
  rejectConnection(new Error("Connection closed during shutdown"));

  // The pending attempt should be handled without an unhandled rejection.
  assert.equal(await connectionPromise, false);
  assert.equal(manager.client, null);
  assert.equal(manager.isRedisReady(), false);
});
