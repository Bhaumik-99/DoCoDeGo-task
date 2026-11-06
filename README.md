# Sharedspace — Shared Bill Splitter

A small full-stack bill splitter for shared homes. The API runs on Hono + Cloudflare Workers with D1; the web client uses React, Vite, and TanStack Router.

## Features

- Create a household and add housemates.
- Create bills in integer cents and split them evenly. Remainder cents are assigned in member creation order.
- Pay individual shares with an `Idempotency-Key`; retries with the same key return the original payment result.
- Prevent a second concurrent payment through a conditional SQL update.
- View the balances due for each member and a household bill ledger.
- Responsive web interface with loading, empty, network/API error, and payment states.

## Run locally

```bash
pnpm install
pnpm dev
```

The API runs at `http://localhost:8787` and the web app at `http://localhost:5173`. The Vite development server proxies `/api` requests to the Worker.

```bash
pnpm test
pnpm check
pnpm typecheck
pnpm build
```

For a production deployment, create a D1 database, update `api/wrangler.jsonc` with its database ID, apply migrations using `pnpm --filter bill-splitter-api exec wrangler d1 migrations apply DB --remote`, then deploy the Worker and web app to your hosting provider.

## API

- `GET /api/health`
- `POST /api/homes` — `{ "name": "Flat 4B" }`
- `POST /api/homes/:homeId/members` — `{ "name": "Asha" }`
- `POST /api/homes/:homeId/bills` — `{ "title": "Electricity", "totalCents": 1000 }`
- `POST /api/bills/:billId/shares/:shareId/pay` — requires `Idempotency-Key`
- `GET /api/homes/:homeId/balances`
- `GET /api/homes/:homeId/bills` — bill/share ledger for the web client

All error responses are JSON with an `error` property. Money is stored and calculated only as integer cents.

## Decisions

1. **D1 constraints protect invariants.** Foreign keys prevent orphaned homes, members, bills, and shares; checks reject empty names/titles and invalid amounts; a unique `(bill_id, member_id)` constraint prevents duplicate shares; a payment-state check requires the paid timestamp and idempotency key to be present together.
2. **A payment is one conditional SQL update.** `UPDATE ... WHERE paid_at IS NULL` makes the winner explicit at the database boundary. A follow-up read distinguishes an idempotent retry from a conflicting key, so correctness does not depend on Worker-local memory or locks.
3. **Remainder cents follow insertion order.** The split uses integer division and modulo, assigning one extra cent to the first `remainder` members. This is deterministic, keeps totals exact, and avoids floating-point money arithmetic.

## AI assistance

OpenAI ChatGPT was used to help inspect the assignment, draft implementation code, and review edge cases. The implementation should be reviewed and understood by the submitting developer before the required walkthrough video and live discussion.
