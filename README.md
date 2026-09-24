# AD Pay POS

Multi-vertical retail POS for American Dream Pay LLC. v1 is the convenience-store pack on a
dual-screen Android register, with a merchant mobile app and a back-office admin.

- **Spec:** [`docs/spec-v1-cstore.md`](docs/spec-v1-cstore.md)
- **Working agreement, fixed decisions, sequencing:** [`CLAUDE.md`](CLAUDE.md)
- **ADRs:** [`docs/decisions/`](docs/decisions/)
- **Processor links:** [`docs/finix-links.md`](docs/finix-links.md)

## Run it locally — one command, no cloud, no cost

Needs **Node 20** (see `.nvmrc`) and **Docker Desktop** running. Nothing else — no AWS, no
processor account, no emulator.

```bash
npm run dev        # or: pnpm dev
```

From a clean clone this creates `.env` (local values, fresh JWT secret, gitignored), installs,
starts Postgres 16 + Redis in Docker, migrates, seeds a demo c-store and opens:

| What | URL | Sign in with |
| --- | --- | --- |
| Admin back-office | http://localhost:3001 | `admin@adpay.local` / `adpay-demo` |
| Merchant app | http://localhost:8081 | `(201) 555-0100`, then the code shown on screen |
| Register | http://localhost:8082 | a setup code — printed by `pnpm dev`, or Admin → Merchants → Setup code |
| API | http://localhost:3000/health | — |

The demo is **Journal Square Deli & Grocery** (Jersey City NJ + Astoria NY, 4 registers, ~80 items,
three weeks of sales history) and a separate tenant, **Bayonne Corner Mart** (`(201) 555-0142`), so
tenant isolation is visible. Card sales go through the **stub** payment provider; nothing reaches a
processor. Demo logins are local-only and exist only in your throwaway database.

| Command | Does |
| --- | --- |
| `pnpm dev` | everything above; Ctrl+C stops the apps |
| `pnpm dev:reset` | wipe the local database and reseed |
| `pnpm dev --no-docker` | use your own Postgres/Redis from `.env` |
| `pnpm db:down` | stop the Postgres/Redis containers |
| `pnpm lint && pnpm typecheck && pnpm test` | what CI runs (tests need no database: PGlite) |

If `pnpm` is not found, run `corepack enable` once from an Administrator terminal, or prefix the
command with `corepack` (`corepack pnpm dev:reset`). `npm run dev` works without either.

On a phone, the merchant app can point at your laptop with `EXPO_PUBLIC_API_URL=http://<lan-ip>:3000`.
See [ADR 0007](docs/decisions/0007-local-first-development.md).

## Layout

| Path | What |
| --- | --- |
| `apps/register` | RN Android register — kiosk, dual-screen, offline-first |
| `apps/merchant` | RN iOS + Android merchant app |
| `apps/admin` | Next.js back-office |
| `packages/api` | Node + TypeScript API |
| `packages/shared` | types, money, pricing, event schemas, receipt templates |
| `infra` | AWS CDK (TypeScript) — **committed, not deployed** |

`main` is protected: changes land by pull request, CI must pass, no force-push.
