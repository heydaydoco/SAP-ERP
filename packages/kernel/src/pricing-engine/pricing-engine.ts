/**
 * Common pricing / condition engine (root CLAUDE.md §4.6).
 *
 * One engine reused by SD price, PO price, carrier freight, and logistics charges.
 * Conditions stack (base price, discounts, surcharges, freight, tax) into a net result.
 * No per-domain price logic duplication.
 *
 * Interface stub; condition tables + evaluator land in Phase 1 (pricing-condition master).
 */
export type ConditionCategory = 'PRICE' | 'DISCOUNT' | 'SURCHARGE' | 'FREIGHT' | 'TAX';
export type ConditionCalc = 'FIXED' | 'PER_UNIT' | 'PERCENT';

export interface PricingCondition {
  conditionType: string; // e.g. 'PR00' base price, 'K007' discount
  category: ConditionCategory;
  calc: ConditionCalc;
  /** Decimal string: money for FIXED/PER_UNIT, percentage for PERCENT. */
  rate: string;
  currency?: string;
}

export interface PricingContext {
  /** What is being priced — sales item, PO item, freight leg, logistics charge. */
  refType: string;
  quantity: string; // NUMERIC, decimal string
  currency: string;
  /** Free-form attributes feeding condition selection (customer, material, lane, …). */
  attributes: Record<string, string>;
}

export interface PricingResultLine {
  conditionType: string;
  amount: string; // NUMERIC(18,2)
}

export interface PricingResult {
  net: string; // NUMERIC(18,2)
  currency: string;
  lines: PricingResultLine[];
}

export interface PricingEngine {
  price(context: PricingContext): Promise<PricingResult>;
}
