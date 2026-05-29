import { z } from 'zod';

/** SWIFT MT message types relevant to trade finance / L/C (integration.swift-connector). */
export const SWIFT_MT_TYPES = [
  'MT700', // Issue of a Documentary Credit
  'MT701', // Issue of a Documentary Credit (extension)
  'MT707', // Amendment to a Documentary Credit
  'MT710', // Advice of a Third Bank's Documentary Credit
  'MT720', // Transfer of a Documentary Credit
  'MT730', // Acknowledgement
  'MT740', // Authorisation to Reimburse
  'MT750', // Advice of Discrepancy
  'MT754', // Advice of Payment/Acceptance/Negotiation
  'MT760', // Demand Guarantee / Standby Letter of Credit
] as const;

export const swiftMtTypeSchema = z.enum(SWIFT_MT_TYPES);
export type SwiftMtType = z.infer<typeof swiftMtTypeSchema>;
