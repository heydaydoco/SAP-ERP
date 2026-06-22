import { describe, expect, it } from 'vitest';
import { ISSUE_TYPES, PRICED_TYPES, createGoodsMovementSchema } from './goods-movement.dto.js';

/**
 * Regression guard for spec point 2 (sales O2C slice): movement type 601 is an UNPRICED issue — it is
 * an ISSUE_TYPE (MAP-valued), NEVER a PRICED_TYPE, and the public-endpoint Zod schema must reject a
 * unitPrice on it (and still require one on a priced receipt). DeliveryService always builds an unpriced
 * 601 internally, so only this schema-level test can pin the invariant — a regression that added 601 to
 * PRICED_TYPES or dropped the superRefine branch would otherwise pass the whole sales + inventory suite.
 */

const MAT = '11111111-1111-1111-1111-111111111111';
const SLOC = '22222222-2222-2222-2222-222222222222';
const PLANT = '33333333-3333-3333-3333-333333333333';
const base = { plantId: PLANT, postingDate: '2026-03-01' as const };

describe('createGoodsMovementSchema — 601 sales GI is an UNPRICED, MAP-valued issue', () => {
  it('601 is an ISSUE type and is NEVER a PRICED type', () => {
    expect(ISSUE_TYPES.has('601')).toBe(true);
    expect(PRICED_TYPES.has('601')).toBe(false);
  });

  it('rejects a unitPrice on a 601 issue (unitPrice not allowed)', () => {
    const r = createGoodsMovementSchema.safeParse({
      ...base,
      movementType: '601',
      items: [{ materialId: MAT, storageLocationId: SLOC, qty: '5', unitPrice: '100' }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join('.') === 'items.0.unitPrice');
      expect(issue?.message).toMatch(/not allowed/);
    }
  });

  it('accepts a 601 issue with no unitPrice (the MAP prices it)', () => {
    const r = createGoodsMovementSchema.safeParse({
      ...base,
      movementType: '601',
      items: [{ materialId: MAT, storageLocationId: SLOC, qty: '5' }],
    });
    expect(r.success).toBe(true);
  });

  it('still REQUIRES a unitPrice on a priced receipt (101)', () => {
    const r = createGoodsMovementSchema.safeParse({
      ...base,
      movementType: '101',
      items: [{ materialId: MAT, storageLocationId: SLOC, qty: '5' }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /unitPrice is required/.test(i.message))).toBe(true);
    }
  });
});

/**
 * Regression guard for the physical-inventory slice: 701 (stock gain) and 702 (stock loss) are UNPRICED,
 * MAP-valued adjustment types. 702 is an ISSUE (decrease, like 201/711); 701 is a 712-style surplus
 * (increase) — so 701 is NOT in ISSUE_TYPES. NEITHER is ever a PRICED type, and the schema must reject a
 * unitPrice on both. The PhysicalInventoryService always builds them internally, so only this schema-level
 * test pins the enum/set widening — a regression dropping 701/702 from the enum, or adding them to
 * PRICED_TYPES, would otherwise slip through.
 */
describe('createGoodsMovementSchema — 701/702 physical-inventory adjustments are UNPRICED', () => {
  it('702 is an ISSUE (loss); 701 is a surplus (gain), NOT an ISSUE; neither is PRICED', () => {
    expect(ISSUE_TYPES.has('702')).toBe(true);
    expect(ISSUE_TYPES.has('701')).toBe(false);
    expect(PRICED_TYPES.has('701')).toBe(false);
    expect(PRICED_TYPES.has('702')).toBe(false);
  });

  it.each(['701', '702'] as const)('accepts a %s adjustment with no unitPrice (MAP prices it)', (mt) => {
    const r = createGoodsMovementSchema.safeParse({
      ...base,
      movementType: mt,
      items: [{ materialId: MAT, storageLocationId: SLOC, qty: '3' }],
    });
    expect(r.success).toBe(true);
  });

  it.each(['701', '702'] as const)('rejects a unitPrice on a %s adjustment (not allowed)', (mt) => {
    const r = createGoodsMovementSchema.safeParse({
      ...base,
      movementType: mt,
      items: [{ materialId: MAT, storageLocationId: SLOC, qty: '3', unitPrice: '100' }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join('.') === 'items.0.unitPrice');
      expect(issue?.message).toMatch(/not allowed/);
    }
  });
});
