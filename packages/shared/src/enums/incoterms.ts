import { z } from 'zod';

/** Incoterms 2020 — used across sales, procurement, logistics-4pl, trade-compliance. */
export const INCOTERMS_2020 = [
  'EXW', // Ex Works
  'FCA', // Free Carrier
  'FAS', // Free Alongside Ship
  'FOB', // Free On Board
  'CFR', // Cost and Freight
  'CIF', // Cost, Insurance and Freight
  'CPT', // Carriage Paid To
  'CIP', // Carriage and Insurance Paid To
  'DAP', // Delivered At Place
  'DPU', // Delivered at Place Unloaded
  'DDP', // Delivered Duty Paid
] as const;

export const incotermSchema = z.enum(INCOTERMS_2020);
export type Incoterm = z.infer<typeof incotermSchema>;
