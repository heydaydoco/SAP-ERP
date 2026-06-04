import { z } from 'zod';

/**
 * Business-partner type (master-data.business-partner = SAP BP). ORGANIZATION = a company
 * (customer/vendor/carrier/bank/broker); PERSON = an individual. Roles (customer, vendor, …) are
 * modeled as separate extension tables off the core partner (§4.4), not as a type.
 */
export const bpTypeSchema = z.enum(['ORGANIZATION', 'PERSON']);
export type BpType = z.infer<typeof bpTypeSchema>;

/**
 * Material type (master-data.material = SAP material type, e.g. FERT/ROH/HAWA). Drives which views a
 * material carries and how it behaves in MM/SD: FINISHED (완제품) · SEMI_FINISHED (반제품) ·
 * RAW (원자재) · TRADING (상품, bought to resell) · SERVICE (용역, non-stock).
 */
export const materialTypeSchema = z.enum([
  'FINISHED',
  'SEMI_FINISHED',
  'RAW',
  'TRADING',
  'SERVICE',
]);
export type MaterialType = z.infer<typeof materialTypeSchema>;
