export type Currency = string & { readonly __currency: unique symbol };
export function currency(value: unknown): Currency {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) throw new Error('Invalid currency');
  return value as Currency;
}
export function minorUnits(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid minor units');
  return value;
}
export function quantity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new Error('Invalid quantity');
  return value;
}
export function lineSubtotal(unitPrice: number, count: number): number {
  return minorUnits(minorUnits(unitPrice) * quantity(count));
}
// Inputs must be server-loaded prices or persisted snapshots, never browser prices.
export function orderTotal(lines: readonly { unitPrice: number; quantity: number; currency: string }[]) {
  if (!lines.length) throw new Error('Order requires items');
  const unit = currency(lines[0]!.currency);
  const total = lines.reduce((sum, line) => {
    if (currency(line.currency) !== unit) throw new Error('Mixed currencies');
    return minorUnits(sum + lineSubtotal(line.unitPrice, line.quantity));
  }, 0);
  return { currency: unit, subtotal: total, total };
}
export const orderStatuses = ['draft', 'pending_payment', 'paid', 'expired', 'cancelled', 'refunded'] as const;
export type OrderStatus = typeof orderStatuses[number];
const transitions: Record<OrderStatus, readonly OrderStatus[]> = {
  draft: ['pending_payment', 'cancelled'], pending_payment: ['paid', 'expired', 'cancelled'],
  paid: ['refunded'], expired: [], cancelled: [], refunded: [],
};
export function orderStatus(value: unknown): OrderStatus {
  if (typeof value !== 'string' || !orderStatuses.includes(value as OrderStatus)) throw new Error('Invalid order status');
  return value as OrderStatus;
}
export function assertOrderTransition(from: unknown, to: unknown): void {
  if (!transitions[orderStatus(from)].includes(orderStatus(to))) throw new Error('Invalid order transition');
}
