# infra — AWS CDK (TypeScript)

> **This stack has not been deployed and must not be deployed without the founder's explicit
> go-ahead.** RDS, ElastiCache, Fargate and the ALB begin billing the moment they exist.
> See [ADR 0005](../docs/decisions/0005-iac-aws-cdk.md).

## What the dev stack contains

`AdpayDevStack` (us-east-1):

- VPC — 2 AZs, public / private-with-egress / isolated subnets, 1 NAT gateway
- RDS **Postgres 16**, `db.t4g.micro`, 20 GB gp3, isolated subnets, credentials in Secrets Manager
  (`adpay/dev/db`)
- **ElastiCache Redis** `cache.t4g.micro`, single node, isolated subnets
- **ECS Fargate** cluster + API service (0 desired tasks until an image is pushed)
- **ALB**, public, HTTP :80 (TLS is added when a domain exists)

## Commands

```bash
pnpm --filter @adpay/infra install
pnpm --filter @adpay/infra synth     # safe — renders CloudFormation, creates nothing
pnpm --filter @adpay/infra diff      # safe — needs credentials, read-only
# pnpm --filter @adpay/infra exec cdk deploy AdpayDevStack   # COSTS MONEY — do not run
```

## Created outside this stack (bootstrap, by hand, on purpose)

IAM users, ECR repositories, the S3 assets bucket and the `adpay/dev/*` secrets are account-level
bootstrap. They live outside the stack so that tearing down `AdpayDevStack` cannot destroy the
account's identities or its secrets.
