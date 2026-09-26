-- Phase 25b: referral partners and sales agents, and their residual split (Bible 3.1; ADR 0040).

-- Who the agent is. Contact details and the active flag may change; terms and assignments are
-- dated, append-only rows below.
CREATE TABLE agents (
  agent_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  kind           text NOT NULL CHECK (kind IN ('agent', 'referral', 'iso')),
  email          text,
  phone          text,
  referral_code  text NOT NULL UNIQUE CHECK (referral_code ~ '^[A-Z0-9]{4,12}$'),
  active         boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES users (user_id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- An agent's split, from a month on. A change is a new row; months already paid never move.
CREATE TABLE agent_terms (
  terms_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agents (agent_id),
  effective_from  date NOT NULL CHECK (extract(day FROM effective_from) = 1),
  basis           text NOT NULL CHECK (basis IN ('margin', 'revenue')),
  split_ppm       integer NOT NULL CHECK (split_ppm BETWEEN 0 AND 800000),
  bounty_cents    bigint NOT NULL CHECK (bounty_cents >= 0),
  created_by      uuid REFERENCES users (user_id),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_terms_agent_idx ON agent_terms (agent_id, effective_from);
CREATE TRIGGER agent_terms_append_only BEFORE UPDATE OR DELETE ON agent_terms FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Which agent a store belongs to, from a month on (null agent = none from then). Append-only.
CREATE TABLE merchant_agents (
  assignment_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  merchant_id     uuid NOT NULL,
  agent_id        uuid REFERENCES agents (agent_id),
  effective_from  date NOT NULL CHECK (extract(day FROM effective_from) = 1),
  note            text,
  created_by      uuid REFERENCES users (user_id),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
CREATE INDEX merchant_agents_merchant_idx ON merchant_agents (merchant_id, effective_from);
CREATE INDEX merchant_agents_agent_idx ON merchant_agents (agent_id);
CREATE TRIGGER merchant_agents_append_only BEFORE UPDATE OR DELETE ON merchant_agents FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
