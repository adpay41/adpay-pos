# Bootstrap status — what exists outside the repo

Day-1 bootstrap, 2026-09-23. This file records the cloud and account state the next dispatch can
assume. **No secret values appear here, and none ever should.**

## GitHub

| Item | Value |
| --- | --- |
| Repository | `adpay41/adpay-pos` (private) |
| Default branch | `main` |
| CI | `.github/workflows/ci.yml` — install · lint · test, plus a gitleaks secret scan |

**Branch protection is NOT in place.** GitHub does not enforce classic branch protection or
rulesets on a **private** repository under a **Free personal** account; the console states the rule
"won't be enforced … until you move to a GitHub Team or Enterprise organization account", and it
refuses to save one. Three ways out, none of them taken yet because they are the founder's call:

1. Create an `americandreampay` **organization** and move the repo (a Team plan is paid).
2. Make the repo **public** (protection works on free public repos — not appropriate for this).
3. Leave `main` unprotected and rely on discipline plus CI on every push.

Until then, treat "PR into `main`, CI green, no force-push" as a convention rather than a guarantee.

## AWS

This is the **new AWS account experience** — an organization with per-project member accounts,
not a classic root account.

| Item | Value |
| --- | --- |
| Organization | `o-hzxqtm6mxm` |
| Management account | `903126308528` |
| Project | `Lift Off Soon` (`AmericanDreamPay`) |
| Project account (where resources live) | `512624877493` |
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

### Not done

- **IAM user `github-actions-ci`** — not created. A scoped policy was authored (ECR auth + push to
  the two repos, ECS deploy, the one S3 bucket, read `/adpay/dev/*`, KMS decrypt via SSM, PassRole
  limited to `ecs-tasks.amazonaws.com`) but the console's policy editor would not accept it
  programmatically. The JSON is in the bootstrap report; recreate it via CloudShell:
  `aws iam create-policy --policy-name adpay-github-actions-ci --policy-document file://policy.json`
- **Access keys** — deliberately not created. An access key is a long-lived credential that would
  have to be copied into GitHub; the founder creates it and pastes it himself.
  **Better option: skip the key entirely** and use GitHub's OIDC provider with an IAM *role*
  (`token.actions.githubusercontent.com`, trust scoped to `repo:adpay41/adpay-pos:*`). No long-lived
  secret, nothing to rotate, nothing to leak. Recommended before the first deploy.
- **`founder-admin` IAM user** — deliberately not created. In this account model human access goes
  through IAM Identity Center (the project's *Team* page), which the founder already uses; a
  parallel IAM user with `AdministratorAccess` would be a second, weaker way in. There is no root
  console usage to stop.
- **MFA** — the founder enrolls this himself (he has to scan the QR).
- **Billing alarms ($50 / $200) and Cost Explorer** — not set. This account model shows spend under
  *AWS Settings → Billing* with project-level controls rather than classic Budgets; available
  credits are **$0.00**, so any deployed resource bills immediately. Worth setting a project spend
  limit before the first `cdk deploy`.

### Infrastructure

`infra/` holds the CDK dev stack (VPC, RDS Postgres 16, ElastiCache Redis, ECS Fargate, ALB).
`cdk synth` was run and passes. **`cdk deploy` has not been run and must not be** until the founder
approves the cost. See [ADR 0005](decisions/0005-iac-aws-cdk.md).

## Still open

- **Finix sandbox** — the dashboard was at a login screen, not an active session, so the dashboard
  type (Software Platform), the Application ID and the API key were not retrieved. See
  [`finix-links.md`](finix-links.md) for everything that was established from public docs,
  including confirmation that the **PAX A35 is a Finix-supported terminal** over Wi-Fi/Ethernet.
- **Sentry, Google Play Console, Apple Developer, Esper/Scalefusion** — not reached in this pass.
- **GitHub Actions secrets** — none set. `AWS_*`, `FINIX_*`, `SENTRY_*` are all still empty.
