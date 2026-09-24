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
