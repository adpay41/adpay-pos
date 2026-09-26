# 0040: Referral partners and agents, residual split

- Status: Accepted
- Date: 2026-09-26
- Build plan: P25b. Bible 3.1 (referral / agent tracking, residual split)
- Extends: ADR 0022 (residuals from the ledger), ADR 0020 (dated pricing plans, onboarding)

## Decisions

### 1. Agents, dated terms, dated assignments
- **`agents`** holds who the agent is: name, kind (sales agent, referral partner, ISO), contact, a
  unique **referral code** and an active flag.
- **`agent_terms`** is append-only and dated from the first of a month. It holds:
  - the basis: a share of AD Pay's **margin** or of its **revenue** from each store;
  - the split, in ppm, at most 80%;
  - a one-time **bounty** per store going live.
- **`merchant_agents`** is append-only and dated. It records which agent a store belongs to from a
  month on; a null agent means none from then.
- In both, the row in force at month end decides (`inForce`, shared: latest start on or before the
  date, then latest written). A change of terms or agent can never rewrite a month already on a
  statement.
- A store gets its agent by the referral code in the onboarding wizard (same transaction; an unknown
  or inactive code refuses the onboarding), or by hand on the merchant page.

### 2. Statements are computed, never stored
`agentStatements(month)` takes the ADR 0022 residual report for the month (card volume, revenue,
margin per store) and, for every store assigned at month end, applies the agent's terms in force.
- **Residual:** basis × split, **rounded down to the cent**.
- **Negative basis:** a negative-margin month pays 0. There is no clawback in v1; netting across months
  is a contract question.
- **Missing cost:** a margin split with no processor cost entered for the month is **pending** (null),
  not zero. The statement counts pending stores.
- **Bounty:** paid in the month of the store's **first completed sale**, taken from the events rather
  than from a status flag.

The admin Agents page shows the month's statements and downloads them as a CSV, which is what gets
paid. Nothing about a payout is typed or stored. Like every total, it is derived from the ledger.

## Boundary
- **Paying agents** (ACH / bank transfer) happens outside the system. It would need a payouts account
  for AD Pay itself.
- **Margin** depends on the processor cost, which is typed per merchant-month until Finix data
  arrives (ADR 0022). Revenue splits are exact today.
- Multi-level splits (ISO over sub-agents) are not in v1.
