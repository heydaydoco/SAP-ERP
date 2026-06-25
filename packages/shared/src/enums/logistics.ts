import { z } from 'zod';

/** Transport mode (logistics-4pl.shipment.mode). */
export const transportModeSchema = z.enum(['SEA', 'AIR', 'RAIL', 'TRUCK']);
export type TransportMode = z.infer<typeof transportModeSchema>;

/**
 * Trade direction (수출입 구분) — shared across logistics-4pl, sales, procurement, and trade-compliance.
 * EXP = export (수출) · DOM = domestic (내수) · IMP = import (수입). On a sales order it is STORED ONLY
 * (§12) — it never drives tax determination (the line `tax_code` does, §5: DOM + V00 영세율 is legitimate,
 * EXP + a taxable code is only a soft warning). Validated by Zod (never a DB CHECK) so a revision stays
 * additive.
 */
export const tradeDirectionSchema = z.enum(['EXP', 'DOM', 'IMP']);
export type TradeDirection = z.infer<typeof tradeDirectionSchema>;

/** FCL / LCL container load. */
export const fclLclSchema = z.enum(['FCL', 'LCL']);
export type FclLcl = z.infer<typeof fclLclSchema>;

/**
 * Shipment (logistics-4pl.shipment) lifecycle — thin and forward-only: PLANNED (생성) → BOOKED (선사/운송서류
 * 확정) → DEPARTED (출항) → ARRIVED (도착, terminal). A shipment is a NON-POSTING physical document (freight
 * accounting is a later slice). Validated by Zod here; enforced on the document table by a status CHECK.
 */
export const SHIPMENT_STATUS = ['PLANNED', 'BOOKED', 'DEPARTED', 'ARRIVED'] as const;
export const shipmentStatusSchema = z.enum(SHIPMENT_STATUS);
export type ShipmentStatus = z.infer<typeof shipmentStatusSchema>;
