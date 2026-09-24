/**
 * Wire shapes shared by the API and its clients (admin, merchant app, register). Money fields are
 * integer cents; rates are integer ppm.
 */
import type { PackId } from './packs';

export type PrincipalKind = 'admin' | 'merchant_user' | 'device';

export interface CatalogCategory {
  category_id: string;
  name: string;
  sort: number;
  taxable: boolean;
  min_age: number | null;
  color: string | null;
}

export interface CatalogItem {
  item_id: string;
  category_id: string | null;
  name: string;
  sku: string | null;
  upc: string | null;
  cash_price_cents: number;
  /** Resolved posted card price (explicit override or derived from the location's rate). */
  card_price_cents: number;
  card_price_override: boolean;
  taxable: boolean;
  tax_rate_ppm: number;
  min_age: number | null;
  sell_unit: 'each' | 'pack';
  pack_qty: number;
  active: boolean;
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
