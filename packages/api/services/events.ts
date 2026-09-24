/**
 * Idempotent, batched ingest of register events (ADR 0002).
 *
 * - Validation is strict (shared schema); a bad event is rejected individually, the rest proceed.
 * - Tenancy in each event must equal the device credential's; a register cannot write for another.
 * - Idempotency is a primary key on the device-generated event_id, inserted in the same transaction
 *   as the ledger row. Replaying a batch returns every id as a duplicate and writes nothing.
 * - Rows are never updated or deleted (a trigger enforces it).
 */
import { RegisterEventSchema, foldSale, type FoldedSale, type RegisterEvent } from '@adpay/shared';
import type { DevicePrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { notFound } from '../http/errors';

export interface IngestResult {
  accepted: string[];
  duplicates: string[];
  rejected: { index: number; event_id: string | null; reason: string }[];
}

export interface IngestOptions {
  /** Backfill/seed only — never exposed over HTTP. */
  receivedAt?: Date;
}

const ensuredMonths = new WeakMap<Queryable, Set<string>>();

/** Create the month's partition if needed; remembered per database so it costs one query a month. */
export async function ensurePartition(q: Queryable, at: Date): Promise<void> {
  const key = at.toISOString().slice(0, 7);
  const seen = ensuredMonths.get(q) ?? new Set<string>();
  if (seen.has(key)) return;
  await q.query('SELECT ensure_sale_events_partition($1::timestamptz)', [at.toISOString()]);
  seen.add(key);
  ensuredMonths.set(q, seen);
}

export async function ingestEvents(
  db: Db,
  device: DevicePrincipal,
  raw: readonly unknown[],
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const result: IngestResult = { accepted: [], duplicates: [], rejected: [] };
  const valid: RegisterEvent[] = [];

  raw.forEach((input, index) => {
    const parsed = RegisterEventSchema.safeParse(input);
    const eventId =
      typeof input === 'object' && input !== null && typeof (input as { event_id?: unknown }).event_id === 'string'
        ? (input as { event_id: string }).event_id
        : null;
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      result.rejected.push({ index, event_id: eventId, reason: `${first?.path.join('.') ?? ''}: ${first?.message ?? 'invalid'}` });
      return;
    }
    const e = parsed.data;
    if (
      e.org_id !== device.org_id ||
      e.merchant_id !== device.merchant_id ||
      e.location_id !== device.location_id ||
      e.register_id !== device.register_id
    ) {
      result.rejected.push({ index, event_id: e.event_id, reason: 'tenancy does not match this register' });
      return;
    }
    valid.push(e);
  });

  if (valid.length === 0) return result;

  const receivedAt = opts.receivedAt ?? new Date();
  await ensurePartition(db, receivedAt);

  await db.tx(async (q) => {
    const ids = valid.map((e) => ({ event_id: e.event_id, register_id: e.register_id, received_at: receivedAt.toISOString() }));
    const { rows: fresh } = await q.query<{ event_id: string }>(
      `INSERT INTO sale_event_ids (event_id, register_id, received_at)
       SELECT event_id, register_id, received_at
         FROM jsonb_to_recordset($1::jsonb) AS x(event_id uuid, register_id uuid, received_at timestamptz)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [JSON.stringify(ids)],
    );
    const freshIds = new Set(fresh.map((r) => r.event_id));
    const toInsert = valid.filter((e) => freshIds.has(e.event_id));
    for (const e of valid) (freshIds.has(e.event_id) ? result.accepted : result.duplicates).push(e.event_id);
    if (toInsert.length === 0) return;

    // Business date: location-local date of the device time, unless the device clock is implausible
    // (ahead of the server, or more than 7 days behind — beyond the 72h offline window), in which
    // case the server's receive time decides (ADR 0002, clock skew).
    await q.query(
      `INSERT INTO sale_events (event_id, org_id, merchant_id, location_id, register_id, sale_id, device_seq, type,
                                schema_version, occurred_at, received_at, business_date, payload, trace_id, actor_user_id)
       SELECT x.event_id, x.org_id, x.merchant_id, x.location_id, x.register_id, x.sale_id, x.device_seq, x.type,
              x.schema_version, x.occurred_at, $2::timestamptz,
              CASE WHEN x.occurred_at > $2::timestamptz + interval '5 minutes'
                     OR x.occurred_at < $2::timestamptz - interval '7 days'
                   THEN ($2::timestamptz AT TIME ZONE l.timezone)::date
                   ELSE (x.occurred_at AT TIME ZONE l.timezone)::date END,
              x.payload, x.trace_id, x.actor_user_id
         FROM jsonb_to_recordset($1::jsonb) AS x(
                event_id uuid, org_id uuid, merchant_id uuid, location_id uuid, register_id uuid, sale_id uuid,
                device_seq bigint, type text, schema_version int, occurred_at timestamptz, payload jsonb, trace_id text,
                actor_user_id uuid)
         JOIN locations l ON l.location_id = x.location_id`,
      [JSON.stringify(toInsert), receivedAt.toISOString()],
    );
    await q.query(`UPDATE registers SET last_seen_at = greatest(coalesce(last_seen_at, $2), $2) WHERE register_id = $1`, [
      device.register_id,
      receivedAt.toISOString(),
    ]);
  });

  return result;
}

export interface TimelineEvent {
  event_id: string;
  type: string;
  device_seq: number;
  occurred_at: string;
  received_at: string;
  business_date: string;
  trace_id: string;
  payload: unknown;
}

export interface SaleTimeline {
  sale_id: string;
  org_id: string;
  merchant_id: string;
  location_id: string;
  register_id: string;
  register_name: string;
  location_name: string;
  merchant_name: string;
  events: TimelineEvent[];
  folded: FoldedSale;
}

/** Replay a ticket. `merchantId` null = admin (cross-tenant); otherwise the read is scoped. */
interface TimelineRow {
  event_id: string;
  schema_version: number;
  sale_id: string;
  device_seq: number;
  occurred_at: Date | string;
  received_at: Date | string;
  business_date: string;
  org_id: string;
  merchant_id: string;
  location_id: string;
  register_id: string;
  trace_id: string;
  type: string;
  payload: unknown;
  register_name: string;
  location_name: string;
  merchant_name: string;
}

export async function getSaleTimeline(q: Queryable, saleId: string, merchantId: string | null): Promise<SaleTimeline> {
  const { rows } = await q.query<TimelineRow>(
    `SELECT e.event_id, e.schema_version, e.sale_id, e.device_seq, e.occurred_at, e.received_at,
            to_char(e.business_date, 'YYYY-MM-DD') AS business_date, e.org_id, e.merchant_id, e.location_id,
            e.register_id, e.trace_id, e.type, e.payload,
            r.name AS register_name, l.name AS location_name, m.name AS merchant_name
       FROM sale_events e
       JOIN registers r ON r.register_id = e.register_id
       JOIN locations l ON l.location_id = e.location_id
       JOIN merchants m ON m.merchant_id = e.merchant_id
      WHERE e.sale_id = $1 AND ($2::uuid IS NULL OR e.merchant_id = $2::uuid)
      ORDER BY e.device_seq`,
    [saleId, merchantId],
  );
  const first = rows[0];
  if (!first) throw notFound('Sale not found');
  const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v);
  const events = rows.map((r) => ({ ...r, occurred_at: iso(r.occurred_at), received_at: iso(r.received_at) }));
  const parsed = events.map((r) =>
    RegisterEventSchema.parse({
      event_id: r.event_id,
      schema_version: r.schema_version,
      sale_id: r.sale_id,
      device_seq: r.device_seq,
      occurred_at: r.occurred_at,
      org_id: r.org_id,
      merchant_id: r.merchant_id,
      location_id: r.location_id,
      register_id: r.register_id,
      trace_id: r.trace_id,
      type: r.type,
      payload: r.payload,
    }),
  );
  return {
    sale_id: saleId,
    org_id: first.org_id,
    merchant_id: first.merchant_id,
    location_id: first.location_id,
    register_id: first.register_id,
    register_name: first.register_name,
    location_name: first.location_name,
    merchant_name: first.merchant_name,
    events: events.map((r) => ({
      event_id: r.event_id,
      type: r.type,
      device_seq: r.device_seq,
      occurred_at: r.occurred_at,
      received_at: r.received_at,
      business_date: r.business_date,
      trace_id: r.trace_id,
      payload: r.payload,
    })),
    folded: foldSale(saleId, parsed),
  };
}
