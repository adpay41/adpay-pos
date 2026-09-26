-- Phase 24a: support tickets, hardware inventory and RMA (Bible 3.2, 2.8; ADR 0036).
CREATE TABLE support_tickets (
  ticket_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  merchant_id        uuid NOT NULL,
  location_id        uuid,
  register_id        uuid REFERENCES registers (register_id),
  sale_id            uuid,
  subject            text NOT NULL CHECK (length(subject) BETWEEN 3 AND 120),
  body               text NOT NULL DEFAULT '',
  category           text NOT NULL CHECK (category IN ('general', 'hardware', 'payments', 'software')),
  priority           text NOT NULL CHECK (priority IN ('normal', 'urgent')),
  status             text NOT NULL CHECK (status IN ('open', 'pending', 'solved')),
  source             text NOT NULL CHECK (source IN ('admin', 'merchant')),
  created_by         uuid REFERENCES users (user_id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  sla_due_at         timestamptz NOT NULL,
  first_response_at  timestamptz,
  solved_at          timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, merchant_id) REFERENCES merchants (org_id, merchant_id)
);
CREATE INDEX support_tickets_status_idx ON support_tickets (status, sla_due_at);
CREATE INDEX support_tickets_merchant_idx ON support_tickets (merchant_id, created_at DESC);

-- The ticket's history: notes, canned fixes applied, remote actions pressed, status changes. Append-only.
CREATE TABLE ticket_notes (
  note_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id            uuid NOT NULL REFERENCES support_tickets (ticket_id),
  author_user_id       uuid REFERENCES users (user_id),
  author_kind          text NOT NULL CHECK (author_kind IN ('admin', 'merchant_user', 'system')),
  body                 text NOT NULL,
  canned_fix           text,
  action_id            uuid,
  status_to            text,
  visible_to_merchant  boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_notes_ticket_idx ON ticket_notes (ticket_id, created_at);
CREATE TRIGGER ticket_notes_append_only BEFORE UPDATE OR DELETE ON ticket_notes FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Hardware we own or install: which unit is where, its warranty, and its history (swap, RMA).
CREATE TABLE hardware_units (
  unit_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('register', 'printer', 'scanner', 'terminal', 'drawer', 'customer_display', 'router')),
  model           text NOT NULL,
  serial          text NOT NULL UNIQUE,
  warranty_until  date,
  note            text,
  status          text NOT NULL CHECK (status IN ('in_stock', 'installed', 'rma', 'retired')),
  org_id          uuid,
  merchant_id     uuid,
  location_id     uuid,
  register_id     uuid REFERENCES registers (register_id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'installed') = (merchant_id IS NOT NULL))
);
CREATE TABLE hardware_events (
  event_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id     uuid NOT NULL REFERENCES hardware_units (unit_id),
  kind        text NOT NULL CHECK (kind IN ('added', 'installed', 'removed', 'rma_opened', 'rma_closed', 'retired')),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ticket_id   uuid REFERENCES support_tickets (ticket_id),
  actor_user_id uuid REFERENCES users (user_id),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hardware_events_unit_idx ON hardware_events (unit_id, at);
CREATE TRIGGER hardware_events_append_only BEFORE UPDATE OR DELETE ON hardware_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
