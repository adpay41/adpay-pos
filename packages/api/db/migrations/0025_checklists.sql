-- Phase 24c: opening and closing checklists (Bible 2.8; ADR 0038). The lists are merchant config
-- (null = the starter lists in @adpay/shared); what was ticked lives in sale_events as
-- checklist.completed, append-only like every register event.
ALTER TABLE merchants ADD COLUMN checklists jsonb;
