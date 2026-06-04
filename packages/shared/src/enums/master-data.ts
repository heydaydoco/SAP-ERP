import { z } from 'zod';

/**
 * Business-partner type (master-data.business-partner = SAP BP). ORGANIZATION = a company
 * (customer/vendor/carrier/bank/broker); PERSON = an individual. Roles (customer, vendor, …) are
 * modeled as separate extension tables off the core partner (§4.4), not as a type.
 */
export const bpTypeSchema = z.enum(['ORGANIZATION', 'PERSON']);
export type BpType = z.infer<typeof bpTypeSchema>;
