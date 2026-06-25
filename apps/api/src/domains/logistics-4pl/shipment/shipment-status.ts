import { SHIPMENT_STATUS, type ShipmentStatus } from '@erp/shared';

/**
 * Shipment lifecycle is forward-only and sequential: PLANNED → BOOKED → DEPARTED → ARRIVED. The order is the
 * single source of truth for legal transitions; the service's book/depart/arrive guards step exactly one slot
 * forward (an atomic `WHERE status=<from>` flip), and this pure helper computes the legal next step for the
 * error message when a guard finds the shipment in the wrong state. (The domain's only pure unit — a shipment
 * is non-posting, so there is no money math; §5.4.)
 */
export const SHIPMENT_STATUS_ORDER = SHIPMENT_STATUS;

/** The single legal forward transition from `current`, or null if terminal (ARRIVED) or unknown. */
export function nextShipmentStatus(current: string): ShipmentStatus | null {
  const i = SHIPMENT_STATUS_ORDER.indexOf(current as ShipmentStatus);
  if (i < 0 || i === SHIPMENT_STATUS_ORDER.length - 1) return null;
  return SHIPMENT_STATUS_ORDER[i + 1] ?? null;
}
