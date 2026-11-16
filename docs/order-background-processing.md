# Order background processing (Issue #21)

## Contract

- Queue: `order-follow-up`
- Job: `process-order`
- Payload: `{ orderId }` (string form of the PostgreSQL order ID)
- First task: persist an immutable receipt snapshot in PostgreSQL.
- BullMQ worker attempts: 3 processing attempts per job, with exponential backoff starting at 2 seconds.
- Completed jobs: retain the most recent 1,000.
- Failed jobs: retain for inspection (`removeOnFail: false`).

## Transaction and outbox

The order, order items, inventory deductions, inventory transaction rows, and
`order.receipt.requested` outbox row are committed in one PostgreSQL transaction.
No Redis call is made inside checkout. The outbox dispatcher claims pending or
expired-lease rows with `FOR UPDATE SKIP LOCKED`, publishes them, then marks
them dispatched. A failed publish releases the row for a later retry.

Each dispatcher claim has a fresh `claim_token`. The token must still match
when a dispatcher marks an event dispatched or releases it for retry. If its
60-second lease expires and another dispatcher claims the event, the old
dispatcher cannot change the new owner's row. A duplicate publish can still
occur at that boundary, so the deterministic BullMQ job ID remains important.

## Retry layers

The PostgreSQL outbox `attempts` counter and BullMQ's job attempts are separate:

- **Outbox attempts** increment every time a dispatcher claims a row. This
  includes an expired lease reclaimed after a dispatcher crash. A publish
  failure returns the row to `pending` with exponential delay capped at
  60 seconds. There is no automatic maximum for outbox attempts; persistent
  enqueue failures continue to retry and should be monitored through
  `last_error` and the counter.
- **BullMQ attempts** begin only after a job has been enqueued. The worker gets
  up to 3 attempts for processing that job, with exponential backoff starting
  at 2 seconds. A job that exhausts those attempts remains in BullMQ's failed
  set for inspection; it is not automatically re-enqueued by the outbox
  because the outbox event is already marked dispatched.

A crash after enqueue but before the outbox status update can cause the
dispatcher to publish the same deterministic job ID again. BullMQ suppresses
duplicate adds while that job is retained. If the original job has already
been removed from Redis, a later publish may create another job; the receipt's
unique `order_id` constraint and `ON CONFLICT DO NOTHING` make repeated
worker execution safe in either case.

If Redis becomes unavailable while the dispatcher is running, its enqueue
attempt fails and it best-effort returns the event to `pending` with a retry
time. If PostgreSQL is also unavailable, the release update may fail; the
event remains `processing` and is reclaimed after its lease expires. The
dispatcher polls again every two seconds, reconnects to Redis, and then
publishes eligible pending or expired-lease rows.

If PostgreSQL is unavailable while a worker writes a receipt, the processor
throws an error. BullMQ retries the job up to three times using exponential
backoff. If all three attempts fail, the job remains in the failed set and
the outbox row remains dispatched. The receipt may therefore be missing until
an operator fixes the database problem and manually retries the retained job.

### Inspect and retry a failed receipt job

Keep the order worker running while performing a manual retry. First restore
PostgreSQL connectivity and inspect the failed receipt jobs:

```bash
npm run orders:failed-jobs
```

The command lists the BullMQ job ID, order ID, attempts used, and last failure
reason. To retry one order after its underlying issue is fixed:

```bash
npm run orders:retry-failed -- 123
```

Replace `123` with the order ID shown by the inspection command. The command
checks whether a receipt already exists. If one exists, it does not retry the
job. Otherwise it checks that the retained job is the failed receipt job for
that exact order, then calls BullMQ's failed-job retry operation and resets
the exhausted attempt counter so the job receives a fresh three attempts.
The worker must be running to process the requeued job.

Verify the result in PostgreSQL:

```sql
SELECT id, order_id, receipt_number, issued_at
FROM receipts
WHERE order_id = 123;
```

Exactly one row should exist. Do not create a new order job with an ad-hoc ID
as a substitute for retrying the retained failed job. The unique receipt
`order_id` constraint and idempotent processor remain the final safety
boundary if the job is delivered again.

## Receipt fields

`receipts` stores: generated ID, unique order ID, deterministic receipt number,
user ID, total amount, JSON item snapshot (product ID/name/SKU, unit price,
quantity, line total), and issue timestamp. It is not a payment record.

## Worker shutdown and interrupted receipts

The order worker uses an **active-job-aware 20-second graceful shutdown
window**:

1. On SIGTERM/SIGINT it calls BullMQ `worker.pause(true)` to stop fetching new
   jobs without waiting inside BullMQ's pause method.
2. The worker tracks each receipt processor promise and waits up to 20 seconds
   for all active receipt writes to finish.
3. If they drain, BullMQ is closed normally. The dedicated Redis client, shared
   Redis manager, and PostgreSQL pool are then closed in that order. Each
   cleanup step is bounded and is attempted even when an earlier step fails.
4. If active processing does not drain, the worker uses BullMQ
   `worker.close(true)` to stop the worker and its lock-renewal connection.
   Dedicated Redis, shared Redis, and PostgreSQL cleanup are each attempted
   with bounded waits. The worker process then exits with code 1.

The forced path deliberately **does not leave the Node.js process running**:
an unresolved receipt processor must not continue and issue queries against a
closed PostgreSQL pool. Process termination is the final safety boundary.
Because the worker connection is force-closed, BullMQ no longer renews the
interrupted job's lock. Once the lock expires, another worker's stalled-job
checker can recover the job for processing. A receipt write that committed
before interruption is safe to replay because receipts have a unique
`order_id` and the processor uses `ON CONFLICT DO NOTHING`.

Shutdown close deadlines are configurable through `startOrderWorker()` for
tests; production defaults are 20 seconds to drain active processors, 3 seconds
to pause the worker, 5 seconds to close BullMQ, 2 seconds per Redis close, and
3 seconds to close the PostgreSQL pool. A forced shutdown exits non-zero so
the process supervisor can restart the worker.

## Redis adapter and shutdown

The API's shared node-redis client remains managed by `src/config/redis.js`.
The dispatcher and worker duplicate that client for BullMQ and wrap the
duplicate with BullMQ's `createNodeRedisClient` adapter. The WebSocket Pub/Sub
subscriber remains separate. BullMQ's Queue/Worker close operation shuts down
the adapted connection; the application then closes or destroys the duplicate
only if it remains open, before closing the shared Redis manager and PostgreSQL
pool. The API checkout path does not contact Redis.

On SIGTERM/SIGINT, the dispatcher stops polling and does not begin the remaining
items in an already claimed batch. An in-flight enqueue is bounded by a
five-second timeout. The process waits up to 12 seconds for the active poll,
then closes the queue (4-second deadline), Redis (2-second deadline), and
PostgreSQL (3-second deadline), in that order. The Redis and PostgreSQL close
operations are independently bounded and live in nested `finally` blocks:
a rejection or timeout from one never prevents the next cleanup attempt.

If the active poll or any close operation fails or reaches its deadline, the
dispatcher logs the specific failure, attempts every remaining cleanup step
exactly once, and then exits non-zero. It does not report graceful shutdown
when cleanup is incomplete. The total shutdown wait is bounded by the active
poll grace period plus the queue, Redis, and PostgreSQL close deadlines
(approximately 21 seconds with production defaults). The process supervisor
should restart the dispatcher after this forced exit.

Rows claimed but not dispatched remain `processing`; after the 60-second
lease expires, another dispatcher can reclaim them. The dispatcher checks
its stopping flag before starting each event, so it does not begin the
remaining claimed batch during shutdown. If the active poll cannot settle
within the grace period, process termination is the final boundary for any
in-flight work. Claim-token checks prevent a stale dispatcher from modifying
the new owner's claim. A job accepted by Redis just before shutdown is safe
to publish again because its job ID is stable and receipt persistence is
idempotent.

## Commands

From `backend/`:

```bash
npm ci
npm run migrate up
npm start
```

Run these in separate terminals/processes:

```bash
npm run dispatcher:orders
npm run worker:orders
```

Run the default test suite:

```bash
npm test
```

The default test command runs regular `test/*.test.js` files with a
30-second per-test limit and exits after all registered tests finish. The two
Docker-based Redis recovery tests are deliberately excluded because they
start nested containers and cover a separate recovery scenario.

Run those optional Docker tests separately when Docker is available:

```bash
npm run test:docker-recovery
```

Inspect and retry exhausted receipt jobs:

```bash
npm run orders:failed-jobs
npm run orders:retry-failed -- <orderId>
```

The real PostgreSQL/BullMQ end-to-end test runs in the normal suite when
`TEST_DATABASE_URL` and `TEST_REDIS_URL` are configured. CI provisions both
services, checks migration up/down/up, and runs the default suite with a
five-minute job limit and a two-minute test-step limit.

Configure `DATABASE_URL`, `REDIS_URL`, `TEST_DATABASE_URL`, and
`TEST_REDIS_URL`. Never commit real credentials.

## Recovery and operations

Pending outbox rows are retried by the dispatcher every two seconds. Expired
processing leases are reclaimed after 60 seconds. Redis must be available for
the dispatcher and worker, but not for order creation. Inspect retained failed
jobs using BullMQ's queue APIs or a BullMQ-compatible dashboard; do not delete
failed jobs until they have been reviewed.
