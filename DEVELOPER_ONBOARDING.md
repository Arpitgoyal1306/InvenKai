# InvenKai Developer Onboarding Guide

Welcome to **InvenKai**. Read this guide before picking up an issue. It explains what the project is, how the current backend is organized, how to set up your local environment and your own Neon database branch, and how to contribute safely.

> **Important:** This guide describes the repository's verified implementation on `main` at the time it was written. The README also describes the broader product vision. Some items in that vision (such as Redis caching, WebSockets, background workers, and completed checkout flows) are planned work, not functionality you should assume already exists. Always inspect the current code and linked issue before implementing a feature.

## 1. What is InvenKai?

InvenKai is an inventory and order management application. Its goal is to help businesses manage products and stock while preventing incorrect inventory updates and overselling during concurrent purchases.

The intended system includes:

- Product and category management.
- Supplier management.
- User authentication and role-based access.
- Inventory increases and decreases.
- Low-stock alerts and stock movement history.
- Orders and concurrency-safe checkout.
- Reporting and analytics.
- A React frontend, live inventory updates, and background processing.

### Current implementation versus planned work

The backend currently has a working Express application, PostgreSQL connection, authentication routes, and basic inventory read/decrease operations. Check the actual files and open issues to determine what has since been merged.

Do not assume a feature is implemented just because it appears in the product vision or README roadmap. For example, Redis, WebSockets, queue workers, and complete order checkout must be treated as planned until their implementation is present on the current branch.

## 2. Technology stack

| Technology | Purpose |
|---|---|
| Node.js | Backend JavaScript runtime |
| Express 5 | HTTP API |
| PostgreSQL | Relational database and source of truth |
| Neon | Hosted PostgreSQL databases and isolated developer branches |
| `pg` | PostgreSQL client and connection pool |
| `node-pg-migrate` | Version-controlled database migrations |
| bcrypt | Password hashing |
| jsonwebtoken | JWT authentication |
| node:test | Built-in Node.js test runner |
| Supertest | HTTP endpoint testing |
| Redis | Planned caching/pub-sub/background-work support; verify current implementation before using |

The backend uses **CommonJS** (`require` / `module.exports`).

## 3. Understand the backend before changing it

Current backend structure:

```text
backend/
├── migrations/                 # Database schema changes
├── src/
│   ├── config/
│   │   └── database.js         # PostgreSQL connection pool
│   ├── controllers/
│   │   └── auth.controller.js # HTTP request/response handling
│   ├── middleware/
│   │   ├── auth.middleware.js # JWT verification
│   │   └── authorize-roles.js # Role-based access checks
│   ├── routes/
│   │   ├── auth.routes.js      # Authentication endpoints
│   │   └── inventory.routes.js # Inventory endpoints
│   ├── services/
│   │   ├── auth.service.js     # Authentication business logic
│   │   └── inventory.service.js# Inventory database operations
│   └── app.js                  # Express app and route registration
├── test/                       # Automated tests
├── server.js                   # Starts server and checks DB connection
├── package.json
└── .env.example
```

### Request flow

A typical API request follows this flow:

1. A client sends an HTTP request to a route.
2. Route middleware performs authentication and, where needed, role authorization.
3. The route/controller validates request data and calls service logic.
4. The service communicates with PostgreSQL using parameterized SQL.
5. The route returns an appropriate HTTP status and JSON response.

Keep responsibilities in the existing layers. Do not put all business logic directly into `app.js`.

### Useful existing files

| File | Why you should read it |
|---|---|
| `backend/src/app.js` | See how routes are mounted and how 404/health responses work |
| `backend/server.js` | Understand server startup and database connectivity check |
| `backend/src/config/database.js` | Understand the shared PostgreSQL pool |
| `backend/src/routes/auth.routes.js` | Existing route and authentication pattern |
| `backend/src/middleware/auth.middleware.js` | How JWT authentication works |
| `backend/src/middleware/authorize-roles.js` | How role restrictions work |
| `backend/src/routes/inventory.routes.js` | Existing inventory API validation and responses |
| `backend/src/services/inventory.service.js` | Existing parameterized SQL and stock update logic |
| `backend/test/inventory.routes.test.js` | Existing HTTP test patterns |
| `backend/test/authorize-roles.test.js` | Existing authorization test patterns |

## 4. Database schema currently present

The existing migrations create these tables:

- **categories**: category ID, unique name, created/updated timestamps.
- **users**: name, unique email, password hash, role, timestamps.
- **products**: category reference, name, description, unique SKU, price, timestamps.
- **inventory**: one inventory row per product, quantity defaulting to zero, and a database check that quantity cannot be negative.

Migration files currently in the repository:

```text
backend/migrations/
├── 1791302634749_create-categories.js
├── 1791375780922_create-users.js
├── 1791479591493_products.js
└── 1791565549521_inventory.js
```

Read the relevant migration before writing SQL or adding a feature. Do not guess column names, data types, constraints, or relationships.

### Migration safety rules

- **Never edit a migration that has already been merged or applied to a shared database.**
- Create a new migration for every schema change.
- Give the migration a unique, descriptive name.
- Include both `up` and `down` operations where appropriate.
- Check foreign keys, unique constraints, indexes, and delete behavior.
- Coordinate schema changes with teammates whose work depends on them.
- Do not run destructive migration commands against a shared database unless the project lead explicitly approves it.

## 5. Local prerequisites

Install:

- Git
- Node.js and npm
- A code editor
- Access to the InvenKai GitHub repository
- Access to the team's Neon project

Check your installed versions:

```bash
git --version
node --version
npm --version
```

Use a Node.js version compatible with the dependencies in `backend/package.json`. If the repository later adds an `.nvmrc` or an `engines` field, follow that version.

## 6. Clone the repository

Open a terminal and run:

```bash
git clone https://github.com/Arpitgoyal1306/InvenKai.git
cd InvenKai
```

Create your own feature branch before making changes:

```bash
git switch main
git pull origin main
git switch -c feature/<issue-number>-short-description
```

Example:

```bash
git switch -c feature/12-increase-stock
```

Replace the example issue number and description with your assigned task.

## 7. Set up your own Neon PostgreSQL database branch

Each developer must use their **own Neon branch and connection string** for local development. Do not use another developer's database branch, and do not commit credentials.

### A. Create or locate your Neon branch

1. Sign in to the team's Neon project using the access provided by the project lead.
2. Open the project's **Branches** section.
3. Locate the database branch assigned to you. If one has not been assigned, ask the project lead before creating or choosing one.
4. Select your branch and open its connection details.
5. Copy the PostgreSQL connection string for that branch.
6. Use the pooled connection string if the team has instructed you to use it; otherwise use the connection string specified by the project lead.

A Neon branch is an isolated database branch. Schema or data changes in one branch should not be assumed to appear in another branch automatically.

**Never paste a database URL, password, JWT secret, or other credential into a GitHub issue, PR, commit, screenshot, or chat.**

### B. Configure backend environment variables

From the repository root:

```bash
cd backend
cp .env.example .env
```

Open `backend/.env` in your editor and fill in the values locally:

```dotenv
DATABASE_URL=your_own_neon_development_connection_string
TEST_DATABASE_URL=your_own_separate_neon_test_connection_string
JWT_SECRET=your_long_random_local_secret
PORT=5001
CLIENT_URL=http://localhost:5173
```

Notes:

- Set `DATABASE_URL` to the connection string for **your assigned development Neon branch**.
- Set `TEST_DATABASE_URL` to a **separate Neon branch/database used only for automated tests**. Do not point it at your development or production database. If the team has not assigned a test branch, ask the project lead before creating or choosing one.
- The test database must have the same schema as the current application. Apply the repository migrations to it before running integration tests (see below).
- `npm test` sets `NODE_ENV=test`; the backend database configuration then uses `TEST_DATABASE_URL` instead of `DATABASE_URL`.
- Generate your own long, random local JWT secret. Do not reuse a teammate's secret.
- Keep `.env` private. It must remain untracked by Git.
- The committed `.env.example` is a template. Do not put real credentials in it.

### C. Install backend dependencies

Make sure your terminal is inside the `backend` directory:

```bash
npm install
```

### D. Apply database migrations

Run:

```bash
npm run migrate -- up
```

This applies pending migrations to the database selected by `DATABASE_URL`.

Run it only after checking that `.env` points to your own assigned development branch. Never point it at production or another developer's database.

To prepare the separate test database, run the same migrations while temporarily directing the migration command to `TEST_DATABASE_URL`:

```bash
DATABASE_URL="$TEST_DATABASE_URL" npm run migrate -- up
```

This command uses the test database URL only for that migration process. Verify the value before running it. Never run migrations against production or a teammate's database.

If the project lead tells you that your Neon branch already has the schema or migration history has been initialized, do not attempt to reset or re-baseline it. Ask before running any repair or destructive command.

### E. Verify the database connection

Start the backend:

```bash
npm run dev
```

In a second terminal, check:

```bash
curl http://localhost:5001/health
```

A successful response should report:

```json
{
  "status": "ok",
  "database": "connected"
}
```

The health route executes a PostgreSQL query. If it reports a database error, check your own `DATABASE_URL`, Neon branch selection, and network access.

Stop the development server with `Ctrl + C`.

## 8. Backend commands

Run these commands from the `backend` directory:

| Command | Purpose |
|---|---|
| `npm install` | Install backend dependencies |
| `npm run dev` | Start the backend with nodemon |
| `npm start` | Start the backend normally |
| `npm test` | Run automated tests with Node's test runner |
| `npm run migrate -- up` | Apply pending migrations |

The backend listens on port `5001` by default.

## 9. Existing API endpoints

These are the routes currently visible in the backend implementation. Re-check the current code before relying on this list because routes may be added as issues are merged.

| Method | Endpoint | Purpose | Access |
|---|---|---|---|
| GET | `/` | API welcome response | Public |
| GET | `/health` | Check API and PostgreSQL connectivity | Public |
| POST | `/api/auth/register` | Register a user | Public |
| POST | `/api/auth/login` | Log in and receive a JWT | Public |
| GET | `/api/auth/me` | Get the authenticated user's data | Valid JWT |
| GET | `/api/inventory/:productId` | Read a product's inventory | Valid JWT |
| PATCH | `/api/inventory/:productId/decrease` | Decrease stock | inventory_manager or admin |

For protected routes, send the token in the request header:

```http
Authorization: Bearer <your-jwt-token>
```

Example health check:

```bash
curl http://localhost:5001/health
```

Do not assume an endpoint exists just because an issue proposes it. Check the route files or the merged PR that introduced it.

## 10. How to pick up and complete an issue

1. Open the repository's **Issues** tab.
2. Read the full issue description, including dependencies, references, implementation steps, and acceptance criteria.
3. Confirm that the issue is assigned to you or that the project lead has approved you to work on it.
4. Check whether its prerequisite issues are completed. If a dependency is unclear, ask before starting.
5. Read every referenced route, controller, service, middleware, migration, and test file.
6. Check recent merged PRs for related implementation patterns.
7. Create a feature branch using the issue number.
8. Implement only the agreed scope. Do not silently change shared APIs or database relationships.
9. Add or update tests for success cases, validation failures, authorization failures, and relevant edge cases.
10. Run the test suite and any relevant checks.
11. Commit and push your feature branch.
12. Open a PR targeting `main`, link the issue (for example, `Closes #12`), and explain what changed and how you tested it.
13. Wait for review. Address requested changes on the same branch.

### Git commands for your contribution

```bash
# Check your current branch and working tree
git status
git branch

# Bring your local main branch up to date before starting
git switch main
git pull origin main

# Create your feature branch
git switch -c feature/<issue-number>-short-description

# Review changes before committing
git status
git diff

# Stage and commit your work
git add .
git commit -m "feat: describe the change"

# Push your feature branch
git push -u origin feature/<issue-number>-short-description
```

Replace placeholders with your actual issue number and branch name. Do not commit `.env`, credentials, build output, or unrelated changes.

### Pull request checklist

Before requesting review, confirm:

- [ ] PR targets `main`.
- [ ] PR links the correct issue.
- [ ] The change stays within the issue's scope.
- [ ] Tests were added or updated.
- [ ] `npm test` passes.
- [ ] Database migrations are included if the schema changed.
- [ ] No existing applied migration was edited.
- [ ] No secrets or local `.env` files are included.
- [ ] The PR description explains the implementation and test commands/results.

Only the project lead should merge PRs unless the team explicitly changes this policy. Do not push directly to `main`.

## 11. Coding and database rules

- Use parameterized SQL. Never concatenate untrusted input into SQL strings.
- Validate request parameters and body fields before using them.
- Return appropriate HTTP status codes and consistent JSON responses.
- Keep authentication and role authorization on protected routes.
- Never trust a user ID or role supplied in the request body when it should come from the verified JWT.
- Use database transactions when multiple writes must succeed or fail together.
- Preserve existing API response contracts unless the issue explicitly changes them.
- Add tests for important behavior and failure cases.
- Do not add Redis, queue, WebSocket, or other infrastructure dependencies without following the relevant issue and agreeing on the approach with the project lead.

## 12. Troubleshooting

### `npm run dev` says missing script

Make sure the terminal is in `InvenKai/backend`, not the repository root. The dev script is defined in `backend/package.json`.

### Database connection fails

- Confirm that `backend/.env` exists.
- For normal development, confirm `DATABASE_URL` belongs to your assigned development Neon branch.
- For tests, confirm `TEST_DATABASE_URL` points to the separate test-only database and that its migrations have been applied.
- Check that the connection string is complete and has not been accidentally quoted or split.
- Confirm the Neon project/branch is active and accessible.
- Do not share the password while asking for help. Share only the error message with credentials removed.

### Tests fail with `TEST_DATABASE_URL is required`

- Confirm that `TEST_DATABASE_URL` is set in `backend/.env`.
- Make sure you are running `npm test` from the `backend` directory.
- Confirm the test database is separate from development and production.
- Apply pending migrations to the test database using the command in section 7D.
- Never work around this error by pointing `TEST_DATABASE_URL` at your development or production database.

### API returns 404

Check the exact route path and HTTP method. Then confirm the route is mounted in `backend/src/app.js`.

### Protected API returns 401

Check that you logged in successfully and sent `Authorization: Bearer <token>`. Confirm your local `JWT_SECRET` is configured.

### Protected API returns 403

Your token may be valid, but your account's role may not be allowed for that operation. Check the issue's access requirements and `authorize-roles.js`.

### Migration fails

Do not try random reset, drop, or rollback commands. Confirm you are connected to your own Neon branch, read the migration error, and ask the project lead before attempting a schema repair.

## 13. Team communication

When you need help, include:

- The issue number and what you were trying to do.
- The command you ran.
- The complete error message with secrets removed.
- The relevant file path.
- What you already checked.

Before changing a shared contract, database relationship, migration strategy, or infrastructure choice, discuss it in the issue and get agreement from the project lead.

## 14. Your first 30 minutes

If you are new to the repository, follow this order:

1. Read this guide completely.
2. Read the root `README.md` for the product vision.
3. Clone the repository and inspect the folder structure.
4. Read `backend/src/app.js`, `backend/src/routes/inventory.routes.js`, and `backend/src/services/inventory.service.js`.
5. Set up your own Neon branch and local `backend/.env`.
6. Install dependencies, apply migrations, start the backend, and check `/health`.
7. Run `npm test`.
8. Read your assigned GitHub issue and all its references.
9. Start work on a feature branch.

**If anything in this guide conflicts with the current code or your assigned issue, stop and confirm with the project lead before proceeding.**
