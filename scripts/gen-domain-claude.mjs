// One-shot generator for per-domain CLAUDE.md scaffolds under apps/api/src/domains/<domain>/.
// Re-runnable: overwrites the template files. Domain detail is filled in during each domain's phase.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(root, 'apps/api/src/domains');

/** @type {Array<{slug:string,title:string,sap:string,modules:string[],note?:string}>} */
const domains = [
  {
    slug: 'platform',
    title: 'Platform / Foundation',
    sap: 'Basis + IMG',
    modules: ['auth', 'rbac', 'org-structure', 'numbering', 'workflow', 'notification', 'file-storage', 'audit-log', 'i18n', 'admin-config', 'data-migration', 'output-forms', 'job-monitor'],
    note: 'Phase 0 domain. Builds the kernel-backed plumbing (RBAC `domain:subject:action`, Number Range, fiscal-period control in admin-config) every other domain depends on.',
  },
  {
    slug: 'master-data',
    title: 'Master Data',
    sap: 'Master Data',
    modules: ['material', 'business-partner', 'bom', 'gl-account', 'cost-center', 'profit-center', 'bank-master', 'currency', 'fx-rate', 'uom', 'tax-code', 'pricing-condition'],
    note: 'Use the master extension/role pattern (§4.4): core master + per-domain extension tables (material→sales/purchasing/mrp/trade; BP→customer/vendor/carrier).',
  },
  {
    slug: 'finance-accounting',
    title: 'Finance & Accounting',
    sap: 'FI',
    modules: ['general-ledger', 'accounts-receivable', 'accounts-payable', 'fixed-assets', 'tax', 'bank-reconciliation', 'period-close', 'financial-statements'],
    note: 'The backbone. Owns journal_entry/journal_line. Enforce immutability + reversal-only + period locking (§5.1). Hosts the concrete fi-posting service from the kernel.',
  },
  {
    slug: 'controlling',
    title: 'Controlling',
    sap: 'CO',
    modules: ['cost-center-accounting', 'profit-center-accounting', 'internal-order', 'product-costing', 'profitability-analysis'],
  },
  {
    slug: 'treasury',
    title: 'Treasury',
    sap: 'TRM',
    modules: ['cash-management', 'liquidity-planning', 'bank-communication', 'fx-risk', 'borrowing', 'payment-run'],
  },
  {
    slug: 'procurement',
    title: 'Procurement',
    sap: 'MM-Purchasing + SRM',
    modules: ['purchase-requisition', 'purchase-order', 'vendor-management', 'rfq', 'contract', 'goods-receipt', 'invoice-verification'],
    note: 'GR→IV 3-way match. Import POs feed landed-cost (cross-cutting) into inventory + product-costing.',
  },
  {
    slug: 'inventory-warehouse',
    title: 'Inventory & Warehouse',
    sap: 'MM-IM + WM/EWM',
    modules: ['inventory', 'warehouse', 'goods-movement', 'batch-serial', 'stock-taking'],
    note: 'Moving-average / FIFO valuation. `goods-movement` is the single source of stock changes → FI.',
  },
  {
    slug: 'sales',
    title: 'Sales',
    sap: 'SD',
    modules: ['inquiry-quotation', 'sales-order', 'delivery', 'billing', 'pricing', 'credit-management', 'returns'],
    note: 'billing → FI: (Dr) AR / (Cr) revenue + output VAT. Reuse the kernel pricing engine (§4.6).',
  },
  {
    slug: 'crm',
    title: 'CRM',
    sap: 'Sales Cloud / C4C',
    modules: ['account-contact', 'lead', 'opportunity', 'activity', 'campaign', 'crm-quotation', 'service-ticket', 'forecast'],
    note: 'opportunity WON → sales.sales_order via doc_flow (§4.3).',
  },
  {
    slug: 'manufacturing-quality',
    title: 'Manufacturing & Quality',
    sap: 'PP + QM',
    modules: ['bom-management', 'routing', 'mrp', 'production-order', 'capacity-planning', 'confirmation', 'subcontracting', 'quality'],
  },
  {
    slug: 'logistics-4pl',
    title: 'Logistics / 4PL',
    sap: '4PL (deepened core)',
    modules: ['shipment-booking', 'freight-forwarding', 'transportation', 'customs-brokerage', '3pl-warehouse', 'control-tower', 'cargo-tracking', 'logistics-billing', 'logistics-document'],
    note: 'Heart of the system: per-shipment cost vs sell at charge granularity, planned→actual accrual, real-time margin → FI. Margin math needs Vitest unit tests (§5.4). Detail: @docs/domains/logistics-4pl.md.',
  },
  {
    slug: 'trade-compliance',
    title: 'Trade & Compliance',
    sap: 'GTS',
    modules: ['letter-of-credit', 'customs-declaration', 'fta-origin', 'hs-classification', 'duty-drawback', 'trade-document', 'incoterms', 'compliance-screening', 'cargo-insurance'],
    note: 'duty-drawback is a real cash item for import-manufacture-export — unit-test the refund calc. Reference data from @erp/trade-data.',
  },
  {
    slug: 'hr-payroll',
    title: 'HR & Payroll (Korea)',
    sap: 'HCM',
    modules: ['org-management', 'personnel', 'time', 'payroll', 'year-end-tax', 'severance', 'recruiting', 'appraisal', 'expense'],
    note: 'PIPA-critical (§5.3): rrn/bank_acct/payroll encrypted at rest + access audit + masking. 4-insurance rates are NEVER hard-coded — read from insurance_rate by effective_from. Payroll calc needs Vitest unit tests (§5.4). Detail: @docs/domains/hr-payroll.md.',
  },
  {
    slug: 'integration',
    title: 'Integration (EDI / External)',
    sap: 'PI/PO',
    modules: ['unipass-connector', 'hometax-connector', 'bank-connector', 'swift-connector', 'carrier-edi', 'ktnet-connector', 'webhook-gateway'],
    note: 'All external connectivity funnels here behind an adapter pattern — never scatter integrations across domains.',
  },
  {
    slug: 'planning',
    title: 'Planning',
    sap: 'APO / IBP (light)',
    modules: ['demand-forecast', 'sop', 'supply-planning'],
    note: 'Output feeds manufacturing-quality.mrp.',
  },
  {
    slug: 'portal',
    title: 'Portal (Self-Service)',
    sap: 'ESS/MSS + Fiori',
    modules: ['employee-self-service', 'manager-self-service', 'client-visibility', 'vendor-portal'],
    note: 'Externally exposed — extra care on authZ and PIPA masking. client-visibility is a 4PL competitive feature.',
  },
  {
    slug: 'contract',
    title: 'Contract & SLA',
    sap: 'CLM',
    modules: ['sales-contract', 'purchase-contract', 'service-contract', 'sla-monitoring'],
    note: 'service-contract drives 4PL rates/renewal; sla-monitoring raises KPI/SLA-breach alerts via the event bus.',
  },
];

const tpl = (d) => `# Domain: ${d.title} \`${d.slug}\`

> **SAP mapping:** ${d.sap}
> Loads automatically when working under \`apps/api/src/domains/${d.slug}/\`.
> Read the root \`CLAUDE.md\` first — global + structural + non-functional rules apply here too.
> Full spec (when written): \`@docs/domains/${d.slug}.md\`. Domain map: \`@docs/architecture-full.md\`.

## Modules
${d.modules.map((m) => `- \`${m}\``).join('\n')}

## Status
🟦 **Scaffold only.** No tables, services, or controllers yet — see \`@docs/phase-plan.md\` for when
this domain is built and fill the sections below at that time.
${d.note ? `\n> **Note:** ${d.note}\n` : ''}
## Domain rules
_(domain-specific rules, invariants, and terminology — TBD)_

## Key tables
_(core entities; extend the kernel document framework, add the audit-4 columns — TBD)_

## FI postings
_(which events post to the GL and the debit/credit pattern via fi-posting — TBD)_

## Domain events
_(events published / subscribed on the bus — TBD)_
`;

for (const d of domains) {
  const dir = join(base, d.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), tpl(d));
  console.log(`wrote ${d.slug}/CLAUDE.md (${d.modules.length} modules)`);
}
console.log(`\n${domains.length} domain CLAUDE.md scaffolds generated.`);
