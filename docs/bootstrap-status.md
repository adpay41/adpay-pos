# Bootstrap status — what exists outside the repo

Day-1 bootstrap, 2026-09-23. This file records the cloud and account state the next dispatch can
assume. **No secret values appear here, and none ever should.**

## GitHub

| Item | Value |
| --- | --- |
| Repository | `adpay41/adpay-pos` (private) |
| Default branch | `main` |
| CI | `.github/workflows/ci.yml` — install · lint · test, plus a gitleaks secret scan |

### Repository visibility — going public, on purpose (pending)

**This repository is still PRIVATE — the flip to public has not happened yet.** The founder
approved making it public, for one reason only: GitHub does not enforce branch protection or
rulesets on a **private** repository under a **Free personal** account, and he chose free-tier
protection over privacy for the build phase. The change could not be completed from automation
(GitHub's Danger Zone visibility confirmation does not take effect from scripted clicks), so it is
a manual step: **Settings → General → Danger Zone → Change visibility → Change to public**.

Everything below describes the intended end state. Branch protection cannot be configured until the
repo is public.

**Flip it back to private at ship.** And know what that does and does not do:

- Going private later **does not undo public exposure**. Anything published here — every commit,
  every file, every line of history — may already have been cloned, cached, forked, indexed by
  search engines, or ingested by a crawler. Treat everything in this history as permanently public.
- It follows that **nothing sensitive may ever be committed here**, and that stays true after the
  repo goes private again. No keys, no tokens, no customer data, no merchant data, no card data.
  `.env.example` carries empty values and always will. Real values live in AWS Parameter Store
  (`/adpay/dev/*`) and GitHub Actions secrets.
- When the repo goes private, branch protection stops being enforced again unless the repo has
  moved to an organization on a paid plan by then.

Before publishing, the history was scanned: gitleaks over the **full** history
(`fetch-depth: 0`, CI run #15 on `4cd096a`) reported **no leaks**, a tree-wide scan for AWS keys,
private keys and token patterns found nothing, and every credential-bearing variable in
`.env.example` was confirmed empty. That scan runs on every push and must stay green.

### Branch protection — NOT YET IN PLACE

Blocked on the visibility flip above. Once the repo is public, protect `main` with a branch ruleset: pull request required before merging, the CI checks
(`install · lint · test` and `no committed secrets`) must pass, force pushes blocked, deletions
blocked. Required approvals are **0** — this is a solo build, so the PR requirement exists to run
CI and leave a reviewable diff, not to wait for another human.

## AWS

This is the **new AWS account experience** — an organization with per-project member accounts,
not a classic root account.

| Item | Value |
| --- | --- |
| Project | `Lift Off Soon` (`AmericanDreamPay`) |
| Project account (where resources live) | `512624877493` — unavoidably public: it is embedded in the ECR URIs and the CI role ARN below |
| **Region** | **`us-east-2` (Ohio)** — see the deviation below |
| Console | Sign in → choose the `Lift Off Soon` session |

### Deviation: region is us-east-2, not us-east-1

The dispatch specified `us-east-1`. The project account is pinned to its selected region by a
service control policy — the console answers `us-east-1` with *"Region United States (N. Virginia)
unavailable"* and offers only "take me to my selected Region" or "Activate advanced features"
(which converts the account to full self-management). Activating advanced features is an
account-level change that was not made unilaterally.

Everything below was therefore created in **us-east-2**. Nothing is deployed, so switching later is
cheap: either activate advanced features and recreate these few resources in `us-east-1`, or accept
`us-east-2` and set `AWS_REGION=us-east-2` everywhere (`.env.example`, CI, `infra/`). NJ/NYC
merchants will not notice the ~10 ms difference.

### Created

| Kind | Name / ID |
| --- | --- |
| ECR repository | `adpay-api` → `512624877493.dkr.ecr.us-east-2.amazonaws.com/adpay-api` |
| ECR repository | `adpay-admin` → `512624877493.dkr.ecr.us-east-2.amazonaws.com/adpay-admin` |
| S3 bucket | `adpay-dev-assets-7k3q9m` (us-east-2, private, **versioning on**) |
| SSM parameter | `/adpay/dev/jwt` — SecureString, **populated** with a freshly generated 64-character secret |
| SSM parameter | `/adpay/dev/finix` — SecureString, placeholder JSON (`api_key`, `api_secret`, `application_id`, `env`) |
| SSM parameter | `/adpay/dev/db` — SecureString, placeholder JSON (filled when the CDK stack is deployed) |

### Deviation: SSM Parameter Store instead of Secrets Manager

The dispatch asked for Secrets Manager. Secrets Manager bills **$0.40 per secret per month** after
a 30-day trial — three secrets is roughly $1.20/month, which collides with the "free tiers only"
hard rule. **SSM Parameter Store Standard SecureStrings are free** and cover the same need: KMS
encryption at rest, IAM-scoped reads, and first-class ECS/CDK integration
(`ecs.Secret.fromSsmParameter`, `ssm.StringParameter.valueForSecureStringParameter`).

If the founder would rather pay for Secrets Manager (it does add native rotation, which matters
more once the processor is live), the names map one-to-one: `/adpay/dev/jwt` → `adpay/dev/jwt`,
and so on. `infra/lib/adpay-dev-stack.ts` currently generates the DB credential into Secrets
Manager via `rds.Credentials.fromGeneratedSecret` — that is RDS's own managed secret and is worth
keeping either way.

### CI credentials — GitHub OIDC, no long-lived keys

There is **no AWS access key** for CI and there should never be one. CI authenticates with GitHub's
OIDC provider and mints short-lived credentials per run.

| Piece | Value | State |
| --- | --- | --- |
| IAM role | `arn:aws:iam::512624877493:role/adpay-github-actions-ci` | **created** |
| Trust | `sts:AssumeRoleWithWebIdentity`, `aud = sts.amazonaws.com`, `sub` like `repo:adpay41/adpay-pos:*` | **created** |
| Managed policy | `arn:aws:iam::512624877493:policy/adpay-github-actions-ci` | **created and attached** |
| Workflow | `.github/workflows/aws-oidc-check.yml` | **committed** |
| **IAM OIDC identity provider** (`token.actions.githubusercontent.com`) | — | **BLOCKED** |

**The one missing piece:** `iam:CreateOpenIDConnectProvider` is denied by an organization service
control policy on this managed project account:

```
AccessDenied … CreateOpenIDConnectProvider on resource
arn:aws:iam::512624877493:oidc-provider/token.actions.githubusercontent.com
with an explicit deny in a service control policy
```

`iam:ListOpenIDConnectProviders` is denied too, so no provider can be created or even listed here.
The role and policy are ready and waiting; the trust path simply cannot complete until the provider
exists. Unblocking it means **Activate advanced features** on the project (AWS Settings → Projects),
which hands account management over from AWS's managed guardrails — a real decision, not made here.

Until then, `aws-oidc-check.yml` fails at the credentials step with
*"Not authorized to perform sts:AssumeRoleWithWebIdentity"*. That is expected. Nothing in CI needs
AWS yet: lint and test do not touch it, and the infra stack is not deployed.

The policy grants exactly: ECR auth plus push/pull limited to `adpay-api` and `adpay-admin`; ECS
describe/register/update; `iam:PassRole` limited to `ecs-tasks.amazonaws.com`; read/write on
`adpay-dev-assets-7k3q9m` only; read on `/adpay/dev/*` only; and `kms:Decrypt` only via SSM.

### Cost controls

| Control | Value |
| --- | --- |
| **Project spend limit (hard cap)** | **$20.00/month** on `Lift Off Soon` — at the limit the project is **paused** |
| Early control: stop new resource launches | on (~7 days before the limit) |
| Early control: pause idle resources | on (~5 days before the limit) |
| Early control: pause top cost drivers | on (~4 days before the limit) |
| Built-in notifications | 50% / 75% / 90% of the limit = **$10 / $15 / $18**, plus an on-track-to-exceed warning |
| AWS Budget `adpay-dev-10usd` | **$10.00/month**, email alerts at 80% actual, 100% actual, 100% forecast |

**The requested ceiling was $10; AWS's minimum project spend limit is $20.** So the hard cap sits at
$20 — the lowest value the account allows — and the $10 line is covered two ways: the built-in 50%
notification lands exactly at $10, and a separate AWS Budget alerts at $10. A $20 ceiling is not a
commitment to spend $20; nothing spends on its own, and the stack is not deployed.

### Deliberately not done

- **`founder-admin` IAM user** — human access goes through IAM Identity Center (the project's *Team*
  page), which the founder already uses. A parallel IAM user with `AdministratorAccess` would be a
  second, weaker door. There is no root console usage to stop.
- **MFA** — the founder enrolls this himself; it needs a QR scan.

## Finix — running on AD11's sandbox, on purpose

> ⚠️ **Migration debt.** See **[ADR 0006](decisions/0006-finix-sandbox-entity-migration.md)** —
> read it before touching the payment layer.

The sandbox belongs to **AmericanDream11 LLC**, not American Dream Pay LLC. The founder decided on
2026-09-23 to **build v1 against it and migrate to an AD Pay LLC account before going live**. That
is a release blocker for production, not a backlog item: new underwriting, new Application /
Merchant / Identity IDs, new keys and webhooks, every merchant re-onboarded, every terminal
re-provisioned, and settlement re-pointed so money lands in AD Pay's bank account.

Dashboard type is confirmed **Software Platform**. Wired into dev config:

| Parameter | Contents |
| --- | --- |
| `/adpay/dev/finix` (SecureString) | `env`, `base_url`, `application_id`, `merchant_id`, `merchant_identity_id`, `entity`, and **empty** `api_key` / `api_secret` |

`application_id` is `AP8CpWQcq7CiSMyRDCVuuqE6`. The `entity` field reads
`AmericanDream11 LLC (TEMPORARY - migrate before live)` — leave that string there until the account
actually changes. **No AD11 identifier is committed to this repository**, and `.env.example` stays
empty.

Treat everything produced against this sandbox as disposable. Nothing built may assume a Finix id
survives the migration.

## Sentry

Organization **`americandream-pay-llc`** — correct entity, already existed.

| Project | Platform | For |
| --- | --- | --- |
| `adpay-register` | React Native | `apps/register` |
| `adpay-merchant` | React Native | `apps/merchant` |
| `adpay-api` | Node.js | `packages/api` |

DSNs are in Parameter Store (a Sentry DSN is designed to ship inside a client build; it is an
identifier, not a credential, so these are plain `String` parameters):

- `/adpay/dev/sentry/dsn-register`
- `/adpay/dev/sentry/dsn-merchant`
- `/adpay/dev/sentry/dsn-api`
- `/adpay/dev/sentry/org` → `americandream-pay-llc`

**Not done: the source-maps auth token.** A Sentry auth token is a real credential. Create it at
*Settings → Developer Settings → Auth Tokens* with `project:releases` and `org:read`, then put it
straight into the GitHub Actions secret `SENTRY_AUTH_TOKEN` and
`aws ssm put-parameter --name /adpay/dev/sentry/auth-token --type SecureString`. It is shown once.

## Store accounts

### Google Play Console — no account under the AD Pay address; nothing created

Four Google accounts are signed in to this browser. Their Play developer status:

| Google account | Play developer account |
| --- | --- |
| `nihalhari41@gmail.com` | **Prophecy** |
| `patelnihalhari41@gmail.com` | **AmericanDream11 LLC** |
| `americandream11limited@gmail.com` | none — lands on the signup flow |
| **`americandreampayllc@gmail.com`** | **none** — lands on signup, and blocked there: *"To create a developer account, turn on 2-step verification for your Google account"* |

So there is no American Dream Pay LLC Play developer account, and **no app entry was created
anywhere**. Creating one costs $25 and is an account signup — outside what automation does here.

This is the right outcome rather than a workaround: **a Play app entry cannot be deleted.** Once
`us.americandreampay.merchant` is created under a developer account, the package name is
permanently bound to it — unpublishable and archivable, never removable, never reusable elsewhere.
Creating it under "Prophecy" or "AmericanDream11 LLC" would burn the name for the real AD Pay
account.

To unblock, in this order: turn on 2-step verification for `americandreampayllc@gmail.com`, pay the
$25 one-time Google Play developer registration as an **Organization** (AD Pay LLC), complete
Google's organization verification, then create the app entry.

Package names, once that exists:

| App | Package | Distribution |
| --- | --- | --- |
| Merchant app | `us.americandreampay.merchant` | Play listing |
| Register | `us.americandreampay.register` | **sideloaded, no Play listing** |

### Apple Developer — not signed in

`developer.apple.com/account` redirects to sign-in, so verification status could not be read and no
bundle ID or App Store Connect record was created. Signing in needs the founder (password, and
Apple enforces 2FA).

## Device management (Esper / Scalefusion)

**No account exists.** Both `id.esper.cloud` and `app.scalefusion.com` present sign-in pages with no
active session. Per the dispatch, skipped — the design doc decides Esper vs. building OTA
ourselves, and the spec keeps v1 on ADB `dpm set-device-owner` regardless.

## Infrastructure

`infra/` holds the CDK dev stack (VPC, RDS Postgres 16, ElastiCache Redis, ECS Fargate, ALB).
`cdk synth` was run and passes. **`cdk deploy` has not been run and must not be** until the founder
approves the cost. See [ADR 0005](decisions/0005-iac-aws-cdk.md).

## Still open

- **Finix API key** — `/adpay/dev/finix` ships with `api_key` and `api_secret` **empty**. The
  founder creates the key by hand (Dashboard → Developer → Create API Key; shown once) and sets it
  himself. Automation never handles it.
- **Repo visibility + branch protection** — see above; both need the founder's hands.
- **GitHub Actions secrets** — none set. `FINIX_*`, `SENTRY_AUTH_TOKEN` and anything else still
  empty. There is deliberately no `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`: CI uses OIDC.
- **IAM OIDC identity provider** — blocked by an SCP; needs *Activate advanced features*.
- **MFA** — founder enrolls.
