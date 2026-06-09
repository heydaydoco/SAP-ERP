import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { buildRegistry } from './registry.js';

/**
 * Emit the OpenAPI document from the Zod registry (run via `pnpm openapi`, after `nest build`):
 *   node dist/openapi/build-openapi.js   (cwd = apps/api)
 * Writes packages/api-client/openapi.json, which `openapi-typescript` turns into the typed client.
 * Boots no Nest app and touches no DB — it only reads the (pure) Zod DTOs.
 */
const registry = buildRegistry();
const generator = new OpenApiGeneratorV3(registry.definitions);
const doc = generator.generateDocument({
  openapi: '3.0.0',
  info: {
    title: 'SAP-ERP API',
    version: '0.0.0',
    description:
      'Generated from the api Zod DTOs via zod-to-openapi. Scoped subset for the web FI ' +
      'verification slice; extend apps/api/src/openapi/registry.ts and rerun `pnpm openapi`.',
  },
  servers: [{ url: '/api' }],
});

const out = resolve(process.cwd(), '../../packages/api-client/openapi.json');
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.warn(`[openapi] wrote ${out}`);
