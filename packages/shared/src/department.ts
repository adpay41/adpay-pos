/**
 * Department ring (NRS gap, ADR 0046): an amount rung straight to a department, with no item record
 * behind it ("$3.50 grocery"). The line takes everything from the department (category): its tax
 * setting and class, its age rule, its name. The event carries `item_id: null` and
 * `price_source: 'department'`, so every report can tell it from an item and bucket it by category.
 *
 * `departmentItem` gives the register a key-shaped stand-in to ring through the same session path as
 * any open-price item (age check, compliance, promotions by category). Its id is never written to an
 * event.
 */
import type { CatalogCategory, CatalogItem, CatalogSnapshot } from './api';
import { effectiveMinAge } from './compliance';

const PREFIX = 'dept:';

/** The stand-in "item" for ringing an amount to a department. */
export function departmentItem(category: CatalogCategory, snapshot: Pick<CatalogSnapshot, 'tax_rate_ppm' | 'compliance'>): CatalogItem {
  const taxable = category.taxable;
  return {
    item_id: `${PREFIX}${category.category_id}`,
    category_id: category.category_id,
    name: category.name,
    sku: null,
    upc: null,
    plu: null,
    barcodes: [],
    cash_price_cents: 0,
    card_price_cents: 0,
    card_price_override: false,
    open_price: true,
    cost_cents: null,
    taxable,
    tax_rate_ppm: taxable ? snapshot.tax_rate_ppm : 0,
    tax_class: category.tax_class ?? 'standard',
    min_age: effectiveMinAge(category.min_age, category.restriction ?? null, snapshot.compliance?.min_ages ?? null),
    restriction: category.restriction ?? null,
    color: null,
    image_url: null,
    sort: 0,
    sell_unit: 'each',
    pack_qty: 1,
    active: category.active,
  };
}

/** True for the stand-in from `departmentItem`. */
export function isDepartmentItem(item: Pick<CatalogItem, 'item_id'>): boolean {
  return item.item_id.startsWith(PREFIX);
}
