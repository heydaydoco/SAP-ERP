import { describe, expect, it } from 'vitest';
import { SHIPMENT_STATUS_ORDER, nextShipmentStatus } from './shipment-status.js';

/**
 * Shipment forward-only lifecycle (§5.4 — the slice's only pure logic). The order drives the service's
 * sequential transition guards, so it must be exactly PLANNED → BOOKED → DEPARTED → ARRIVED, with ARRIVED
 * terminal and any unknown status non-advanceable.
 */
describe('nextShipmentStatus', () => {
  it('advances exactly one step along the lifecycle', () => {
    expect(nextShipmentStatus('PLANNED')).toBe('BOOKED');
    expect(nextShipmentStatus('BOOKED')).toBe('DEPARTED');
    expect(nextShipmentStatus('DEPARTED')).toBe('ARRIVED');
  });

  it('is terminal at ARRIVED and null for an unknown status', () => {
    expect(nextShipmentStatus('ARRIVED')).toBeNull();
    expect(nextShipmentStatus('CANCELLED')).toBeNull();
    expect(nextShipmentStatus('')).toBeNull();
  });

  it('fixes the canonical order', () => {
    expect(SHIPMENT_STATUS_ORDER).toEqual(['PLANNED', 'BOOKED', 'DEPARTED', 'ARRIVED']);
  });
});
