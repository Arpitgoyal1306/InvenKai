const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  listFailedOrderReceipts,
  retryFailedOrderReceipt,
} = require("../src/scripts/retry-failed-order-receipts");

function makeJob({
  id = "order-501",
  name = "process-order",
  orderId = "501",
  state = "failed",
  attemptsMade = 3,
} = {}) {
  const calls = [];

  const job = {
    id,
    name,
    data: { orderId },
    attemptsMade,
    failedReason: "Database unavailable",
    async getState() { return state; },
    async retry(expectedState, options) {
      calls.push({ expectedState, options });
      state = "waiting";
    },
  };

  return { job, calls, get state() { return state; } };
}

test("lists failed receipt jobs with their order IDs and failure details", async () => {
  const failed = makeJob();
  const queue = {
    async getFailed(start, end) {
      assert.equal(start, 0);
      assert.equal(end, 99);
      return [
        failed.job,
        { name: "unrelated-job", data: { orderId: "9" } },
      ];
    },
  };

  const result = await listFailedOrderReceipts(queue);

  assert.deepEqual(result, [{
    jobId: "order-501",
    orderId: "501",
    attemptsMade: 3,
    failedReason: "Database unavailable",
  }]);
});

test("retries a failed job after checking receipt absence and resets attempts", async () => {
  const failed = makeJob();
  const queries = [];
  const queue = {
    async getJob(jobId) {
      assert.equal(jobId, "order-501");
      return failed.job;
    },
  };
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rowCount: 0, rows: [] };
    },
  };

  const result = await retryFailedOrderReceipt(queue, db, "501");

  assert.deepEqual(result, {
    alreadyGenerated: false,
    jobId: "order-501",
    orderId: "501",
    state: "waiting",
  });
  assert.deepEqual(failed.calls, [{
    expectedState: "failed",
    options: { resetAttemptsMade: true },
  }]);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, ["501"]);
});

test("does not retry when a receipt already exists", async () => {
  const failed = makeJob();
  const queue = { async getJob() { return failed.job; } };
  const db = {
    async query() {
      return {
        rowCount: 1,
        rows: [{ id: "77", receipt_number: "INV-501" }],
      };
    },
  };

  const result = await retryFailedOrderReceipt(queue, db, "501");

  assert.equal(result.alreadyGenerated, true);
  assert.equal(result.receipt.receipt_number, "INV-501");
  assert.equal(failed.calls.length, 0);
});

test("refuses to retry a job that is not in failed state", async () => {
  const active = makeJob({ state: "active" });

  await assert.rejects(
    retryFailedOrderReceipt(
      { async getJob() { return active.job; } },
      { async query() { return { rowCount: 0, rows: [] }; } },
      "501",
    ),
    /not failed/,
  );
});

test("validates order IDs before looking up a job", async () => {
  let lookedUp = false;

  await assert.rejects(
    retryFailedOrderReceipt({
      async getJob() { lookedUp = true; },
    }, { async query() { return { rowCount: 0, rows: [] }; } }, "0"),
    /positive order ID/,
  );

  assert.equal(lookedUp, false);
});
