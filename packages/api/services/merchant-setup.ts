/**
 * Onboarding wizard, install kits and pricing plans (build plan P12a, Bible L42/L43/L51, ADR 0020).
 *
 * The wizard applies everything in **one transaction**: a half-onboarded merchant (a store with no
 * owner, or registers with no location) can't exist. KYB goes through the processor and waits for
 * the AD Pay LLC Finix account (⛔); the wizard records it as "not started".
 */
import {
  ComplianceSettingsInput,
  INSTALL_KIT_CODE_TTL_HOURS,
  PricingPlanInput,
  STATE_TEMPLATES,
  localDate,
  planOn,
  type Onboarding,
  type OnboardingResult,
  type OnboardingRow,
  type PricingPlan,
  type PricingPlanRow,
} from '@adpay/shared';
import { randomUUID } from 'node:crypto';
import type { AdminPrincipal } from '../auth/principal';
import type { Db, Queryable } from '../db/db';
import { badRequest, notFound } from '../http/errors';
import { audit } from './audit';
import { bumpCatalogVersion } from './catalog-write';
import { createLocation, createMerchant, createOrg, createRegister, issueSetupCode } from './onboarding';
import { insertStaff } from './staff';

async function storeToday(q: Queryable, merchantId: string): Promise<string> {
  const { rows } = await q.query<{ timezone: string }>('SELECT timezone FROM locations WHERE merchant_id = $1 ORDER BY created_at LIMIT 1', [merchantId]);
  return localDate(new Date(), rows[0]?.timezone ?? 'America/New_York');
}

async function insertPlan(q: Queryable, actor: AdminPrincipal, t: { org_id: string; merchant_id: string }, plan: PricingPlan, traceId: string): Promise<string> {
  const { rows } = await q.query<{ plan_id: string }>(
    `INSERT INTO merchant_pricing_plans (org_id, merchant_id, plan, effective_from, created_by, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING plan_id`,
    [t.org_id, t.merchant_id, JSON.stringify(plan), plan.effective_from, actor.user_id, traceId],
  );
  return rows[0]!.plan_id;
}

export async function onboardMerchant(db: Db, actor: AdminPrincipal, input: Onboarding, traceId: string): Promise<OnboardingResult> {
  return db.tx(async (q) => {
    let orgId: string;
    if ('org_id' in input.org) {
      const { rows } = await q.query('SELECT 1 FROM orgs WHERE org_id = $1', [input.org.org_id]);
      if (!rows[0]) throw notFound('Organization not found');
      orgId = input.org.org_id;
    } else {
      orgId = (await createOrg(q, input.org.name)).org_id;
    }
    const m = await createMerchant(q, { org_id: orgId, ...input.merchant });
    const owner = await insertStaff(q, actor, m.merchant_id, { name: input.owner.name, role: 'owner', phone: input.owner.phone, pin: null }, traceId);

    const dual = input.pricing.kind === 'dual_pricing' ? input.pricing.dual_price_rate_ppm : 0;
    const loc = await createLocation(q, { merchant_id: m.merchant_id, ...input.location, dual_price_rate_ppm: dual });

    // A starting compliance set from the state template (drafts, accountant sign-off). Deposits go
    // on the pack's drinks category; percentage vape tax on any vape-restricted category.
    if (input.location.compliance_template) {
      const t = STATE_TEMPLATES[input.location.compliance_template];
      const { rows: cats } = await q.query<{ category_id: string; name: string; restriction: string | null }>(
        'SELECT category_id, name, restriction FROM categories WHERE merchant_id = $1',
        [m.merchant_id],
      );
      const settings = ComplianceSettingsInput.parse({
        tax_rates: t.tax_rates,
        charges: t.charges.map((c) => ({
          ...c,
          rule_id: randomUUID(),
          category_ids: cats
            .filter((x) => (c.kind === 'deposit' ? /drink|beverage|soda|water/i.test(x.name) : c.kind === 'excise' && /vapor|vape/i.test(c.label) ? x.restriction === 'vape' : false))
            .map((x) => x.category_id),
          item_ids: [],
        })),
        age_rules: {},
      });
      await q.query('UPDATE locations SET compliance = $2 WHERE location_id = $1', [loc.location_id, JSON.stringify(settings)]);
    }

    const registerIds: string[] = [];
    for (let i = 1; i <= input.registers; i++) registerIds.push((await createRegister(q, { location_id: loc.location_id, name: `Register ${i}` })).register_id);

    const planId = await insertPlan(q, actor, m, input.pricing, traceId);
    await q.query(
      `INSERT INTO merchant_onboarding (merchant_id, org_id, status, install_date, hardware_note, created_by)
       VALUES ($1, $2, 'setting_up', $3, $4, $5)
       ON CONFLICT (merchant_id) DO UPDATE SET install_date = EXCLUDED.install_date, hardware_note = EXCLUDED.hardware_note, created_by = EXCLUDED.created_by`,
      [m.merchant_id, orgId, input.install_date, input.hardware_note, actor.user_id],
    );
    await bumpCatalogVersion(q, m.merchant_id);
    await audit(q, {
      actor,
      action: 'merchant.onboarded',
      tenancy: { org_id: orgId, merchant_id: m.merchant_id, location_id: loc.location_id },
      target: m.merchant_id,
      details: { ...input, owner: { name: input.owner.name }, plan_id: planId, register_ids: registerIds },
      trace_id: traceId,
    });
    return { org_id: orgId, merchant_id: m.merchant_id, location_id: loc.location_id, register_ids: registerIds, owner_user_id: owner.user_id };
  });
}

// ───────────────────────────────────────────────────────────────────────── pricing ──

export async function pricingPlans(q: Queryable, merchantId: string): Promise<PricingPlanRow[]> {
  const { rows } = await q.query<{ plan_id: string; plan: unknown; created_at: Date; created_by_name: string | null }>(
    `SELECT p.plan_id, p.plan, p.created_at, coalesce(u.name, u.email) AS created_by_name
       FROM merchant_pricing_plans p LEFT JOIN users u ON u.user_id = p.created_by
      WHERE p.merchant_id = $1 ORDER BY p.effective_from DESC, p.created_at DESC`,
    [merchantId],
  );
  const parsed = rows.flatMap((r) => {
    const plan = PricingPlanInput.safeParse(r.plan);
    return plan.success ? [{ plan_id: r.plan_id, plan: plan.data, created_at: new Date(r.created_at).toISOString(), created_by_name: r.created_by_name }] : [];
  });
  const current = planOn(parsed, await storeToday(q, merchantId));
  return parsed.map((r) => ({ ...r, current: r.plan_id === current?.plan_id }));
}

/**
 * Add a plan (a new row; history is kept). For dual pricing, `applyToLocations` also sets every
 * location's card-price markup, which moves card prices, so it bumps the catalog.
 */
export async function addPricingPlan(db: Db, actor: AdminPrincipal, merchantId: string, plan: PricingPlan, applyToLocations: boolean, traceId: string): Promise<{ plan_id: string }> {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string }>('SELECT org_id FROM merchants WHERE merchant_id = $1', [merchantId]);
    if (!rows[0]) throw notFound('Merchant not found');
    const t = { org_id: rows[0].org_id, merchant_id: merchantId };
    const planId = await insertPlan(q, actor, t, plan, traceId);
    let applied = false;
    if (applyToLocations && plan.kind === 'dual_pricing') {
      if (plan.effective_from > (await storeToday(q, merchantId))) throw badRequest('Apply a future plan to the registers on its start date');
      await q.query('UPDATE locations SET dual_price_rate_ppm = $2 WHERE merchant_id = $1', [merchantId, plan.dual_price_rate_ppm]);
      await bumpCatalogVersion(q, merchantId);
      applied = true;
    }
    await audit(q, { actor, action: 'merchant.pricing_plan_added', tenancy: t, target: planId, details: { plan, applied_to_locations: applied }, trace_id: traceId });
    return { plan_id: planId };
  });
}

// ───────────────────────────────────────────────────────────────────────── pipeline ──

export async function onboardingList(q: Queryable): Promise<OnboardingRow[]> {
  const { rows } = await q.query<Omit<OnboardingRow, 'install_date' | 'created_at'> & { install_date: string | null; created_at: Date }>(
    `SELECT o.merchant_id, m.name AS merchant_name, g.name AS org_name, o.status, o.kyb_status,
            to_char(o.install_date, 'YYYY-MM-DD') AS install_date, o.hardware_note, o.created_at,
            (SELECT count(*)::int FROM registers r WHERE r.merchant_id = o.merchant_id AND r.status <> 'retired') AS registers,
            (SELECT count(*)::int FROM registers r WHERE r.merchant_id = o.merchant_id AND r.status = 'active') AS registers_paired
       FROM merchant_onboarding o JOIN merchants m ON m.merchant_id = o.merchant_id JOIN orgs g ON g.org_id = o.org_id
      ORDER BY (o.status = 'live'), o.install_date NULLS LAST, o.created_at DESC`,
  );
  return rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
}

export async function updateOnboarding(
  db: Db,
  actor: AdminPrincipal,
  merchantId: string,
  patch: {
    status?: OnboardingRow['status'] | undefined;
    kyb_status?: OnboardingRow['kyb_status'] | undefined;
    install_date?: string | null | undefined;
    hardware_note?: string | null | undefined;
  },
  traceId: string,
): Promise<void> {
  const keys = (['status', 'kyb_status', 'install_date', 'hardware_note'] as const).filter((k) => patch[k] !== undefined);
  if (!keys.length) return;
  await db.tx(async (q) => {
    const { rows } = await q.query<{ org_id: string }>(
      `UPDATE merchant_onboarding SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE merchant_id = $1 RETURNING org_id`,
      [merchantId, ...keys.map((k) => patch[k])],
    );
    if (!rows[0]) throw notFound('No onboarding record for that merchant');
    await audit(q, { actor, action: 'merchant.onboarding_updated', tenancy: { org_id: rows[0].org_id, merchant_id: merchantId }, target: merchantId, details: patch, trace_id: traceId });
  });
}

// ───────────────────────────────────────────────────────────────────────── install kit ──

export interface InstallKit {
  merchant_name: string;
  install_date: string | null;
  locations: {
    location_id: string;
    name: string;
    address: string | null;
    registers: { register_id: string; name: string; code: string; expires_at: string }[];
  }[];
}

/**
 * Fresh setup codes for every register not yet paired, valid 14 days so the kit can be printed
 * before the visit. Earlier unused codes stop working. Paired registers are left alone.
 */
export async function installKit(db: Db, actor: AdminPrincipal, merchantId: string, traceId: string): Promise<InstallKit> {
  return db.tx(async (q) => {
    const { rows: m } = await q.query<{ org_id: string; name: string; install_date: string | null }>(
      `SELECT m.org_id, m.name, to_char(o.install_date, 'YYYY-MM-DD') AS install_date
         FROM merchants m LEFT JOIN merchant_onboarding o ON o.merchant_id = m.merchant_id WHERE m.merchant_id = $1`,
      [merchantId],
    );
    if (!m[0]) throw notFound('Merchant not found');
    const { rows: regs } = await q.query<{ register_id: string; name: string; location_id: string; location_name: string; address: string | null }>(
      `SELECT r.register_id, r.name, l.location_id, l.name AS location_name,
              nullif(concat_ws(', ', l.address_line1, l.city, l.state), '') AS address
         FROM registers r JOIN locations l ON l.location_id = r.location_id
        WHERE r.merchant_id = $1 AND r.status = 'unpaired'
        ORDER BY l.created_at, r.name`,
      [merchantId],
    );
    const locations = new Map<string, InstallKit['locations'][number]>();
    for (const r of regs) {
      const code = await issueSetupCode(q, r.register_id, actor.user_id, INSTALL_KIT_CODE_TTL_HOURS);
      const loc = locations.get(r.location_id) ?? { location_id: r.location_id, name: r.location_name, address: r.address, registers: [] };
      loc.registers.push({ register_id: r.register_id, name: r.name, ...code });
      locations.set(r.location_id, loc);
    }
    await audit(q, {
      actor,
      action: 'merchant.install_kit_issued',
      tenancy: { org_id: m[0].org_id, merchant_id: merchantId },
      target: merchantId,
      details: { registers: regs.map((r) => r.register_id), ttl_hours: INSTALL_KIT_CODE_TTL_HOURS },
      trace_id: traceId,
    });
    return { merchant_name: m[0].name, install_date: m[0].install_date, locations: [...locations.values()] };
  });
}
