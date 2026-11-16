# Order background processing (Issue #21)

## Contract

- Queue: `order-follow-up`
- Job: `process-order`
- Payload: `{ orderId }` (string form of the PostgreSQL order ID)
- First task: persist an immutable receipt snapshot in PostgreSQL.
- Attempts: 3; exponential backoff starting at 2 seconds.
- Completed jobs: retain the most recent 1,000.
- Failed jobs: retain for inspection (`removeOnFail: false`).

## Transaction and outbox

The order, order items, inventory deductions, inventory transaction rows, and
`order.receipt.requested` outbox row are committed in one PostgreSQL transaction.
No Redis call is made inside checkout. The outbox dispatcher claims pending or
expired-lease rows with `FOR UPDATE SKIP LOCKED`, publishes them, then marks
them dispatched. A failed publish releases the row for a later retry.

If the dispatcher crashes after publishing but before marking the row, it will
publish again after the lease expires. It uses deterministic BullMQ job IDs
(`order-<orderId>`) to collapse duplicate adds while a job is retained.
The receipt's unique `order_id` constraint and `ON CONFLICT DO NOTHING`
make repeated worker execution safe even after BullMQ has removed a completed
job from retention.

## Receipt fields

`receipts` stores: generated ID, unique order ID, deterministic receipt number,
user ID, total amount, JSON item snapshot (product ID/name/SKU, unit price,
quantity, line total), and issue timestamp. It is not a payment record.

## Redis adapter and shutdown

The API's shared node-redis client remains managed by `src/config/redis.js`.
The dispatcher and worker duplicate that client for BullMQ and wrap the
duplicate with BullMQ's `createNodeRedisClient` adapter. BullMQ may duplicate
the adapted client internally for blocking commands. The WebSocket Pub/Sub
subscriber remains separate. Shutdown closes the BullMQ Queue/Worker first,
then the adapter-owned duplicate, then the shared Redis manager and PostgreSQL
pool. The API checkout path does not contact Redis.

## Commands

From `backend/`:

```bash
npm install
npm run migrate up
npm start
```

Run these in separate terminals/processes:

```bash
npm run dispatcher:orders
npm run worker:orders
```

Configure `DATABASE_URL`, `REDIS_URL`, and the existing test database
environment variables. Never commit real credentials.

## Recovery and operations

Pending outbox rows are retried by the dispatcher every two seconds. Expired
processing leases are reclaimed after 60 seconds. Redis must be available for
the dispatcher and worker, but not for order creation. Inspect retained failed
jobs using BullMQ's queue APIs or a BullMQ-compatible dashboard; do not delete
failed jobs until they have been reviewed.
