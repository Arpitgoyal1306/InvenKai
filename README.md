# Invenkai

**Real-time inventory & order management system** — built to prevent overselling under concurrent checkout, with live stock sync and asynchronous receipt generation.

## 📖 About

Invenkai lets multiple users browse a product catalog and place orders at the same time, while keeping inventory accurate across all connected clients. It solves a classic e-commerce problem — two users buying the last unit of an item at once — using safe, transactional stock updates, live sync, and asynchronous receipt generation.

## ✨ Features

- 🛒 Live product catalog with real-time stock counts
- 🔒 Concurrency-safe checkout — no overselling
- ⚡ Real-time updates via WebSockets
- 🧾 Digital receipt after order placement
- 🔄 Receipt generation via transactional outbox and BullMQ
- 🛠️ Staff inventory tools and seller order management
- 🤖 AI-powered recommendations *(planned)*

## Architecture

```text
React client ──REST──> Express API
                         │ PostgreSQL transaction
                         ▼
                    Order + inventory + receipt outbox event
                                                   │
                                  Outbox dispatcher ▼
                                                  BullMQ (Redis)
                                                   │
                                      Receipt worker ▼
                                              PostgreSQL receipt
```

Checkout completes in the API transaction. The dispatcher publishes committed outbox events to BullMQ. The worker generates receipts independently of fulfillment status. Buyers retrieve their own orders and receipts through the API.

Redis also caches the platform catalog and publishes best-effort inventory events to staff WebSockets. Storefronts and sellers receive scoped refresh signals through server-sent events with polling fallback. Seller order status is refreshed through the API.

## Getting started

See [Developer Onboarding](DEVELOPER_ONBOARDING.md) for local setup, migrations, database isolation, and contribution workflow. See [API contracts](docs/api-contracts.md) for integration details.

## 🗺️ Roadmap

- [x] Core catalog + order flow
- [x] Transaction-safe checkout
- [x] Redis caching + live sync
- [x] Async order queue + receipts
- [ ] AI-powered recommendations
- [ ] Admin dashboard
- [x] Render and Vercel deployment configuration
- [x] Production API and frontend verified
- [ ] Production receipt dispatcher, worker, and end-to-end receipt verified

## 👥 Team

- Group Leader: *Arpit Goyal*
- Group Members: *Arpit Chhimpa ,Arnav Goyal ,Pranay Raut*

## Client and server

- [`client/`](client/) contains the React application and its own npm lockfile.
- [`server/`](server/) contains the Express API, PostgreSQL migrations, and receipt worker and dispatcher.

For local development, set up `server/.env` from `server/.env.example`. From the repository root, run `npm --prefix server ci`, `npm --prefix client ci`, and `npm --prefix server run migrate up`. Start `npm --prefix server start` and `npm --prefix client run dev` in separate terminals. Vite proxies API and WebSocket traffic to port 5001 by default. When running the server directly with a Redis process on your machine, set `REDIS_URL=redis://127.0.0.1:6379` for that local run.

### Deploy the API on Render

The Render Blueprint uses the Node runtime with `server` as the root directory, `npm install` as the build command, and `npm run start` as the start command. Enter the production values in Render, including the internal Redis URL and the public client origin. Deploy the React app separately and set its `VITE_API_URL` to the bare Render backend URL. Use the [production migration workflow](#production-database-migrations) for a release that changes the schema.

Use the same PostgreSQL and Redis URLs for the web service, receipt dispatcher, and receipt worker. Check `/ready` for PostgreSQL and Redis connectivity. The dispatcher and worker issue receipts in the background. A buyer who opens a pending receipt can also get it immediately through the API. The Vercel project uses `client/` as its root so the `/api` rewrite also keeps Google's OAuth cookie on the client origin.

### Deploy on one origin

With `server/.env` configured for the intended PostgreSQL database, run `docker compose up --build -d` from the repository root. Compose starts Redis on a private network at `redis://redis:6379`, runs migrations, then starts the web server, receipt dispatcher, and worker. Set `CLIENT_URL` in the deployment environment to the public HTTPS origin. If your host provides managed Redis, set its `REDIS_URL` in the deployment environment. Compose uses that value for the application processes.

For a single image without Compose, use the commands below.
Build from the repository root with `docker build -f server/Dockerfile -t invenkai .`. Configure PostgreSQL and Redis URLs, `JWT_SECRET`, and `CLIENT_URL` (the public HTTPS origin). For Google sign-in, configure both Google credentials and register that origin plus `/home` as the redirect URI.

On Render, choose the Docker runtime, leave **Root Directory** blank, set **Dockerfile Path** to `server/Dockerfile`, and set **Docker Build Context Directory** to `.`. The image builds the React bundle from `client/` and runs Express from `server/`. Set the HTTP health check path to `/health`.

Run these commands using the same image and environment configuration:

| Process | Command |
| --- | --- |
| Migrate once before starting the new release | `npm run migrate up` |
| Web app and API | `npm start` |
| Receipt outbox dispatcher | `npm run dispatcher:orders` |
| Receipt worker | `npm run worker:orders` |

The image runs these commands from `/app/server` and serves the frontend, API, `/health`, and `/ws` on the configured port. The same layout also works without Docker after building `client/dist` and starting the server with `NODE_ENV=production`. If there are legacy orders predating the timestamp migration, use the [historical timezone instructions](DEVELOPER_ONBOARDING.md#d-apply-database-migrations) before migrating.

### Deploy the API and receipt processes on Render

The Blueprint points at the existing `InvenKai` API and pins the API, `invenkai-order-dispatcher`, and `invenkai-receipt-worker` to Oregon, the region used by the live API and `invenkai-redis`. The workers inherit the API's `DATABASE_URL` and `REDIS_URL`. Review the Blueprint sync preview for reuse of the existing API before approving it. Background workers require paid compute and still need to be provisioned.

Render uses `/health` for routing. It checks PostgreSQL, so the API can still serve database-backed requests during a Redis outage. `/ready` checks both dependencies and returns 503 when either is unavailable. Neither endpoint checks receipt throughput. To verify receipt processing after launch, check dispatcher and worker logs and confirm a test order progresses from outbox dispatch to an issued receipt.

The [database guide](docs/database.md) covers the current schema and inventory boundaries.

The production frontend is the [inven-kai Vercel project](https://inven-kai.vercel.app/). Its Root Directory is `client`. Set `VITE_API_URL` to the public backend origin and deploy from `main`.

### Production database migrations

The deployed free Render API has no pre-deploy command. Use the manually triggered [Production database migrations workflow](.github/workflows/production-migrations.yml) on `main` to apply migrations once per release. It serializes migration runs, and no server or worker startup command runs migrations.

1. In GitHub's `production` environment, configure `PRODUCTION_MIGRATION_DATABASE_URL` as a secret containing a **direct, unpooled** connection to the production database. For a pending timestamp migration on legacy orders, set `HISTORICAL_ORDER_TIMEZONE` to the independently verified historical timezone. See the [onboarding guide](DEVELOPER_ONBOARDING.md#d-apply-database-migrations).
2. For a schema-changing release, pause Render auto-deploy before merging so the application cannot go live before the migration. Review the pending SQL in **preview** mode on the intended release revision.
3. Run **apply** with the full commit SHA printed by the preview. After a successful apply, deploy that revision on Render, check `/ready`, and restore the prior auto-deploy setting.
