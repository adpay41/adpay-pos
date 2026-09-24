-- Phase 17: lottery module (Bible 1.4; ADR 0027). Scratch-off games and packs per location, daily
-- bin counts (append-only: a recount is a new count), and the state terminal's daily report typed in.
-- Money is BIGINT cents; every row carries its tenancy.

CREATE TABLE lottery_games (
  game_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  merchant_id       uuid NOT NULL,
  location_id       uuid NOT NULL,
  game_number       text NOT NULL CHECK (game_number ~ '^[0-9]{3,5}$'),
  name              text NOT NULL,
  price_cents       bigint NOT NULL CHECK (price_cents BETWEEN 100 AND 10000),
  tickets_per_pack  integer NOT NULL CHECK (tickets_per_pack BETWEEN 10 AND 1000),
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, game_number),
  FOREIGN KEY (org_id, merchant_id, location_id) REFERENCES locations (org_id, merchant_id, location_id)
);

CREATE TABLE lottery_packs (
  pack_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  merchant_id   uuid NOT NULL,
  location_id   uuid NOT NULL,
  game_id       uuid NOT NULL REFERENCES lottery_games (game_id),
  pack_number   text NOT NULL CHECK (pack_number ~ '^[0-9]{4,10}$'),
  status        text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'active', 'sold_out', 'returned')),
  bin           integer CHECK (bin BETWEEN 1 AND 99),
  start_ticket  integer NOT NULL DEFAULT 0,
  received_at   timestamptz NOT NULL DEFAULT now(),
  received_by   uuid REFERENCES users (user_id),
  activated_at  timestamptz,
  activated_by  uuid REFERENCES users (user_id),
  closed_at     timestamptz,
  UNIQUE (game_id, pack_number)
);
CREATE INDEX lottery_packs_location_idx ON lottery_packs (location_id, status);
-- One active pack per bin.
CREATE UNIQUE INDEX lottery_packs_bin_idx ON lottery_packs (location_id, bin) WHERE status = 'active';

CREATE TABLE lottery_counts (
  count_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  merchant_id    uuid NOT NULL,
  location_id    uuid NOT NULL,
  business_date  date NOT NULL,
  entries        jsonb NOT NULL,
  counted_by     uuid REFERENCES users (user_id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  trace_id       text NOT NULL
);
CREATE INDEX lottery_counts_idx ON lottery_counts (location_id, business_date, created_at);
CREATE TRIGGER lottery_counts_append_only BEFORE UPDATE OR DELETE ON lottery_counts
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE lottery_terminal_reports (
  org_id              uuid NOT NULL,
  merchant_id         uuid NOT NULL,
  location_id         uuid NOT NULL,
  business_date       date NOT NULL,
  online_sales_cents  bigint NOT NULL,
  cashes_cents        bigint NOT NULL,
  instant_sales_cents bigint,
  entered_by          uuid REFERENCES users (user_id),
  entered_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, business_date)
);
