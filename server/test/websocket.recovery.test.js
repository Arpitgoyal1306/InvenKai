const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createWebSocketService } = require("../src/services/websocket.service");

const INVENTORY_CHANNEL = "inventory:updates";

function createFakeTimers() {
  let nextId = 1;
  const timers = new Map();
  const clearedTimers = [];

  function setTimeoutFn(callback, delay) {
    const id = nextId++;

    timers.set(id, {
      callback,
      delay,
      unref() {},
    });

    return id;
  }

  function clearTimeoutFn(id) {
    clearedTimers.push(id);
    timers.delete(id);
  }

  async function runNext() {
    const entry = timers.entries().next();

    if (entry.done) {
      throw new Error("No retry timer is scheduled");
    }

    const [id, timer] = entry.value;
    timers.delete(id);

    timer.callback();

    // Allow the async connection and subscription operations to settle.
    await new Promise((resolve) => setImmediate(resolve));
  }

  return {
    setTimeoutFn,
    clearTimeoutFn,
    runNext,

    get pendingCount() {
      return timers.size;
    },

    get delays() {
      return [...timers.values()].map((timer) => timer.delay);
    },

    get clearedTimers() {
      return clearedTimers;
    },
  };
}

function createMockSubscriber({
  connect = async function () {
    this.isOpen = true;
    this.isReady = true;
  },
  subscribe = async function (channel, callback) {
    this.subscribedChannel = channel;
    this.messageHandler = callback;
  },
} = {}) {
  const handlers = new Map();

  return {
    isOpen: false,
    isReady: false,
    subscribedChannel: null,
    messageHandler: null,
    destroyed: false,
    closed: false,

    on(event, callback) {
      if (!handlers.has(event)) {
        handlers.set(event, []);
      }

      handlers.get(event).push(callback);
      return this;
    },

    emit(event, value) {
      for (const callback of handlers.get(event) || []) {
        callback(value);
      }
    },

    async connect() {
      return connect.call(this);
    },

    async subscribe(channel, callback) {
      return subscribe.call(this, channel, callback);
    },

    async close() {
      this.closed = true;
      this.isOpen = false;
      this.isReady = false;
    },

    destroy() {
      this.destroyed = true;
      this.isOpen = false;
      this.isReady = false;
    },
  };
}

function createRecoveryContext(
  subscriberFactories,
  { publisherReady = true } = {},
) {
  const timers = createFakeTimers();
  const subscribers = [];
  const publisherHandlers = new Map();

  let duplicateCalls = 0;

  const publisher = {
    isReady: publisherReady,

    on(event, callback) {
      if (!publisherHandlers.has(event)) {
        publisherHandlers.set(event, []);
      }

      publisherHandlers.get(event).push(callback);
      return this;
    },

    removeListener(event, callback) {
      const listeners = publisherHandlers.get(event) || [];

      publisherHandlers.set(
        event,
        listeners.filter((listener) => listener !== callback),
      );

      return this;
    },

    emit(event, value) {
      for (const callback of publisherHandlers.get(event) || []) {
        callback(value);
      }

      return this;
    },

    duplicate() {
      const factory = subscriberFactories[duplicateCalls];

      duplicateCalls += 1;

      if (!factory) {
        throw new Error("Unexpected Redis subscriber creation");
      }

      const nextSubscriber = factory();

      subscribers.push(nextSubscriber);

      return nextSubscriber;
    },
  };

  const service = createWebSocketService({
    getRedisClient: () => publisher,
    allowedOrigin: "http://localhost:5173",
    retryBaseMs: 100,
    retryMaxMs: 800,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  });

  return {
    service,
    publisher,
    subscribers,
    timers,

    get duplicateCalls() {
      return duplicateCalls;
    },
  };
}

test("schedules a retry after the initial subscriber connection fails", async () => {
  const context = createRecoveryContext([
    () =>
      createMockSubscriber({
        connect: async function () {
          throw new Error("Initial Redis connection failed");
        },
      }),
  ]);

  try {
    const result = await context.service.startSubscriber();

    assert.equal(result, false);
    assert.equal(context.duplicateCalls, 1);
    assert.equal(context.timers.pendingCount, 1);
    assert.deepEqual(context.timers.delays, [100]);
  } finally {
    await context.service.close();
  }
});

test("successfully subscribes after an initial connection failure and retry", async () => {
  const context = createRecoveryContext([
    () =>
      createMockSubscriber({
        connect: async function () {
          throw new Error("Temporary Redis failure");
        },
      }),

    () => createMockSubscriber(),
  ]);

  try {
    const initialResult = await context.service.startSubscriber();

    assert.equal(initialResult, false);
    assert.equal(context.timers.pendingCount, 1);

    await context.timers.runNext();

    assert.equal(context.duplicateCalls, 2);
    assert.equal(context.subscribers.length, 2);

    const recoveredSubscriber = context.subscribers[1];

    assert.equal(recoveredSubscriber.isReady, true);
    assert.equal(recoveredSubscriber.subscribedChannel, INVENTORY_CHANNEL);
    assert.equal(context.timers.pendingCount, 0);
  } finally {
    await context.service.close();
  }
});

test("creates a replacement subscriber after the current subscriber emits end", async () => {
  const context = createRecoveryContext([
    () => createMockSubscriber(),
    () => createMockSubscriber(),
  ]);

  try {
    const initialResult = await context.service.startSubscriber();

    assert.equal(initialResult, true);
    assert.equal(context.duplicateCalls, 1);

    const firstSubscriber = context.subscribers[0];

    firstSubscriber.isOpen = false;
    firstSubscriber.isReady = false;
    firstSubscriber.emit("end");

    assert.equal(context.timers.pendingCount, 1);
    assert.deepEqual(context.timers.delays, [100]);

    await context.timers.runNext();

    assert.equal(context.duplicateCalls, 2);

    const replacementSubscriber = context.subscribers[1];

    assert.equal(replacementSubscriber.isReady, true);
    assert.equal(replacementSubscriber.subscribedChannel, INVENTORY_CHANNEL);
    assert.equal(context.timers.pendingCount, 0);
  } finally {
    await context.service.close();
  }
});

test("cancels a pending retry and prevents new subscribers during shutdown", async () => {
  const context = createRecoveryContext([
    () =>
      createMockSubscriber({
        connect: async function () {
          throw new Error("Temporary Redis failure");
        },
      }),
  ]);

  const result = await context.service.startSubscriber();

  assert.equal(result, false);
  assert.equal(context.timers.pendingCount, 1);

  await context.service.close();

  assert.equal(context.timers.pendingCount, 0);
  assert.equal(context.timers.clearedTimers.length, 1);

  // Simulate a stale timer callback attempting to trigger recovery.
  context.publisher.emit("ready");

  assert.equal(context.duplicateCalls, 1);
  assert.equal(context.subscribers.length, 1);
});

test("shutdown is idempotent when called multiple times", async () => {
  const context = createRecoveryContext([() => createMockSubscriber()]);

  await context.service.startSubscriber();

  const firstClose = context.service.close();
  const secondClose = context.service.close();

  assert.equal(firstClose, secondClose);

  await Promise.all([firstClose, secondClose]);

  assert.equal(context.timers.pendingCount, 0);
});

test("recovers the subscriber when the publisher becomes ready", async () => {
  const context = createRecoveryContext([() => createMockSubscriber()], {
    publisherReady: false,
  });

  try {
    const initialResult = await context.service.startSubscriber();

    assert.equal(initialResult, false);
    assert.equal(context.duplicateCalls, 0);
    assert.equal(context.timers.pendingCount, 1);

    // Simulate Redis publisher recovering.
    context.publisher.isReady = true;
    context.publisher.emit("ready");

    // Allow the asynchronous subscriber connection to settle.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(context.duplicateCalls, 1);
    assert.equal(context.subscribers.length, 1);

    const recoveredSubscriber = context.subscribers[0];

    assert.equal(recoveredSubscriber.isReady, true);
    assert.equal(recoveredSubscriber.subscribedChannel, INVENTORY_CHANNEL);
    assert.equal(context.timers.pendingCount, 0);
  } finally {
    await context.service.close();
  }
});

test("retries when an existing subscriber is open but not ready", async () => {
  const context = createRecoveryContext([
    () =>
      createMockSubscriber({
        connect: async function () {
          this.isOpen = true;
          this.isReady = false;
        },

        subscribe: async function () {
          throw new Error("Redis subscriber is not ready");
        },
      }),

    () => createMockSubscriber(),
  ]);

  try {
    const initialResult = await context.service.startSubscriber();

    assert.equal(initialResult, false);
    assert.equal(context.duplicateCalls, 1);
    assert.equal(context.timers.pendingCount, 1);

    const firstSubscriber = context.subscribers[0];

    assert.equal(firstSubscriber.isOpen, false);
    assert.equal(firstSubscriber.isReady, false);
    assert.equal(firstSubscriber.destroyed, true);

    // Retry should create a fresh subscriber.
    await context.timers.runNext();

    assert.equal(context.duplicateCalls, 2);
    assert.equal(context.subscribers.length, 2);

    const recoveredSubscriber = context.subscribers[1];

    assert.equal(recoveredSubscriber.isReady, true);
    assert.equal(recoveredSubscriber.subscribedChannel, INVENTORY_CHANNEL);
    assert.equal(context.timers.pendingCount, 0);
  } finally {
    await context.service.close();
  }
});
