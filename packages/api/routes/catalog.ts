/**
 * Catalog management routes (build plan F1), mounted twice with the same handlers:
 *   /admin/merchants/:merchantId/…  — AD Pay staff, any merchant (admin guard applies)
 *   /merchant/…                     — a merchant's owner or manager, their own merchant only
 *
 * The merchant id for merchant users comes from their credential; there is no id in the path to
 * tamper with. Writes need the `catalog.edit` permission (owners always; managers by default).
 */
import {
  BulkPriceInput,
  PurchaseOrderInput,
  VendorInput,
  InventoryMovementInput,
  ItemStockSettingsInput,
  LabelTemplateInput,
  LANGUAGES,
  PromotionInput,
  CATALOG_TEMPLATES,
  CatalogOrderInput,
  CategoryCreateInput,
  CategoryUpdateInput,
  ComplianceSettingsInput,
  ItemCreateInput,
  ItemUpdateInput,
  LocationRatesInput,
  MEDIA_MAX_BYTES,
  MEDIA_TYPES,
  QuickKeysInput,
  ReceiptSettingsInput,
  parseCatalogCsv,
} from '@adpay/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { languageStatuses } from '../services/i18n';
import { listPromotions, savePromotion, setPromotionActive } from '../services/promotions';
import { bulkPriceChange } from '../services/price-tools';
import { labelTemplates, printPriceLabels, printShelfTags, saveLabelTemplate, tagQueue } from '../services/labels';
import { recordMovement, setStockSettings, shrinkReport, stockLevels } from '../services/inventory';
import { closePurchaseOrder, createPurchaseOrder, purchaseOrders, reorderSuggestions, saveVendor, sendPurchaseOrder, setItemsVendor, vendors } from '../services/ordering';
import { createMessageSender } from '../messaging/sender';
import { z } from 'zod';
import { asAdmin, asMerchantUser, requireAdmin, requireMerchantUser } from '../http/auth-hooks';
import { badRequest, forbidden } from '../http/errors';
import type { AppDeps } from '../server';
import { defaultLocationId, getCatalogSnapshot } from '../services/catalog';
import { bulkUpsert, templateRows } from '../services/catalog-bulk';
import {
  createCategory,
  createItem,
  merchantLocations,
  priceHistory,
  reorderCatalog,
  setCompliance,
  setLocationRates,
  setQuickKeys,
  setReceiptSettings,
  updateCategory,
  updateItem,
  uploadMedia,
  type CatalogActor,
} from '../services/catalog-write';
import { pgMediaStore, validateImage } from '../services/media';

interface Scope {
  prefix: string;
  guard: typeof requireAdmin;
  /** Resolve merchant + acting principal; throws for callers who may read but not write. */
  resolve: (r: FastifyRequest, write: boolean) => { merchantId: string; actor: CatalogActor };
}

const ADMIN: Scope = {
  prefix: '/admin/merchants/:merchantId',
  guard: requireAdmin,
  resolve: (r) => ({
    merchantId: z.object({ merchantId: z.uuid() }).parse(r.params).merchantId,
    actor: asAdmin(r),
  }),
};

const MERCHANT: Scope = {
  prefix: '/merchant',
  guard: requireMerchantUser,
  resolve: (r, write) => {
    const me = asMerchantUser(r);
    if (write && !me.permissions.includes('catalog.edit')) throw forbidden('Your role can’t change the catalog');
    return { merchantId: me.merchant_id, actor: me };
  },
};

function mount(app: FastifyInstance, deps: AppDeps, scope: Scope) {
  const { db } = deps;
  const p = scope.prefix;
  const trace = (r: FastifyRequest) => r.logContext.trace_id;
  const ItemParams = z.object({ itemId: z.uuid() });

  app.register(async (s) => {
    s.addHook('preHandler', scope.guard);
    // Photos arrive as the raw image body (no multipart): the clients resize first, so it is small.
    s.addContentTypeParser([...MEDIA_TYPES], { parseAs: 'buffer', bodyLimit: MEDIA_MAX_BYTES }, (_req, body, done) => done(null, body));

    s.get(`${p}/locations`, async (r) => {
      const { merchantId } = scope.resolve(r, false);
      return { locations: await merchantLocations(db, merchantId) };
    });

    // Full catalog for editing, priced at a chosen location (default: the first).
    s.get(`${p}/catalog/editor`, async (r) => {
      const { merchantId } = scope.resolve(r, false);
      const { location_id } = z.object({ location_id: z.uuid().optional() }).parse(r.query);
      return getCatalogSnapshot(db, merchantId, location_id ?? (await defaultLocationId(db, merchantId)));
    });

    s.post(`${p}/items`, async (r, reply) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const input = ItemCreateInput.parse(r.body);
      reply.status(201);
      return createItem(db, actor, merchantId, input, trace(r));
    });

    s.patch(`${p}/items/:itemId`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const { itemId } = ItemParams.parse(r.params);
      return updateItem(db, actor, merchantId, itemId, ItemUpdateInput.parse(r.body), trace(r));
    });

    s.get(`${p}/items/:itemId/history`, async (r) => {
      const { merchantId } = scope.resolve(r, false);
      const { itemId } = ItemParams.parse(r.params);
      return { history: await priceHistory(db, merchantId, itemId) };
    });

    s.post(`${p}/categories`, async (r, reply) => {
      const { merchantId, actor } = scope.resolve(r, true);
      reply.status(201);
      return createCategory(db, actor, merchantId, CategoryCreateInput.parse(r.body), trace(r));
    });

    s.patch(`${p}/categories/:categoryId`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const { categoryId } = z.object({ categoryId: z.uuid() }).parse(r.params);
      return updateCategory(db, actor, merchantId, categoryId, CategoryUpdateInput.parse(r.body), trace(r));
    });

    s.post(`${p}/media`, async (r, reply) => {
      const { merchantId, actor } = scope.resolve(r, true);
      if (!Buffer.isBuffer(r.body)) throw badRequest('Send the photo as the request body (image/jpeg, image/png or image/webp)');
      const type = validateImage(r.body, r.headers['content-type']);
      reply.status(201);
      return uploadMedia(db, actor, merchantId, r.body, type, trace(r));
    });

    s.get(`${p}/locations/:locationId/quick-keys`, async (r) => {
      const { merchantId } = scope.resolve(r, false);
      const { locationId } = z.object({ locationId: z.uuid() }).parse(r.params);
      const snap = await getCatalogSnapshot(db, merchantId, locationId);
      return { location_id: locationId, item_ids: snap.quick_keys };
    });

    s.put(`${p}/locations/:locationId/quick-keys`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const { locationId } = z.object({ locationId: z.uuid() }).parse(r.params);
      return setQuickKeys(db, actor, merchantId, locationId, QuickKeysInput.parse(r.body).item_ids, trace(r));
    });

    s.get(`${p}/locations/:locationId/receipt`, async (r) => {
      const { merchantId } = scope.resolve(r, false);
      const { locationId } = z.object({ locationId: z.uuid() }).parse(r.params);
      return (await getCatalogSnapshot(db, merchantId, locationId)).receipt;
    });

    // Vendors, reorder suggestions, purchase orders (P23).
    const orders = deps.messages ?? createMessageSender('log', deps.logger);
    s.get(`${p}/vendors`, async (r) => ({ vendors: await vendors(db, scope.resolve(r, false).merchantId) }));
    s.post(`${p}/vendors`, async (r, reply) => {
      const { merchantId, actor } = scope.resolve(r, true);
      reply.status(201);
      return saveVendor(db, actor, merchantId, null, VendorInput.parse(r.body), trace(r));
    });
    s.put(`${p}/vendors/:vendorId`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const { vendorId } = z.object({ vendorId: z.uuid() }).parse(r.params);
      return saveVendor(db, actor, merchantId, vendorId, VendorInput.parse(r.body), trace(r));
    });
    s.put(`${p}/vendors/items`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const body = z.strictObject({ vendor_id: z.uuid().nullable(), item_ids: z.array(z.uuid()).min(1).max(2000) }).parse(r.body);
      return setItemsVendor(db, actor, merchantId, body.vendor_id, body.item_ids, trace(r));
    });
    s.get(`${p}/reorder`, async (r) => {
      const { merchantId } = scope.resolve(r, false);
      const { location_id } = z.object({ location_id: z.uuid() }).parse(r.query);
      return reorderSuggestions(db, merchantId, location_id);
    });
    s.get(`${p}/purchase-orders`, async (r) => {
      const { merchantId } = scope.resolve(r, false);
      const q = z.object({ location_id: z.uuid().optional(), open: z.enum(['1', '0']).optional() }).parse(r.query);
      return { orders: await purchaseOrders(db, merchantId, { ...(q.location_id ? { locationId: q.location_id } : {}), open: q.open === '1' }) };
    });
    s.post(`${p}/purchase-orders`, async (r, reply) => {
      const { merchantId, actor } = scope.resolve(r, true);
      reply.status(201);
      return createPurchaseOrder(db, actor, merchantId, PurchaseOrderInput.parse(r.body), trace(r));
    });
    s.post(`${p}/purchase-orders/:poId/:action`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const { poId, action } = z.object({ poId: z.uuid(), action: z.enum(['send', 'received', 'cancel']) }).parse(r.params);
      if (action === 'send') return sendPurchaseOrder(db, orders, actor, merchantId, poId, trace(r));
      return closePurchaseOrder(db, actor, merchantId, poId, action === 'received' ? 'received' : 'cancelled', trace(r));
    });

    // Inventory (P22): stock per store, counts / receipts / write-offs, per-item stock settings.
    s.get(`${p}/inventory`, async (r) => {
      const { merchantId } = scope.resolve(r, false);
      const { location_id } = z.object({ location_id: z.uuid() }).parse(r.query);
      return stockLevels(db, merchantId, location_id);
    });
    s.get(`${p}/inventory/shrink`, async (r) => {
      const { merchantId } = scope.resolve(r, false);
      const q = z
        .object({ location_id: z.uuid(), from: z.iso.date(), to: z.iso.date() })
        .refine((x) => x.from <= x.to && Date.parse(x.to) - Date.parse(x.from) <= 93 * 86_400_000, 'Up to a quarter, from ≤ to')
        .parse(r.query);
      return shrinkReport(db, merchantId, q.location_id, q.from, q.to);
    });
    s.post(`${p}/inventory/movements`, async (r, reply) => {
      const { merchantId, actor } = scope.resolve(r, true);
      reply.status(201);
      return recordMovement(db, actor, merchantId, InventoryMovementInput.parse(r.body), trace(r));
    });
    s.put(`${p}/items/:itemId/stock`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const { itemId } = ItemParams.parse(r.params);
      return setStockSettings(db, actor, merchantId, itemId, ItemStockSettingsInput.parse(r.body), trace(r));
    });

    // Shelf tags, the tag queue, price labels and label templates (P21): PDFs for any printer.
    s.get(`${p}/labels/templates`, async (r) => ({ templates: await labelTemplates(db, scope.resolve(r, false).merchantId) }));
    s.post(`${p}/labels/templates`, async (r, reply) => {
      const { merchantId, actor } = scope.resolve(r, true);
      reply.status(201);
      return saveLabelTemplate(db, actor, merchantId, null, LabelTemplateInput.parse(r.body), trace(r));
    });
    s.put(`${p}/labels/templates/:templateId`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const { templateId } = z.object({ templateId: z.uuid() }).parse(r.params);
      return saveLabelTemplate(db, actor, merchantId, templateId, LabelTemplateInput.parse(r.body), trace(r));
    });
    s.get(`${p}/labels/queue`, async (r) => {
      const { merchantId } = scope.resolve(r, false);
      const { location_id } = z.object({ location_id: z.uuid() }).parse(r.query);
      return tagQueue(db, merchantId, location_id);
    });
    s.post(`${p}/labels/shelf-tags.pdf`, async (r, reply) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const body = z.strictObject({ item_ids: z.array(z.uuid()).min(1).max(600), location_id: z.uuid(), template_id: z.uuid().nullable().default(null), copies: z.int().min(1).max(10).default(1) }).parse(r.body);
      const pdf = await printShelfTags(db, actor, merchantId, body, trace(r));
      return reply.header('content-type', 'application/pdf').header('content-disposition', 'inline; filename="shelf-tags.pdf"').send(pdf);
    });
    s.post(`${p}/labels/price-labels.pdf`, async (r, reply) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const body = z.strictObject({ item_id: z.uuid(), location_id: z.uuid(), price_cents: z.int().min(1).max(99_999), copies: z.int().min(1).max(50).default(1) }).parse(r.body);
      const pdf = await printPriceLabels(db, actor, merchantId, body, trace(r));
      return reply.header('content-type', 'application/pdf').header('content-disposition', 'inline; filename="price-labels.pdf"').send(pdf);
    });

    // Bulk price change (P20b): preview (dry run), then apply; every price lands in the history.
    s.post(`${p}/catalog/bulk-price`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      return bulkPriceChange(db, actor, merchantId, BulkPriceInput.parse(r.body), trace(r));
    });

    // Promotions builder (P20a): 2 for $5, buy X get Y, happy hour; per store, with dates and hours.
    s.get(`${p}/promotions`, async (r) => {
      const { merchantId } = scope.resolve(r, false);
      return { promotions: await listPromotions(db, merchantId) };
    });
    s.post(`${p}/promotions`, async (r, reply) => {
      const { merchantId, actor } = scope.resolve(r, true);
      reply.status(201);
      return savePromotion(db, actor, merchantId, null, PromotionInput.parse(r.body), trace(r));
    });
    s.put(`${p}/promotions/:promoId`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const { promoId } = z.object({ promoId: z.uuid() }).parse(r.params);
      return savePromotion(db, actor, merchantId, promoId, PromotionInput.parse(r.body), trace(r));
    });
    s.post(`${p}/promotions/:promoId/:state`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const { promoId, state } = z.object({ promoId: z.uuid(), state: z.enum(['end', 'resume']) }).parse(r.params);
      return setPromotionActive(db, actor, merchantId, promoId, state === 'resume', trace(r));
    });

    // The languages a store can offer on its customer screen (P18): drafts are listed but can't be offered.
    s.get(`${p}/languages`, async (r) => {
      scope.resolve(r, false);
      const statuses = await languageStatuses(db);
      return { languages: LANGUAGES.map((l) => ({ ...l, status: statuses[l.code] })) };
    });

    s.put(`${p}/locations/:locationId/receipt`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const { locationId } = z.object({ locationId: z.uuid() }).parse(r.params);
      return setReceiptSettings(db, actor, merchantId, locationId, ReceiptSettingsInput.parse(r.body), trace(r));
    });

    // Catalog templates and CSV import (P14, ADR 0023): one bulk path, previewed by a dry run.
    s.get(`${p}/catalog/templates`, async (r) => {
      scope.resolve(r, false);
      return {
        templates: Object.values(CATALOG_TEMPLATES).map((t) => ({
          id: t.id,
          label: t.label,
          pack: t.pack,
          description: t.description,
          categories: t.categories.length,
          items: t.categories.reduce((n, c) => n + (t.items[c.name]?.length ?? 0), 0),
        })),
      };
    });

    s.post(`${p}/catalog/templates/:templateId/apply`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const { templateId } = z.object({ templateId: z.string().max(60) }).parse(r.params);
      const { dry_run } = z.object({ dry_run: z.boolean().default(false) }).parse(r.body ?? {});
      return bulkUpsert(db, actor, merchantId, templateRows(templateId), { dryRun: dry_run, source: `template:${templateId}` }, trace(r));
    });

    s.post(`${p}/catalog/import`, { bodyLimit: 4 * 1024 * 1024 }, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const body = z.strictObject({ csv: z.string().min(1).max(3_000_000), dry_run: z.boolean().default(true), skip_errors: z.boolean().default(false) }).parse(r.body);
      const parsed = parseCatalogCsv(body.csv);
      if (parsed.rows.length === 0) return { parse: parsed, result: null };
      if (!body.dry_run && parsed.errors.length && !body.skip_errors) throw badRequest(`${parsed.errors.length} lines have problems: fix them or import the rest with skip_errors`);
      const result = await bulkUpsert(db, actor, merchantId, parsed.rows, { dryRun: body.dry_run, source: 'csv' }, trace(r));
      return { parse: { ...parsed, rows: parsed.rows.slice(0, 20) }, result };
    });

    // Tax & compliance rule set for a location (P10, ADR 0018).
    s.get(`${p}/locations/:locationId/compliance`, async (r) => {
      const { merchantId } = scope.resolve(r, false);
      const { locationId } = z.object({ locationId: z.uuid() }).parse(r.params);
      return (await getCatalogSnapshot(db, merchantId, locationId)).compliance;
    });

    s.put(`${p}/locations/:locationId/compliance`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const { locationId } = z.object({ locationId: z.uuid() }).parse(r.params);
      return setCompliance(db, actor, merchantId, locationId, ComplianceSettingsInput.parse(r.body), trace(r));
    });

    s.put(`${p}/catalog/order`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      return reorderCatalog(db, actor, merchantId, CatalogOrderInput.parse(r.body), trace(r));
    });

    s.patch(`${p}/locations/:locationId/rates`, async (r) => {
      const { merchantId, actor } = scope.resolve(r, true);
      const { locationId } = z.object({ locationId: z.uuid() }).parse(r.params);
      return setLocationRates(db, actor, merchantId, locationId, LocationRatesInput.parse(r.body), trace(r));
    });
  });
}

export async function catalogRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  mount(app, deps, ADMIN);
  mount(app, deps, MERCHANT);

  /**
   * Product photos, public by id so an <img> or a register tile can load them without a token.
   * The id is a random UUID (not guessable, not enumerable) and the content is a product photo the
   * merchant chose to show customers. Immutable, so it caches forever — which is also what lets a
   * register keep showing photos while offline.
   */
  app.get('/media/:mediaId', async (r, reply) => {
    const { mediaId } = z.object({ mediaId: z.uuid() }).parse(r.params);
    const m = await pgMediaStore.get(deps.db, mediaId);
    if (!m) return reply.status(404).send({ error: 'not_found', message: 'No such photo' });
    return reply
      .header('content-type', m.content_type)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-resource-policy', 'cross-origin')
      .send(m.bytes);
  });
}
