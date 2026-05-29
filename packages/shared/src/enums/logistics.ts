import { z } from 'zod';

/** Transport mode (logistics-4pl.shipment.mode). */
export const transportModeSchema = z.enum(['SEA', 'AIR', 'RAIL', 'TRUCK']);
export type TransportMode = z.infer<typeof transportModeSchema>;

/** Trade direction (export / import). */
export const tradeDirectionSchema = z.enum(['EXP', 'IMP']);
export type TradeDirection = z.infer<typeof tradeDirectionSchema>;

/** FCL / LCL container load. */
export const fclLclSchema = z.enum(['FCL', 'LCL']);
export type FclLcl = z.infer<typeof fclLclSchema>;
