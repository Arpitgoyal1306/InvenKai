const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  ORDER_QUEUE_NAME,
  ORDER_RECEIPT_JOB,
  defaultJobOptions,
  createOrderQueue,
} = require("../src/queues/order.queue");

function createRedisMock() {
  const rawClient = {
    isOpen: false,
    connected: false,
    destroyed: false,

    on() {},

    async connect() {
      this.isOpen = true;
      this.connected = true;
    },

    destroy() {
      this.destroyed = true;
      this.isOpen = false;
    },
  };

  return {
    rawClient,
    client: {
      duplicate() { return rawClient; },
    },
    isRedisReady() { return true; },
  };
}

test("uses the expected queue and job names", () => {
  assert.equal(ORDER_QUEUE_NAME, "order-follow-up");
  assert.equal(ORDER_RECEIPT_JOB, "process-order");
});

test("configures retry and retention options", () => {
  assert.equal(defaultJobOptions.attempts, 3);
  assert.deepEqual(defaultJobOptions.backoff, { type: "exponential", delay: 2000 });
  assert.deepEqual(defaultJobOptions.removeOnComplete, { count: 1000 });
  assert.equal(defaultJobOptions.removeOnFail, false);
});

test("creates queue and adds an order receipt job with a stable ID", async () => {
  const redisManager = createRedisMock();
  let createdQueueName;
  let createdQueueOptions;
  let addedJob;

  class FakeQueue {
    constructor(name, options) {
      createdQueueName = name;
      createdQueueOptions = options;
    }
    async add(name, data, options) {
      addedJob = { name, data, options };
      return addedJob;
    }
    async close() {}
  }

  const resources = await createOrderQueue({
    QueueClass: FakeQueue,
    redisManager,
    createRedisConnection: (client) => client,
  });

  await resources.enqueueOrderReceipt(101);

  assert.equal(createdQueueName, "order-follow-up");
  assert.equal(createdQueueOptions.defaultJobOptions.attempts, 3);
  assert.equal(addedJob.name, ORDER_RECEIPT_JOB);
  assert.deepEqual(addedJob.data, { orderId: "101" });
  assert.deepEqual(addedJob.options, { jobId: "order-101" });
  assert.equal(redisManager.rawClient.connected, true);

  await resources.close();
  assert.equal(redisManager.rawClient.destroyed, true);
  assert.equal(redisManager.rawClient.isOpen, false);
});

test("converts order IDs to strings in job data and job IDs", async () => {
  const redisManager = createRedisMock();
  const addedJobs = [];

  class FakeQueue {
    constructor() {}
    async add(name, data, options) { addedJobs.push({ name, data, options }); }
    async close() {}
  }

  const resources = await createOrderQueue({
    QueueClass: FakeQueue,
    redisManager,
    createRedisConnection: (client) => client,
  });

  await resources.enqueueOrderReceipt(205);
  assert.deepEqual(addedJobs[0].data, { orderId: "205" });
  assert.equal(addedJobs[0].options.jobId, "order-205");

  await resources.close();
});

test("rejects queue creation when Redis is not ready", async () => {
  const redisManager = {
    client: null,
    isRedisReady() { return false; },
  };

  await assert.rejects(createOrderQueue({ redisManager }), /Redis is not ready/);
});

test("destroys the dedicated Redis client when queue creation fails", async () => {
  const redisManager = createRedisMock();

  class FailingQueue {
    constructor() { throw new Error("Queue creation failed"); }
  }

  await assert.rejects(createOrderQueue({
    QueueClass: FailingQueue,
    redisManager,
    createRedisConnection: (client) => client,
  }), /Queue creation failed/);

  assert.equal(redisManager.rawClient.destroyed, true);
});

test("closes the BullMQ queue when close is called", async () => {
  const redisManager = createRedisMock();
  let queueClosed = false;

  class FakeQueue {
    constructor() {}
    async add() {}
    async close() { queueClosed = true; }
  }

  const resources = await createOrderQueue({
    QueueClass: FakeQueue,
    redisManager,
    createRedisConnection: (client) => client,
  });

  await resources.close();

  assert.equal(queueClosed, true);
  assert.equal(redisManager.rawClient.destroyed, true);
});
