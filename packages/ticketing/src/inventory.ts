import { orderStatus, quantity } from './index';

export type InventoryState = 'draft' | 'pending_payment' | 'paid' | 'expired' | 'cancelled' | 'refunded';
export function inventoryBreakdown(capacity: number, orders: readonly { quantity: number; status: InventoryState; reservedUntil: Date | null }[], at: Date) {
  if (!Number.isSafeInteger(capacity) || capacity < 0 || !Number.isFinite(at.getTime())) throw new Error('Invalid inventory inputs');
  let sold = 0;
  let reserved = 0;
  for (const order of orders) {
    orderStatus(order.status);
    const count = quantity(order.quantity);
    if (order.status === 'paid' || order.status === 'refunded') sold += count;
    else if (order.status === 'pending_payment') {
      if (!order.reservedUntil || !Number.isFinite(order.reservedUntil.getTime())) throw new Error('Invalid reservation deadline');
      if (order.reservedUntil > at) reserved += count;
    }
  }
  if (!Number.isSafeInteger(sold+reserved) || sold+reserved > capacity) throw new Error('Inventory invariant violated');
  return { capacity, sold, reserved, available: capacity-sold-reserved };
}

// Shape validation only. Authoritative limits, dates, prices and capacity live in SQL.
export function reservationItems(input: unknown): { ticket_type_id: string; quantity: number }[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) throw new Error('Invalid reservation items');
  const seen = new Set<string>();
  return input.map((line: unknown) => {
    if (!line || typeof line !== 'object' || Array.isArray(line)) throw new Error('Invalid reservation item');
    const fields = line as Record<string, unknown>;
    if (Object.keys(fields).length !== 2 || typeof fields.ticket_type_id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fields.ticket_type_id)) throw new Error('Invalid reservation item');
    const type = fields.ticket_type_id.toLowerCase();
    if (seen.has(type)) throw new Error('Duplicate ticket type');
    seen.add(type);
    return { ticket_type_id: type, quantity: quantity(fields.quantity) };
  });
}
