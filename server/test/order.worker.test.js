const { test } = require("node:test");
const assert = require("node:assert/strict");

const { startOrderWorker, GRACEFUL_SHUTDOWN_MS } = require("../src/workers/order.worker");
const { ORDER_QUEUE_NAME, ORDER_RECEIPT_JOB } = require("../src/queues/order.queue");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createMocks({
  redisAvailable = true,
  workerPause,
  workerClose,
  dedicatedRedisClose,
  sharedRedisClose,
  databaseEnd,
  sharedRedisConnect,
  dedicatedRedisConnect,
} = {}) {
  const calls = [];
  let sharedConnectPending = false;

  const rawClient = {
    isOpen: false,
    isReady: false,
    on() {},
    async connect() {
      calls.push("dedicatedRedis.connect");
      if (dedicatedRedisConnect) return dedicatedRedisConnect(this);
      if (!redisAvailable) throw new Error("Redis connection failed");
      this.isOpen = true;
      this.isReady = true;
    },
    async close() {
      calls.push("dedicatedRedis.close");
      if (dedicatedRedisClose) return dedicatedRedisClose(this);
      this.isOpen = false;
      this.isReady = false;
    },
    destroy() {
      calls.push("dedicatedRedis.destroy");
      this.isOpen = false;
      this.isReady = false;
    },
  };

  const sharedClient = {
    isOpen: true,
    isReady: true,
    duplicate() {
      calls.push("dedicatedRedis.duplicate");
      return rawClient;
    },
    destroy() {
      calls.push("sharedRedis.destroy");
      this.isOpen = false;
      this.isReady = false;
    },
  };

  const redisManager = {
    get client() { return sharedClient; },
    connectRedis() {
      calls.push("sharedRedis.connect");
      if (sharedRedisConnect) {
        sharedConnectPending = true;
        const result = Promise.resolve().then(() => sharedRedisConnect(sharedClient));
        result.then(
          () => { sharedConnectPending = false; },
          () => { sharedConnectPending = false; },
        );
        return result;
      }
      if (!redisAvailable) return Promise.resolve(false);
      sharedClient.isOpen = true;
      sharedClient.isReady = true;
      return Promise.resolve(true);
    },
    async closeRedis() {
      calls.push("sharedRedis.close");
      if (sharedRedisClose) return sharedRedisClose(sharedClient);
      if (sharedConnectPending) {
        sharedClient.destroy();
        return;
      }
      if (!sharedClient.isOpen && !sharedClient.isReady) return;
      sharedClient.isOpen = false;
      sharedClient.isReady = false;
    },
  };

  const db = {
    async end() {
      calls.push("database.end");
      if (databaseEnd) return databaseEnd();
    },
  };

  class FakeWorker {
    constructor(queueName, processor, options) {
      this.queueName = queueName;
      this.processor = processor;
      this.options = options;
      this.events = {};
      calls.push("worker.created");
    }
    on(event, callback) {
      this.events[event] = callback;
      return this;
    }
    async pause(doNotWaitActive) {
      calls.push(`worker.pause:${doNotWaitActive}`);
      if (workerPause) return workerPause();
    }
    async close(force = false) {
      calls.push(`worker.close:${force}`);
      if (workerClose) return workerClose(force);
    }
  }

  const processReceipt = async (job) => {
    calls.push(`receipt:${job.data.orderId}`);
    return { receiptId: "receipt-1" };
  };

  return {
    dependencies: {
      redisManager,
      db,
      WorkerClass: FakeWorker,
      createReceiptProcessor: () => processReceipt,
      createRedisConnection: (client) => ({ client, adapter: true }),
      logger: { info() {}, warn() {}, error() {} },
      registerSignals: false,
      terminateProcess: (code) => calls.push(`process.exit:${code}`),
    },
    calls,
    rawClient,
    sharedClient,
  };
}

function cleanupCounts(calls) {
  return {
    workerClose: calls.filter((call) => call.startsWith("worker.close:")).length,
    dedicatedClose: calls.filter((call) => call === "dedicatedRedis.close").length,
    dedicatedDestroy: calls.filter((call) => call === "dedicatedRedis.destroy").length,
    sharedClose: calls.filter((call) => call === "sharedRedis.close").length,
    sharedDestroy: calls.filter((call) => call === "sharedRedis.destroy").length,
    databaseEnd: calls.filter((call) => call === "database.end").length,
    processExit: calls.filter((call) => call === "process.exit:1").length,
  };
}

test("starts the order worker with the correct queue and concurrency", async () => {
  const mocks = createMocks();
  const result = await startOrderWorker(mocks.dependencies);

  assert.equal(result.worker.queueName, ORDER_QUEUE_NAME);
  assert.equal(result.worker.options.concurrency, 5);
  assert.equal(result.worker.options.connection.adapter, true);
  assert.equal(result.activeProcessorCount, 0);
  assert.ok(mocks.calls.includes("worker.created"));

  await result.shutdown();
});

test("processes a valid order receipt job and tracks active processing", async () => {
  const mocks = createMocks();
  const { worker, shutdown } = await startOrderWorker(mocks.dependencies);

  const result = await worker.processor({
    id: "job-101",
    name: ORDER_RECEIPT_JOB,
    data: { orderId: "101" },
  });

  assert.deepEqual(result, { receiptId: "receipt-1" });
  assert.ok(mocks.calls.includes("receipt:101"));
  assert.equal(mocks.calls.indexOf("receipt:101") >= 0, true);

  await shutdown();
});

test("rejects unsupported job types", async () => {
  const mocks = createMocks();
  const { worker, shutdown } = await startOrderWorker(mocks.dependencies);

  await assert.rejects(worker.processor({
    name: "unknown-job",
    data: { orderId: "101" },
  }), /Unsupported job/);

  await shutdown();
});

test("fails when Redis is unavailable and still attempts cleanup", async () => {
  const mocks = createMocks({ redisAvailable: false });

  await assert.rejects(startOrderWorker(mocks.dependencies), /Redis is unavailable/);
  assert.ok(mocks.calls.includes("sharedRedis.connect"));
  assert.ok(mocks.calls.includes("sharedRedis.close"));
  assert.ok(mocks.calls.includes("database.end"));
  assert.ok(!mocks.calls.includes("worker.created"));
});

test("cleans up Redis connections when worker startup fails", async () => {
  const mocks = createMocks();

  class FailingWorker {
    constructor() { throw new Error("Worker initialization failed"); }
  }

  await assert.rejects(startOrderWorker({
    ...mocks.dependencies,
    WorkerClass: FailingWorker,
  }), /Worker initialization failed/);

  assert.ok(
    mocks.calls.includes("dedicatedRedis.close") ||
    mocks.calls.includes("dedicatedRedis.destroy"),
    "startup failure must close or destroy the dedicated Redis connection",
  );
  assert.ok(mocks.calls.includes("sharedRedis.close"));
  assert.ok(mocks.calls.includes("database.end"));
});

test("gracefully waits for active receipt work before closing connections", async () => {
  const mocks = createMocks();
  const processorStarted = deferred();
  const finishProcessor = deferred();

  const workerResources = await startOrderWorker({
    ...mocks.dependencies,
    createReceiptProcessor: () => async () => {
      processorStarted.resolve();
      await finishProcessor.promise;
      return { receiptId: "receipt-graceful" };
    },
    gracefulShutdownMs: 500,
  });
  const { worker, shutdown } = workerResources;

  const processing = worker.processor({
    id: "job-graceful",
    name: ORDER_RECEIPT_JOB,
    data: { orderId: "500" },
  });

  await processorStarted.promise;
  assert.equal(workerResources.activeProcessorCount, 1);

  const firstShutdown = shutdown("SIGTERM");
  const secondShutdown = shutdown("SIGINT");

  assert.equal(firstShutdown, secondShutdown, "concurrent callers must receive the same shutdown promise");
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(mocks.calls.includes("worker.pause:true"));
  assert.ok(!mocks.calls.includes("worker.close:false"), "worker must stay open while receipt is active");
  assert.equal(mocks.calls.filter((call) => call === "database.end").length, 0);

  finishProcessor.resolve();
  await processing;
  await firstShutdown;

  assert.equal(workerResources.activeProcessorCount, 0);
  assert.ok(mocks.calls.includes("worker.close:false"));
  assert.equal(cleanupCounts(mocks.calls).processExit, 0);
});

test("a hanging worker.close is bounded and all cleanup steps run exactly once", async () => {
  const mocks = createMocks({
    workerClose: () => new Promise(() => {}),
  });

  const { shutdown } = await startOrderWorker({
    ...mocks.dependencies,
    workerCloseTimeoutMs: 20,
    dedicatedRedisCloseTimeoutMs: 20,
    sharedRedisCloseTimeoutMs: 20,
    databaseCloseTimeoutMs: 20,
  });

  const firstShutdown = shutdown("SIGTERM");
  const secondShutdown = shutdown("SIGINT");
  assert.equal(firstShutdown, secondShutdown);

  await firstShutdown;

  const counts = cleanupCounts(mocks.calls);
  assert.equal(counts.workerClose, 1);
  assert.equal(counts.dedicatedDestroy, 1);
  assert.equal(counts.sharedClose, 1);
  assert.equal(counts.databaseEnd, 1);
  assert.equal(counts.processExit, 1);
});

test("a failing dedicated Redis close falls back to destroy and still closes shared Redis and PostgreSQL", async () => {
  const mocks = createMocks({
    dedicatedRedisClose: async () => {
      throw new Error("Dedicated Redis close failed");
    },
  });

  const { shutdown } = await startOrderWorker({
    ...mocks.dependencies,
    dedicatedRedisCloseTimeoutMs: 20,
    sharedRedisCloseTimeoutMs: 20,
    databaseCloseTimeoutMs: 20,
  });

  await shutdown();

  const counts = cleanupCounts(mocks.calls);
  assert.equal(counts.dedicatedClose, 1);
  assert.equal(counts.dedicatedDestroy, 1);
  assert.equal(counts.sharedClose, 1);
  assert.equal(counts.databaseEnd, 1);
  assert.equal(counts.processExit, 1);
});

test("a timed-out dedicated Redis close is destroyed and later cleanup is attempted once", async () => {
  const mocks = createMocks({
    dedicatedRedisClose: () => new Promise(() => {}),
  });

  const { shutdown } = await startOrderWorker({
    ...mocks.dependencies,
    dedicatedRedisCloseTimeoutMs: 20,
    sharedRedisCloseTimeoutMs: 20,
    databaseCloseTimeoutMs: 20,
  });

  await shutdown();

  const counts = cleanupCounts(mocks.calls);
  assert.equal(counts.dedicatedClose, 1);
  assert.equal(counts.dedicatedDestroy, 1);
  assert.equal(counts.sharedClose, 1);
  assert.equal(counts.databaseEnd, 1);
  assert.equal(counts.processExit, 1);
});

test("a processor that exceeds the grace deadline is force-closed and process-terminated", async () => {
  const mocks = createMocks();
  const processorStarted = deferred();

  const workerResources = await startOrderWorker({
    ...mocks.dependencies,
    createReceiptProcessor: () => async () => {
      processorStarted.resolve();
      return new Promise(() => {});
    },
    gracefulShutdownMs: 20,
    workerCloseTimeoutMs: 20,
    dedicatedRedisCloseTimeoutMs: 20,
    sharedRedisCloseTimeoutMs: 20,
    databaseCloseTimeoutMs: 20,
  });
  const { worker, shutdown } = workerResources;

  const processing = worker.processor({
    id: "job-interrupted",
    name: ORDER_RECEIPT_JOB,
    data: { orderId: "700" },
  });

  await processorStarted.promise;
  assert.equal(workerResources.activeProcessorCount, 1);

  await shutdown("SIGTERM");

  assert.ok(mocks.calls.includes("worker.pause:true"));
  assert.ok(mocks.calls.includes("worker.close:true"));
  const dedicatedCloseIndex = mocks.calls.findIndex((call) =>
    call === "dedicatedRedis.close" || call === "dedicatedRedis.destroy"
  );
  assert.ok(dedicatedCloseIndex >= 0);
  assert.ok(dedicatedCloseIndex < mocks.calls.indexOf("database.end"));
  assert.ok(mocks.calls.includes("sharedRedis.close"));
  assert.ok(mocks.calls.includes("database.end"));
  assert.ok(mocks.calls.includes("process.exit:1"));
  assert.equal(
    workerResources.activeProcessorCount,
    1,
    "processor remains pending only until the production process exits",
  );

  // The unresolved processor promise is intentional: production uses
  // process.exit(1) after cleanup, so it cannot continue against a closed pool.
  void processing;
});

test("a timed-out PostgreSQL pool close triggers the hard termination strategy", async () => {
  const mocks = createMocks({
    databaseEnd: () => new Promise(() => {}),
  });

  const { shutdown } = await startOrderWorker({
    ...mocks.dependencies,
    databaseCloseTimeoutMs: 20,
  });

  await shutdown();

  const counts = cleanupCounts(mocks.calls);
  assert.equal(counts.databaseEnd, 1);
  assert.equal(counts.sharedClose, 1);
  assert.equal(counts.processExit, 1);
});

test("exports the documented graceful shutdown deadline", () => {
  assert.equal(GRACEFUL_SHUTDOWN_MS, 20000);
});


test("bounds a shared Redis connect that never settles and closes shared Redis and PostgreSQL once", async () => {
  const mocks = createMocks({
    sharedRedisConnect: () => new Promise(() => {}),
  });

  await assert.rejects(
    startOrderWorker({
      ...mocks.dependencies,
      sharedRedisConnectTimeoutMs: 20,
      dedicatedRedisConnectTimeoutMs: 20,
      sharedRedisCloseTimeoutMs: 20,
      databaseCloseTimeoutMs: 20,
    }),
    /Timed out connecting the shared Redis client/,
  );

  assert.equal(mocks.calls.filter((call) => call === "sharedRedis.connect").length, 1);
  assert.equal(mocks.calls.filter((call) => call === "dedicatedRedis.connect").length, 0);
  assert.equal(mocks.calls.includes("worker.created"), false);
  assert.equal(cleanupCounts(mocks.calls).sharedClose, 1);
  assert.equal(cleanupCounts(mocks.calls).sharedDestroy, 1);
  assert.equal(cleanupCounts(mocks.calls).databaseEnd, 1);
  assert.equal(cleanupCounts(mocks.calls).processExit, 0);
  assert.equal(mocks.sharedClient.isOpen, false);
  assert.equal(mocks.sharedClient.isReady, false);
});

test("bounds a dedicated Redis connect that never settles and cleans all startup resources once", async () => {
  const mocks = createMocks({
    dedicatedRedisConnect: () => new Promise(() => {}),
  });

  await assert.rejects(
    startOrderWorker({
      ...mocks.dependencies,
      dedicatedRedisConnectTimeoutMs: 20,
      dedicatedRedisCloseTimeoutMs: 20,
      sharedRedisCloseTimeoutMs: 20,
      databaseCloseTimeoutMs: 20,
    }),
    /Timed out connecting the dedicated worker Redis client/,
  );

  const counts = cleanupCounts(mocks.calls);
  assert.equal(counts.dedicatedDestroy, 1);
  assert.equal(counts.sharedClose, 1);
  assert.equal(counts.databaseEnd, 1);
  assert.equal(counts.processExit, 0);
  assert.equal(mocks.calls.includes("worker.created"), false);
  assert.equal(mocks.rawClient.isOpen, false);
  assert.equal(mocks.sharedClient.isOpen, false);
  assert.equal(mocks.sharedClient.isReady, false);
});

test("destroys a dedicated Redis socket that resolves and opens after its startup timeout", async () => {
  let connectFinished = false;
  const mocks = createMocks({
    dedicatedRedisConnect: (client) => new Promise((resolve) => {
      setTimeout(() => {
        connectFinished = true;
        // Simulate a late successful connect that opens after destroy().
        client.isOpen = true;
        client.isReady = true;
        resolve();
      }, 60);
    }),
  });

  await assert.rejects(
    startOrderWorker({
      ...mocks.dependencies,
      dedicatedRedisConnectTimeoutMs: 15,
      dedicatedRedisCloseTimeoutMs: 20,
      sharedRedisCloseTimeoutMs: 20,
      databaseCloseTimeoutMs: 20,
    }),
    /Timed out connecting the dedicated worker Redis client/,
  );

  assert.equal(mocks.calls.includes("worker.created"), false);
  assert.equal(cleanupCounts(mocks.calls).sharedClose, 1);
  assert.equal(cleanupCounts(mocks.calls).databaseEnd, 1);
  assert.equal(cleanupCounts(mocks.calls).dedicatedDestroy, 1);

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(connectFinished, true);
  assert.equal(cleanupCounts(mocks.calls).dedicatedDestroy, 2);
  assert.equal(mocks.rawClient.isOpen, false);
  assert.equal(mocks.rawClient.isReady, false);
});

test("SIGTERM during dedicated Redis startup prevents Worker construction and shares cleanup", async () => {
  const { EventEmitter } = require("node:events");
  const signalSource = new EventEmitter();
  const dedicatedConnectStarted = deferred();

  const mocks = createMocks({
    sharedRedisConnect: () => {
      assert.equal(signalSource.listenerCount("SIGTERM"), 1,
        "SIGTERM must be registered before the first Redis connection starts");
      return Promise.resolve(true);
    },
    dedicatedRedisConnect: () => {
      dedicatedConnectStarted.resolve();
      return new Promise(() => {});
    },
  });

  const startup = startOrderWorker({
    ...mocks.dependencies,
    signalSource,
    registerSignals: true,
    dedicatedRedisConnectTimeoutMs: 100,
    dedicatedRedisCloseTimeoutMs: 20,
    sharedRedisCloseTimeoutMs: 20,
    databaseCloseTimeoutMs: 20,
  });

  await dedicatedConnectStarted.promise;
  assert.equal(signalSource.listenerCount("SIGTERM"), 1);

  signalSource.emit("SIGTERM");

  await assert.rejects(startup, /startup was interrupted by shutdown|Timed out connecting/);

  assert.equal(mocks.calls.includes("worker.created"), false);
  assert.equal(cleanupCounts(mocks.calls).dedicatedDestroy, 1);
  assert.equal(cleanupCounts(mocks.calls).sharedClose, 1);
  assert.equal(cleanupCounts(mocks.calls).databaseEnd, 1);
  assert.equal(cleanupCounts(mocks.calls).processExit, 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(mocks.rawClient.isOpen, false);
  assert.equal(mocks.sharedClient.isOpen, false);
  assert.equal(mocks.sharedClient.isReady, false);
});

test("a late shared Redis success after shutdown cannot leave a shared socket open", async () => {
  let connectFinished = false;
  const mocks = createMocks({
    sharedRedisConnect: (client) => new Promise((resolve) => {
      setTimeout(() => {
        connectFinished = true;
        client.isOpen = true;
        client.isReady = true;
        resolve(true);
      }, 60);
    }),
  });

  await assert.rejects(
    startOrderWorker({
      ...mocks.dependencies,
      sharedRedisConnectTimeoutMs: 15,
      sharedRedisCloseTimeoutMs: 20,
      databaseCloseTimeoutMs: 20,
    }),
    /Timed out connecting the shared Redis client/,
  );

  assert.equal(mocks.calls.includes("worker.created"), false);
  assert.equal(cleanupCounts(mocks.calls).sharedClose, 1);
  assert.equal(cleanupCounts(mocks.calls).sharedDestroy, 1);
  assert.equal(cleanupCounts(mocks.calls).databaseEnd, 1);

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(connectFinished, true);
  assert.equal(mocks.sharedClient.isOpen, false);
  assert.equal(mocks.sharedClient.isReady, false);
});
