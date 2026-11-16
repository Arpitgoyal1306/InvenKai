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
duplicate adds while that job is retained. The receipt's unique `order_id`
constraint and `ON CONFLICT DO NOTHING` also make repeated worker execution
safe even if a separately delivered job reaches the worker again.

## Receipt fields

`receipts` stores: generated ID, unique order ID, deterministic receipt number,
user ID, total amount, JSON item snapshot (product ID/name/SKU, unit price,
quantity, line total), and issue timestamp. It is not a payment record.

## Redis adapter and shutdown

The API's shared node-redis client remains managed by `src/config/redis.js`.
The dispatcher and worker duplicate that client for BullMQ and wrap the
duplicate with BullMQ's `createNodeRedisClient` adapter. The WebSocket Pub/Sub
subscriber remains separate. BullMQ's Queue/Worker close operation shuts down
the adapted connection; the application then closes or destroys the duplicate
only if it remains open, before closing the shared Redis manager and PostgreSQL
pool. The API checkout path does not contact Redis.

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
