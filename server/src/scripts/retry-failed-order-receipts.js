require("dotenv").config();

const redis = require("../config/redis");
const pool = require("../config/database");
const { createOrderQueue, ORDER_RECEIPT_JOB } = require("../queues/order.queue");

async function listFailedOrderReceipts(queue) {
  const jobs = await queue.getFailed(0, 99);

  return jobs
    .filter((job) => job.name === ORDER_RECEIPT_JOB && job.data?.orderId)
    .map((job) => ({
      jobId: job.id,
      orderId: String(job.data.orderId),
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason || "No failure reason recorded",
    }));
}

async function retryFailedOrderReceipt(queue, db, orderId) {
  const normalizedOrderId = String(orderId);

  if (!/^[1-9]\d*$/.test(normalizedOrderId)) {
    throw new Error("Provide a valid positive order ID");
  }

  const job = await queue.getJob(`order-${normalizedOrderId}`);

  if (!job) {
    throw Object.assign(new Error(`No retained BullMQ job exists for order ${normalizedOrderId}`), { statusCode: 404 });
  }

  if (
    job.name !== ORDER_RECEIPT_JOB ||
    String(job.data?.orderId) !== normalizedOrderId
  ) {
    throw new Error(`BullMQ job order-${normalizedOrderId} is not a receipt job for that order`);
  }

  const receipt = await db.query(
    "SELECT id, receipt_number FROM receipts WHERE order_id = $1",
    [normalizedOrderId],
  );

  if (receipt.rowCount > 0) {
    return {
      alreadyGenerated: true,
      receipt: receipt.rows[0],
    };
  }

  const state = await job.getState();

  if (state !== "failed") {
    throw Object.assign(new Error(
      `Order ${normalizedOrderId} job is ${state}, not failed; do not manually enqueue another copy`,
    ), { statusCode: 409 });
  }

  // Reset the exhausted attempt counter so the job gets its configured
  // three attempts again. The receipt's unique order_id remains the
  // idempotency boundary if this job is delivered more than once.
  await job.retry("failed", { resetAttemptsMade: true });

  return {
    alreadyGenerated: false,
    jobId: job.id,
    orderId: normalizedOrderId,
    state: await job.getState(),
  };
}

async function main() {
  let queueResources;

  try {
    const connected = await redis.connectRedis();
    if (!connected) {
      throw new Error("Redis is unavailable; cannot inspect the order queue");
    }

    queueResources = await createOrderQueue({ redisManager: redis });
    await queueResources.queue.waitUntilReady();

    const orderId = process.argv[2];

    if (!orderId) {
      const failedJobs = await listFailedOrderReceipts(queueResources.queue);

      if (failedJobs.length === 0) {
        console.info("No failed order receipt jobs found in the first 100 failed jobs.");
      } else {
        console.table(failedJobs);
      }

      console.info("To retry one after fixing the cause: npm run orders:retry-failed -- <orderId>");
      return;
    }

    const result = await retryFailedOrderReceipt(queueResources.queue, pool, orderId);

    if (result.alreadyGenerated) {
      console.info(
        `Receipt ${result.receipt.receipt_number} already exists for order ${orderId}; no retry was needed.`,
      );
      return;
    }

    console.info(
      `Retried receipt job ${result.jobId} for order ${result.orderId}; current state: ${result.state}. Ensure the order worker is running.`,
    );
  } finally {
    try {
      if (queueResources) await queueResources.close();
    } finally {
      try {
        await redis.closeRedis();
      } finally {
        await pool.end();
      }
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[Order Receipt Recovery]", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  listFailedOrderReceipts,
  retryFailedOrderReceipt,
};
