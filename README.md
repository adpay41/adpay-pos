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

### How to log in (local demo — fixed values)

| What | URL | Sign in with |
| --- | --- | --- |
| Admin back-office | http://localhost:3001 | `admin@adpay.local` / `adpay-demo` (AD Pay platform admin, sees every tenant) |
| Merchant app | http://localhost:8081 | phone `2015550100`, then code **`123456`** |
| Register | http://localhost:8082 | setup code **`JSQ3-DEMO`** |
| API | http://localhost:3000/health | — |

**Merchant app phones.** Dev mode sends no SMS; the code is always `123456` and is also shown on screen.

| Phone | Who | Sees |
| --- | --- | --- |
| `2015550100` | Nadia Haddad, owner | Journal Square Deli & Grocery |
| `2015550101` | Luis Ortega, manager | Journal Square Deli & Grocery |
| `2015550142` | Kevin Walsh, owner | Bayonne Corner Mart (a separate tenant) |

**Register PINs.** The register asks "Who's working?": tap your name and enter the PIN. Every
`npm run dev` and `npm run logins` makes sure these people exist with these PINs (an older database
catches up), prints them, and says if one was changed in the app:

| Person | Role | PIN | Store |
| --- | --- | --- | --- |
| Nadia Haddad | owner | `2580` | Journal Square |
| Luis Ortega | manager | `1357` | Journal Square |
| Maria Santos | cashier (register only, no app) | `2468` | Journal Square |
| Dev Patel | cashier (register only, no app) | `3690` | Journal Square |
| Kevin Walsh | owner | `2580` | Bayonne Corner Mart |
| Aisha Khan | cashier (register only, no app) | `4826` | Bayonne Corner Mart |

A manager or owner PIN approves anything a cashier's role doesn't allow (a "manager override").
Five wrong PINs lock that person out on that register for 5 minutes.

**Register setup codes.** Each code pairs one register:

| Code | Register |
| --- | --- |
| `JSQ3-DEMO` | Journal Square · Jersey City · Register 3 (new, no sales history) |
| `JSQ1-DEMO` | Journal Square · Jersey City · Register 1 |
| `JSQ2-DEMO` | Journal Square · Jersey City · Register 2 |
| `AST1-DEMO` | Journal Square · Astoria NY · Register 1 |
| `BAY1-DEMO` | Bayonne Corner Mart · Register 1 |

A code works once. Every `npm run dev` re-arms all five. To re-arm them without restarting, run
`npm run logins`, which also prints this list. Pairing a register again (with a code, from any browser)
signs out whichever device held it before. For a register you created yourself, use
Admin → Merchants → **Setup code**, which issues a random 24-hour code.

These values exist only in development: the API refuses to start in production with dev-mode OTP,
and the seed refuses to run against a production database.

The demo is **Journal Square Deli & Grocery** (Jersey City NJ + Astoria NY, 4 registers, ~80 items,
three weeks of sales history) and a separate tenant, **Bayonne Corner Mart** (`(201) 555-0142`), so
tenant isolation is visible. Card sales go through the **stub** payment provider; nothing reaches a
processor. The stub approves every amount except those ending in **.13** (e.g. $1.13), which it
declines, so the decline path can be clicked through. Demo logins are local-only and exist only in your throwaway database.

| Command | Does |
| --- | --- |
| `pnpm dev` | everything above; Ctrl+C stops the apps |
| `pnpm dev:reset` | wipe the local database and reseed |
| `pnpm dev --no-docker` | use your own Postgres/Redis from `.env` |
| `pnpm db:down` | stop the Postgres/Redis containers |
| `npm run test:pg` | the full suite with database tests on the real Docker Postgres — **what CI runs** |
| `pnpm test` | quick loop: database tests on PGlite (in-process), no Docker needed; not authoritative |
| `pnpm lint && pnpm typecheck` | the other CI checks |

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
