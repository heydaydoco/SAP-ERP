import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { paginationQuerySchema } from '@erp/shared';
import { z } from 'zod';
import { loginSchema } from '../domains/platform/auth/auth.dto.js';
import {
  createManualJournalSchema,
  journalQuerySchema,
  trialBalanceQuerySchema,
} from '../domains/finance-accounting/general-ledger/journal.dto.js';
import { glAccountQuerySchema } from '../domains/master-data/gl-account/gl-account.dto.js';

/**
 * OpenAPI registry for the web FI-verification slice (root CLAUDE.md §2). Decision A
 * (zod-to-openapi): REQUEST shapes reuse the controllers' own Zod schemas (imported here, so they
 * cannot drift); RESPONSE shapes are defined pragmatically below — only the fields the verification
 * UI reads — and SCOPED to exactly the 8 endpoints this slice calls (5 core + 3 dropdowns). New
 * endpoints add their path here and regenerate (`pnpm openapi`). This file performs no controller
 * decoration and changes no business code.
 */
extendZodWithOpenApi(z);

// ── response schemas (pragmatic: the fields the UI renders) ──────────────────────
const zPosted = z.object({
  journalId: z.string(),
  postingKey: z.string(),
  status: z.string(),
});
const zLine = z.object({
  lineNo: z.number(),
  glAccount: z.string(),
  drCr: z.string(),
  amount: z.string(),
  currency: z.string(),
  functionalAmount: z.string(),
  functionalCurrency: z.string(),
  isReconAccount: z.boolean(),
  partnerId: z.string().nullable(),
  costCenterId: z.string().nullable(),
  taxCode: z.string().nullable(),
  lineText: z.string().nullable(),
});
const zHeader = z.object({
  id: z.string(),
  docType: z.string(),
  docNo: z.string(),
  status: z.string(),
  postingDate: z.string(),
  documentDate: z.string(),
  currency: z.string(),
  functionalCurrency: z.string(),
  fxRate: z.string().nullable(),
  reference: z.string(),
  headerText: z.string().nullable(),
  fiscalYear: z.number(),
  periodNo: z.number(),
  companyCodeId: z.string(),
});
const zDetail = zHeader.extend({ lines: z.array(zLine) });
const zTrialRow = z.object({
  glAccount: z.string(),
  currency: z.string(),
  debit: z.string(),
  credit: z.string(),
  balance: z.string(),
});
const zAuth = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: z.object({
    id: z.string(),
    username: z.string(),
    displayName: z.string(),
    roles: z.array(z.string()),
  }),
});
const zCompanyCode = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  currency: z.string().nullable(),
  chartOfAccounts: z.string().nullable(),
});
const zGlAccount = z.object({
  id: z.string(),
  accountNumber: z.string(),
  name: z.string(),
  accountType: z.string(),
  currency: z.string().nullable(),
  isReconciliation: z.boolean(),
  chartOfAccounts: z.string(),
});
const zCurrency = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  minorUnit: z.number(),
  symbol: z.string().nullable(),
});
const paged = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ data: z.array(item), total: z.number(), page: z.number(), pageSize: z.number() });

export function buildRegistry(): OpenAPIRegistry {
  const r = new OpenAPIRegistry();
  const json = (schema: z.ZodTypeAny) => ({ content: { 'application/json': { schema } } });
  const res200 = (schema: z.ZodTypeAny) => ({ 200: { description: 'OK', ...json(schema) } });

  // auth
  r.registerPath({
    method: 'post',
    path: '/auth/login',
    tags: ['auth'],
    request: { body: json(loginSchema) },
    responses: res200(zAuth),
  });

  // general ledger (manual journal post + reads)
  r.registerPath({
    method: 'post',
    path: '/finance-accounting/journal-entries',
    tags: ['finance'],
    request: { body: json(createManualJournalSchema) },
    responses: { 201: { description: 'Posted', ...json(zPosted) } },
  });
  r.registerPath({
    method: 'get',
    path: '/finance-accounting/journal-entries',
    tags: ['finance'],
    request: { query: journalQuerySchema },
    responses: res200(paged(zHeader)),
  });
  r.registerPath({
    method: 'get',
    path: '/finance-accounting/journal-entries/{id}',
    tags: ['finance'],
    request: { params: z.object({ id: z.string() }) },
    responses: res200(zDetail),
  });
  r.registerPath({
    method: 'get',
    path: '/finance-accounting/trial-balance',
    tags: ['finance'],
    request: { query: trialBalanceQuerySchema },
    responses: res200(z.array(zTrialRow)),
  });

  // dropdown data
  r.registerPath({
    method: 'get',
    path: '/org/company-codes',
    tags: ['org'],
    request: { query: paginationQuerySchema },
    responses: res200(paged(zCompanyCode)),
  });
  r.registerPath({
    method: 'get',
    path: '/master-data/gl-accounts',
    tags: ['master-data'],
    request: { query: glAccountQuerySchema },
    responses: res200(paged(zGlAccount)),
  });
  r.registerPath({
    method: 'get',
    path: '/master-data/currencies',
    tags: ['master-data'],
    request: { query: paginationQuerySchema },
    responses: res200(paged(zCurrency)),
  });

  return r;
}
