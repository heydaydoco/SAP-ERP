// Drizzle schema entry. Tables are grouped by domain; shared column builders live in _shared.
// Phase 0 ships platform infra (doc_flow, outbox); business tables are added per phase.
export * from './_shared/index';
export * from './platform/index';
export * from './master-data/index';
export * from './finance-accounting/index';
export * from './inventory-warehouse/index';
export * from './procurement/index';
