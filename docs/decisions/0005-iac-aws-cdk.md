# 0005 — AWS CDK (TypeScript) for infrastructure as code

- Status: Accepted
- Date: 2026-09-23
- Source: Bootstrap dispatch §3 ("AWS CDK in TypeScript or Terraform; pick one, document in an ADR")

## Context

The dev environment needs a VPC, RDS Postgres 16, ElastiCache Redis, an ECS Fargate cluster and an
ALB. None of it may be created by hand, and **none of it may be deployed until the founder approves
the cost**. The team is TypeScript end to end (RN, Next.js, Node API) and is, for now, one person
plus dispatched agents.

## Decision

**AWS CDK v2 in TypeScript**, living in `infra/` as a workspace package, with a `dev` stack.

## Consequences

- One language across the whole repo. The same `pnpm install`, the same tsconfig, the same review
  habits; no HCL context-switch and no second toolchain to install on a new machine.
- CDK's L2 constructs give sane, secure defaults (security groups, subnet placement, secret
  wiring) with far less code than raw CloudFormation or Terraform resources — which matters when
  the whole ops budget is one person for 200 stores.
- Database credentials are wired from **Secrets Manager** by reference. The CDK code never contains
  a credential, and `cdk synth` output is safe to commit to the build log.
- State lives in CloudFormation. No state bucket, no lock table, no state file to lose — one less
  thing to operate. The trade is slower stack updates and CloudFormation's rollback behaviour.
- **`cdk deploy` has not been run.** `infra/` is committed and synthesizable only. RDS, ElastiCache,
  Fargate and the ALB start billing the moment they exist, so deployment waits for an explicit go.
- Drift from console-created resources (the IAM users, ECR repos, S3 bucket and secrets created by
  hand during bootstrap) is deliberate: those are account-level bootstrap, documented in
  `infra/README.md`, and deliberately outside the stack so that destroying the dev stack cannot
  destroy the account's identity or its secrets.

## Rejected

- **Terraform** — excellent, and the right answer for a polyglot team with a platform engineer.
  Here it adds a second language, a second toolchain and remote state to operate, for benefits
  (provider breadth, plan output) this project does not yet need.
- **Console-clicked infrastructure** — explicitly forbidden by the dispatch, and unrepeatable.
