/**
 * Wire shapes shared by the API and its clients (admin, merchant app, register). Money fields are
 * integer cents; rates are integer ppm.
 */
import type { TileColor } from './catalog';
import type { PackId } from './packs';
import type { RegisterStaff } from './staff';

export type PrincipalKind = 'admin' | 'merchant_user' | 'device';

export interface CatalogCategory {
  category_id: string;
  name: string;
  sort: number;
  taxable: boolean;
  min_age: number | null;
  color: string | null;
  active: boolean;
}

export interface ItemBarcode {
  barcode: string;
  /** Units sold when this barcode is scanned (a case UPC → pack). */
  pack_qty: number;
}

export interface CatalogItem {
  item_id: string;
  category_id: string | null;
  name: string;
  sku: string | null;
  upc: string | null;
  plu: string | null;
  /** Additional barcodes beyond `upc` (case/carton codes, alternates). */
  barcodes: ItemBarcode[];
  cash_price_cents: number;
  /** Resolved posted card price (explicit override or derived from the location's rate). */
  card_price_cents: number;
  card_price_override: boolean;
  /** Price entered at the register each time (deli by weight, "misc grocery"). */
  open_price: boolean;
  /** Merchant's cost; null until entered. Shown on the register only behind a PIN (step P5). */
  cost_cents: number | null;
  taxable: boolean;
  tax_rate_ppm: number;
  min_age: number | null;
  /** Quick-key tile color, a `TileColor` from the fixed palette (never red); null = plain white. */
  color: TileColor | null;
  /** Path to the product photo on the API (`/media/:id`); null = text-only tile. */
  image_url: string | null;
  /** Order within its category on the quick-key grid (ties break by name). */
  sort: number;
  sell_unit: 'each' | 'pack';
  pack_qty: number;
  active: boolean;
}

export interface PriceHistoryEntry {
  history_id: string;
  cash_price_cents: number;
  card_price_cents: number | null;
  cost_cents: number | null;
  catalog_version: number;
  changed_at: string;
  changed_by_kind: string;
  changed_by_name: string | null;
}

/** What a register pulls: a versioned, location-resolved catalog (server wins on catalog). */
export interface CatalogSnapshot {
  merchant_id: string;
  location_id: string;
  catalog_version: number;
  dual_price_rate_ppm: number;
  tax_rate_ppm: number;
  generated_at: string;
  categories: CatalogCategory[];
  items: CatalogItem[];
  /** This location's favorites, in tile order: the register's first quick-key page. */
  quick_keys: string[];
  /**
   * Who can sign in at this register, with PIN hashes and permissions (P3). Present only in the
   * snapshot a register pulls (`/device/catalog`), never in what the apps see.
   */
  staff?: RegisterStaff;
}

export interface DeviceIdentity {
  org_id: string;
  merchant_id: string;
  location_id: string;
  register_id: string;
  merchant_name: string;
  location_name: string;
  register_name: string;
  enabled_packs: PackId[];
  /** For the receipt header and store-local times. */
  address_line1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  timezone: string;
}

export interface SalesSummary {
  range: 'today' | 'week' | 'month';
  from: string;
  to: string;
  sale_count: number;
  gross_cents: number;
  tax_cents: number;
  refunds_cents: number;
  voids: number;
  /** Seconds from a ticket's first action to completion, median of the range (Bible L55: target < 20). */
  median_sale_seconds: number | null;
  sales_under_20s: number;
  by_tender: { tender_type: 'cash' | 'card'; amount_cents: number; count: number }[];
  by_hour: { hour: number; amount_cents: number; count: number }[];
  by_register: { register_id: string; register_name: string; amount_cents: number; count: number }[];
}

export interface SaleListRow {
  sale_id: string;
  register_id: string;
  register_name: string;
  location_name: string;
  occurred_at: string;
  status: 'completed' | 'voided' | 'open' | 'suspended';
  price_mode: 'cash' | 'card' | null;
  total_cents: number;
  item_count: number;
}
