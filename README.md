# Invenkai

**Real-time inventory & order management system** — built to prevent overselling under concurrent checkout, with live stock sync and async order processing.

## 📖 About

Invenkai lets multiple users browse a product catalog and place orders at the same time, while keeping inventory accurate across all connected clients. It solves a classic e-commerce problem — two users buying the last unit of an item at once — using safe, transactional stock updates, live sync, and async order processing.

## ✨ Features

- 🛒 Live product catalog with real-time stock counts
- 🔒 Concurrency-safe checkout — no overselling
- ⚡ Real-time updates via WebSockets
- 🧾 Digital receipt on order completion
- 🔄 Async order processing via background queue
- 🛠️ Admin view for restocking & live order monitoring
- 🤖 AI-powered recommendations *(planned)*

## 🏗️ Architecture

```
React Frontend
      │  REST + WebSocket
      ▼
Express API
      │
  ┌───┼────────────┬─────────────┐
  ▼                ▼             ▼
Neon (Postgres)   Redis      Queue Worker
source of truth   cache +    async order
                  live sync  processing
```

| Component | Role |
|---|---|
| React | Frontend — catalog, cart, live stock view |
| Node.js + Express | API + WebSocket server |
| Neon (PostgreSQL) | Source of truth, transactional stock updates |
| Redis | Caching + pub/sub for live sync |

## 🧠 How It Works

1. User places an order → API checks & updates stock in one atomic transaction (Neon).
2. Order confirmed → handed off to background queue.
3. Redis broadcasts new stock count to all users via WebSocket.
4. Worker processes the order and generates a receipt.
5. User sees live order status update, no refresh needed.

## 🚀 Getting Started

New contributors should start with the **[Developer Onboarding Guide](DEVELOPER_ONBOARDING.md)**. It covers the verified backend structure, local setup, individual Neon database branches, migrations, commands, issue workflow, and pull request expectations.


```bash
git clone https://github.com/<your-username>/invenkai.git
cd invenkai
npm install
cp .env.example .env   # add DATABASE_URL, REDIS_URL
npm run migrate
npm run dev
```

## 🗺️ Roadmap

- [x] Core catalog + order flow
- [x] Transaction-safe checkout
- [x] Redis caching + live sync
- [x] Async order queue + receipts
- [ ] AI-powered recommendations
- [ ] Admin dashboard
- [ ] Deployment

## 👥 Team

- Group Leader: *Arpit Goyal*
- Group Members: *Arpit Chhimpa ,Arnav Goyal ,Pranay Raut*

## Client and server

- [`client/`](client/) contains the React application and its own npm lockfile.
- [`server/`](server/) contains the Express API, PostgreSQL migrations, and receipt worker and dispatcher.

For local development, set up `server/.env` from `server/.env.example`. From the repository root, run `npm --prefix server ci`, `npm --prefix client ci`, and `npm --prefix server run migrate up`. Start `npm --prefix server start` and `npm --prefix client run dev` in separate terminals. Vite proxies API and WebSocket traffic to port 5001 by default. When running the server directly with a Redis process on your machine, set `REDIS_URL=redis://127.0.0.1:6379` for that local run.

### Deploy the API on Render

The Render Blueprint uses the Node runtime with `server` as the root directory, `npm install` as the build command, and `npm run start` as the start command. Enter the production values in Render, including the internal Redis URL and the public client origin. Deploy the React app separately and set its `VITE_API_URL` to the bare Render backend URL. Apply the database migrations before starting the first release.

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
