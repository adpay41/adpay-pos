/**
 * Support tickets and hardware (P24a, ADR 0036).
 *
 * A ticket is linked to a store, and optionally a register and a sale. It carries a first-response SLA
 * (urgent 4 h, normal 24 h); the first note from AD Pay stamps the response. A canned fix writes its
 * steps as a note and, when it has one, presses the remote action on the ticket's register through the
 * same audited path the device page uses. Notes are append-only.
 *
 * Hardware units move between stock, installed (at a register or store), RMA and retired; every move
 * is an append-only event, and a swap is "remove + RMA the old, install the new" in one transaction.
 */
import {
  CANNED_FIXES,
  SLA_MINUTES,
  type CannedFixKey,
  type HardwareInput,
  type TicketInput,
  type TicketStatus,
} from '@adpay/shared';
import type { AdminPrincipal, MerchantUserPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { badRequest, notFound } from '../http/errors';
import { audit } from './audit';
import { requestAction } from './ops';

type Actor = AdminPrincipal | MerchantUserPrincipal;

async function tenancyOf(q: Queryable, merchantId: string, registerId: string | null) {
  const { rows } = await q.query<{ org_id: string }>('SELECT org_id FROM merchants WHERE merchant_id = $1', [merchantId]);
  if (!rows[0]) throw notFound('Merchant not found');
  let locationId: string | null = null;
  if (registerId) {
    const { rows: r } = await q.query<{ location_id: string }>('SELECT location_id FROM registers WHERE register_id = $1 AND merchant_id = $2', [registerId, merchantId]);
    if (!r[0]) throw badRequest('That register isn’t this store’s');
    locationId = r[0].location_id;
  }
  return { org_id: rows[0].org_id, location_id: locationId };
}

export async function createTicket(db: Db, actor: Actor, t: TicketInput & { source: 'admin' | 'merchant' }, traceId: string) {
  return db.tx(async (q) => {
    const ten = await tenancyOf(q, t.merchant_id, t.register_id);
    const { rows } = await q.query<{ ticket_id: string }>(
      `INSERT INTO support_tickets (org_id, merchant_id, location_id, register_id, sale_id, subject, body, category, priority, status, source, created_by, sla_due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10, $11, now() + make_interval(mins => $12)) RETURNING ticket_id`,
      [ten.org_id, t.merchant_id, ten.location_id ?? t.location_id, t.register_id, t.sale_id, t.subject, t.body, t.category, t.priority, t.source, actor.user_id, SLA_MINUTES[t.priority]],
    );
    const id = rows[0]!.ticket_id;
    await audit(q, { actor, action: 'ticket.opened', tenancy: { org_id: ten.org_id, merchant_id: t.merchant_id }, target: id, details: { subject: t.subject, category: t.category, priority: t.priority, source: t.source }, trace_id: traceId });
    return { ticket_id: id };
  });
}

export async function listTickets(q: Queryable, opts: { merchantId?: string; status?: TicketStatus | 'active' } = {}) {
  const { rows } = await q.query<{
    ticket_id: string; merchant_id: string; merchant_name: string; register_name: string | null; subject: string; category: string; priority: 'normal' | 'urgent';
    status: TicketStatus; source: string; created_at: Date; sla_due_at: Date; first_response_at: Date | null; solved_at: Date | null; notes: number;
  }>(
    `SELECT t.ticket_id, t.merchant_id, m.name AS merchant_name, r.name AS register_name, t.subject, t.category, t.priority, t.status, t.source,
            t.created_at, t.sla_due_at, t.first_response_at, t.solved_at, (SELECT count(*)::int FROM ticket_notes n WHERE n.ticket_id = t.ticket_id) AS notes
       FROM support_tickets t JOIN merchants m ON m.merchant_id = t.merchant_id LEFT JOIN registers r ON r.register_id = t.register_id
      WHERE ($1::uuid IS NULL OR t.merchant_id = $1)
        AND ($2::text IS NULL OR ($2 = 'active' AND t.status <> 'solved') OR t.status = $2)
      ORDER BY (t.status = 'solved'), (t.first_response_at IS NULL) DESC, t.sla_due_at
      LIMIT 200`,
    [opts.merchantId ?? null, opts.status ?? null],
  );
  return rows.map((r) => ({
    ...r,
    created_at: r.created_at.toISOString(),
    sla_due_at: r.sla_due_at.toISOString(),
    first_response_at: r.first_response_at?.toISOString() ?? null,
    solved_at: r.solved_at?.toISOString() ?? null,
  }));
}

export async function ticketDetail(q: Queryable, ticketId: string, merchantId: string | null) {
  const list = await q.query<Record<string, unknown> & { merchant_id: string; created_at: Date; sla_due_at: Date; first_response_at: Date | null; solved_at: Date | null }>(
    `SELECT t.*, m.name AS merchant_name, r.name AS register_name, l.name AS location_name
       FROM support_tickets t JOIN merchants m ON m.merchant_id = t.merchant_id
       LEFT JOIN registers r ON r.register_id = t.register_id LEFT JOIN locations l ON l.location_id = t.location_id
      WHERE t.ticket_id = $1 AND ($2::uuid IS NULL OR t.merchant_id = $2)`,
    [ticketId, merchantId],
  );
  const t = list.rows[0];
  if (!t) throw notFound('Ticket not found');
  const { rows: notes } = await q.query<{ note_id: string; author_kind: string; author: string | null; body: string; canned_fix: string | null; action_id: string | null; status_to: string | null; visible_to_merchant: boolean; created_at: Date }>(
    `SELECT n.note_id, n.author_kind, u.name AS author, n.body, n.canned_fix, n.action_id, n.status_to, n.visible_to_merchant, n.created_at
       FROM ticket_notes n LEFT JOIN users u ON u.user_id = n.author_user_id
      WHERE n.ticket_id = $1 AND ($2::uuid IS NULL OR n.visible_to_merchant) ORDER BY n.created_at`,
    [ticketId, merchantId],
  );
  return {
    ...t,
    created_at: t.created_at.toISOString(),
    sla_due_at: t.sla_due_at.toISOString(),
    first_response_at: t.first_response_at?.toISOString() ?? null,
    solved_at: t.solved_at?.toISOString() ?? null,
    notes: notes.map((n) => ({ ...n, created_at: n.created_at.toISOString() })),
  };
}

/**
 * A note on a ticket. From AD Pay it can apply a canned fix (its steps become the note, its remote
 * action is pressed on the ticket's register) and change the status. The first AD Pay note stamps the
 * first response (the SLA clock stops).
 */
export async function addTicketNote(
  db: Db,
  actor: Actor,
  ticketId: string,
  body: { body: string; canned_fix?: CannedFixKey | null; status?: TicketStatus | null; internal?: boolean },
  traceId: string,
) {
  const { rows } = await db.query<{ merchant_id: string; org_id: string; register_id: string | null; status: TicketStatus }>('SELECT merchant_id, org_id, register_id, status FROM support_tickets WHERE ticket_id = $1', [ticketId]);
  const t = rows[0];
  if (!t) throw notFound('Ticket not found');
  if (actor.kind === 'merchant_user' && actor.merchant_id !== t.merchant_id) throw notFound('Ticket not found');
  const fix = body.canned_fix ? CANNED_FIXES[body.canned_fix] : null;
  const text = [fix?.steps, body.body.trim()].filter(Boolean).join('\n\n');
  if (!text && !body.status) throw badRequest('Write something, pick a fix, or change the status');
  let actionId: string | null = null;
  if (fix?.action && actor.kind === 'admin') {
    if (!t.register_id) throw badRequest('This fix presses a button on a register; link the ticket to one first');
    actionId = (await requestAction(db, actor, t.register_id, fix.action, {}, traceId)).action_id;
  }
  await db.tx(async (q) => {
    const fromAdPay = actor.kind === 'admin';
    await q.query(
      `INSERT INTO ticket_notes (ticket_id, author_user_id, author_kind, body, canned_fix, action_id, status_to, visible_to_merchant) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [ticketId, actor.user_id, actor.kind, text || `Status: ${body.status}`, body.canned_fix ?? null, actionId, body.status ?? null, !(fromAdPay && body.internal)],
    );
    // A merchant's reply puts a pending ticket back in AD Pay's queue.
    const status = body.status ?? (!fromAdPay && t.status === 'pending' ? 'open' : null);
    await q.query(
      `UPDATE support_tickets SET updated_at = now(),
              first_response_at = CASE WHEN $2 AND first_response_at IS NULL AND NOT $4 THEN now() ELSE first_response_at END,
              status = coalesce($3, status),
              solved_at = CASE WHEN $3 = 'solved' THEN now() WHEN $3 IS NOT NULL THEN NULL ELSE solved_at END
        WHERE ticket_id = $1`,
      [ticketId, fromAdPay, status, !!body.internal],
    );
    await audit(q, { actor, action: 'ticket.noted', tenancy: { org_id: t.org_id, merchant_id: t.merchant_id }, target: ticketId, details: { canned_fix: body.canned_fix ?? null, action_id: actionId, status: status ?? null, internal: !!body.internal }, trace_id: traceId });
  });
  return { ticket_id: ticketId, action_id: actionId };
}

// --- Hardware --------------------------------------------------------------------------------------

export async function listHardware(q: Queryable, merchantId: string | null) {
  const { rows } = await q.query<Record<string, unknown> & { warranty_until: string | null; updated_at: Date }>(
    `SELECT h.unit_id, h.kind, h.model, h.serial, to_char(h.warranty_until, 'YYYY-MM-DD') AS warranty_until, h.note, h.status, h.merchant_id,
            m.name AS merchant_name, l.name AS location_name, r.name AS register_name, h.updated_at
       FROM hardware_units h LEFT JOIN merchants m ON m.merchant_id = h.merchant_id LEFT JOIN locations l ON l.location_id = h.location_id
       LEFT JOIN registers r ON r.register_id = h.register_id
      WHERE ($1::uuid IS NULL OR h.merchant_id = $1)
      ORDER BY h.status, m.name NULLS FIRST, h.kind, h.serial`,
    [merchantId],
  );
  return rows.map((r) => ({ ...r, updated_at: r.updated_at.toISOString() }));
}

async function hwEvent(q: Queryable, unitId: string, kind: string, detail: object, actor: AdminPrincipal, ticketId: string | null) {
  // clock_timestamp, not now(): several events in one transaction keep their order.
  await q.query('INSERT INTO hardware_events (unit_id, kind, detail, ticket_id, actor_user_id, at) VALUES ($1, $2, $3, $4, $5, clock_timestamp())', [unitId, kind, JSON.stringify(detail), ticketId, actor.user_id]);
}

export async function addHardware(db: Db, actor: AdminPrincipal, h: HardwareInput, traceId: string) {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ unit_id: string }>(
      `INSERT INTO hardware_units (kind, model, serial, warranty_until, note, status) VALUES ($1, $2, $3, $4, $5, 'in_stock') RETURNING unit_id`,
      [h.kind, h.model, h.serial, h.warranty_until, h.note],
    );
    await hwEvent(q, rows[0]!.unit_id, 'added', h, actor, null);
    await audit(q, { actor, action: 'hardware.added', target: rows[0]!.unit_id, details: h, trace_id: traceId });
    return { unit_id: rows[0]!.unit_id };
  });
}

async function install(q: Queryable, unitId: string, registerId: string, actor: AdminPrincipal, ticketId: string | null) {
  const { rows: r } = await q.query<{ org_id: string; merchant_id: string; location_id: string }>('SELECT org_id, merchant_id, location_id FROM registers WHERE register_id = $1', [registerId]);
  if (!r[0]) throw notFound('Register not found');
  const { rows } = await q.query<{ status: string }>('SELECT status FROM hardware_units WHERE unit_id = $1 FOR UPDATE', [unitId]);
  if (!rows[0]) throw notFound('Unit not found');
  if (rows[0].status !== 'in_stock') throw badRequest('Only a unit in stock can be installed');
  await q.query(
    "UPDATE hardware_units SET status = 'installed', org_id = $2, merchant_id = $3, location_id = $4, register_id = $5, updated_at = now() WHERE unit_id = $1",
    [unitId, r[0].org_id, r[0].merchant_id, r[0].location_id, registerId],
  );
  await hwEvent(q, unitId, 'installed', { register_id: registerId }, actor, ticketId);
  return r[0];
}

export async function installHardware(db: Db, actor: AdminPrincipal, unitId: string, registerId: string, traceId: string) {
  return db.tx(async (q) => {
    const t = await install(q, unitId, registerId, actor, null);
    await audit(q, { actor, action: 'hardware.installed', tenancy: { org_id: t.org_id, merchant_id: t.merchant_id, location_id: t.location_id, register_id: registerId }, target: unitId, details: {}, trace_id: traceId });
    return { unit_id: unitId, status: 'installed' };
  });
}

/** Swap: the faulty unit comes out and goes to RMA; a unit from stock goes in where it was. */
export async function swapHardware(db: Db, actor: AdminPrincipal, oldUnitId: string, newUnitId: string, ticketId: string | null, reason: string, traceId: string) {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ status: string; register_id: string | null; kind: string }>('SELECT status, register_id, kind FROM hardware_units WHERE unit_id = $1 FOR UPDATE', [oldUnitId]);
    const old = rows[0];
    if (!old) throw notFound('Unit not found');
    if (old.status !== 'installed' || !old.register_id) throw badRequest('Only an installed unit can be swapped out');
    const { rows: nu } = await q.query<{ kind: string }>('SELECT kind FROM hardware_units WHERE unit_id = $1', [newUnitId]);
    if (nu[0]?.kind !== old.kind) throw badRequest('Swap like for like: the replacement must be the same kind');
    await q.query("UPDATE hardware_units SET status = 'rma', org_id = NULL, merchant_id = NULL, location_id = NULL, register_id = NULL, updated_at = now() WHERE unit_id = $1", [oldUnitId]);
    await hwEvent(q, oldUnitId, 'removed', { register_id: old.register_id, replaced_by: newUnitId }, actor, ticketId);
    await hwEvent(q, oldUnitId, 'rma_opened', { reason }, actor, ticketId);
    const t = await install(q, newUnitId, old.register_id, actor, ticketId);
    await audit(q, { actor, action: 'hardware.swapped', tenancy: { org_id: t.org_id, merchant_id: t.merchant_id, location_id: t.location_id, register_id: old.register_id }, target: oldUnitId, details: { new_unit_id: newUnitId, reason, ticket_id: ticketId }, trace_id: traceId });
    return { rma: oldUnitId, installed: newUnitId };
  });
}

/** An RMA comes back: repaired (to stock) or written off (retired). */
export async function closeRma(db: Db, actor: AdminPrincipal, unitId: string, outcome: 'repaired' | 'retired', traceId: string) {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ status: string }>('SELECT status FROM hardware_units WHERE unit_id = $1 FOR UPDATE', [unitId]);
    if (rows[0]?.status !== 'rma') throw badRequest('That unit isn’t out for RMA');
    await q.query('UPDATE hardware_units SET status = $2, updated_at = now() WHERE unit_id = $1', [unitId, outcome === 'repaired' ? 'in_stock' : 'retired']);
    await hwEvent(q, unitId, outcome === 'repaired' ? 'rma_closed' : 'retired', { outcome }, actor, null);
    await audit(q, { actor, action: `hardware.rma_${outcome}`, target: unitId, details: {}, trace_id: traceId });
    return { unit_id: unitId, status: outcome === 'repaired' ? 'in_stock' : 'retired' };
  });
}

export async function hardwareHistory(q: Queryable, unitId: string) {
  const { rows } = await q.query<{ kind: string; detail: unknown; ticket_id: string | null; actor: string | null; at: Date }>(
    `SELECT e.kind, e.detail, e.ticket_id, u.name AS actor, e.at FROM hardware_events e LEFT JOIN users u ON u.user_id = e.actor_user_id WHERE e.unit_id = $1 ORDER BY e.at`,
    [unitId],
  );
  return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
}
