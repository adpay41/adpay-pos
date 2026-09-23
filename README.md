# AD Pay POS

Multi-vertical retail POS for American Dream Pay LLC. v1 is the convenience-store pack on a
dual-screen Android register, with a merchant mobile app and a back-office admin.

- **Spec:** [`docs/spec-v1-cstore.md`](docs/spec-v1-cstore.md)
- **Working agreement, fixed decisions, sequencing:** [`CLAUDE.md`](CLAUDE.md)
- **ADRs:** [`docs/decisions/`](docs/decisions/)
- **Processor links:** [`docs/finix-links.md`](docs/finix-links.md)

## Getting started

```bash
nvm use            # Node 20 LTS
corepack enable
pnpm install
pnpm lint && pnpm test
cp .env.example .env   # fill locally; never commit it
```

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
