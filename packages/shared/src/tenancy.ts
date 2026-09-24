/**
 * Tenancy: org → merchant → location → register. Every row and every log line carries these ids
 * (plus trace_id on log lines). Ids are UUIDs.
 */
import { z } from 'zod';

export const Uuid = z.uuid();

export interface TenantIds {
  org_id: string;
  merchant_id: string;
  location_id: string;
  register_id: string;
}

export const TenantIdsSchema = z.object({
  org_id: Uuid,
  merchant_id: Uuid,
  location_id: Uuid,
  register_id: Uuid,
});

/** Partial tenancy used for log context and scoped queries; absent levels are null. */
export interface TenantContext {
  org_id: string | null;
  merchant_id: string | null;
  location_id: string | null;
  register_id: string | null;
}

export const EMPTY_TENANT_CONTEXT: TenantContext = {
  org_id: null,
  merchant_id: null,
  location_id: null,
  register_id: null,
};
