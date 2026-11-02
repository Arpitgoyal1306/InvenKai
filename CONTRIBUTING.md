# Contributing to InvenKai

Welcome to the InvenKai team. This guide explains how we collaborate so that work can happen independently without creating conflicts on `main`.

## 1. Team workflow

Every task follows this sequence:

1. Open your assigned [GitHub Issue](https://github.com/Arpitgoyal1306/InvenKai/issues) and read its requirements and acceptance criteria.
2. If anything is unclear or your implementation needs a schema/API decision, comment on the issue before making assumptions.
3. Create a feature branch from the latest `main`.
4. Implement only the work covered by your issue.
5. Run the relevant tests and checks.
6. Commit and push your branch.
7. Open a Pull Request (PR) targeting `main`, and link the issue.
8. Address review feedback. The project lead will review and merge the PR.

**Do not push directly to `main`.** Main is protected and changes must go through a PR.

## 2. Setup

Clone the repository and enter the backend:

```bash
git clone https://github.com/Arpitgoyal1306/InvenKai.git
cd InvenKai/backend
npm install
```

Create your local environment file from the example if one is present:

```bash
cp .env.example .env
```

Set your own development values for the variables documented in `.env.example`. Use the Neon development branch assigned to you. Do not share database URLs, passwords, JWT secrets, or other credentials in Issues, PRs, commits, screenshots, or chat.

Start the backend:

```bash
npm run dev
```

The backend normally runs on port `5001`. Check the current environment/configuration if your local setup differs.

## 3. Branch naming

Use a short, descriptive branch name with the issue number:

- `feat/10-product-management`
- `feat/11-supplier-management`
- `feat/12-stock-increase`
- `test/9-auth-route-tests`
- `fix/issue-<number>-short-description`

Create your branch from the latest main:

```bash
git switch main
git pull origin main
git switch -c feat/<issue-number>-short-description
```

Do not work directly on `main`.

## 4. Implementation standards

- Follow the existing project structure and coding conventions. Do not introduce a new architecture or dependency without discussing it first.
- Keep routes, controllers, services, middleware, and database access in their appropriate layers where the existing codebase uses those layers.
- Use parameterized SQL queries. Never concatenate user input into SQL.
- Validate request parameters and bodies. Return consistent HTTP status codes and error responses.
- Enforce authentication and role authorization on protected endpoints. Do not rely only on frontend checks.
- Handle missing records and invalid input explicitly.
- Keep changes focused on your assigned issue. Avoid unrelated refactors and edits to another teammate's files.
- Add or update automated tests for the behavior you introduce.
- Do not invent database columns or API contracts. Discuss uncertain requirements in the Issue first.

## 5. Database and migrations

- Never edit a migration that has already been merged or applied. Create a new migration for schema changes.
- Use a descriptive, unique migration filename.
- Apply migrations against your own assigned Neon development branch, not another developer's database.
- After pulling merged changes, apply pending migrations to your own development database using the repository's migration command.
- If your issue depends on another teammate's schema change, coordinate in the relevant Issues before creating a conflicting migration.
- If a migration fails, stop and report the error. Do not manually alter migration history to make it appear successful.

From the backend directory, the migration command is:

```bash
npm run migrate -- up
```

## 6. Testing

From the backend directory, run:

```bash
npm test
```

Also run any focused test file relevant to your change. If your change affects database behavior, test it against your own development database.

Before opening a PR, verify:

- The feature meets the Issue's acceptance criteria.
- Tests pass.
- No credentials or local environment files are included.
- No unrelated files or generated artifacts are included.
- The application starts successfully when applicable.

If a test cannot be run, state exactly which test and why in the PR description.

## 7. Commit and push

Use clear commit messages, for example:

```bash
git add <files>
git commit -m "feat: add supplier management APIs"
git push -u origin feat/<issue-number>-short-description
```

Do not use force push on shared branches. Do not commit `.env`, database credentials, build output, or dependencies.

## 8. Pull Request requirements

- Base branch: `main`.
- Use a clear title, such as `feat: implement supplier management APIs`.
- Link the Issue in the PR description with `Closes #<issue-number>` when the PR fully completes it.
- Explain what changed and why.
- List endpoints, schema changes, and important implementation decisions.
- Include the test commands you ran and their results.
- Mention known limitations or follow-up work.
- Add screenshots only when the change affects the UI.

A useful PR description:

```markdown
## Summary
- What changed?
- Why was it needed?

## API / Database changes
- Endpoints or migrations added/changed

## Testing
- [ ] `npm test`
- [ ] Focused tests
- [ ] Manual verification (if applicable)

## Checklist
- [ ] Linked the relevant Issue
- [ ] No secrets or `.env` files included
- [ ] No unrelated changes included
- [ ] Acceptance criteria addressed
```

## 9. Coordination and ownership

- Keep technical discussion in the relevant GitHub Issue or PR so the whole team can see decisions.
- Tell the team before changing a shared API contract or database relationship.
- Do not silently change another developer's files or branch.
- If blocked, comment on your Issue with what you tried, the exact error, and what decision/help is needed.
- The project lead reviews PRs and merges approved changes into `main`.

**The goal:** work independently on assigned features, communicate shared decisions early, and integrate through small, tested PRs.
