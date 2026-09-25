export type PaymentView = 'checking'|'idle'|'preparing'|'ready'|'processing'|'paid'|'failed';
export type ReservationDisplay = 'confirmed'|'processing'|'active'|'expired';

export function paymentViewFromStatus(result: {
  order_status?: unknown;
  payment_status?: unknown;
  payment_recoverable?: unknown;
}): PaymentView {
  if (result.order_status === 'paid' && result.payment_status === 'paid') return 'paid';
  if (result.order_status === 'expired' || result.order_status === 'cancelled'
    || ['failed','cancelled','expired'].includes(String(result.payment_status))) return 'failed';
  if (result.payment_recoverable === true
    && ['pending','processing'].includes(String(result.payment_status))) return 'processing';
  return 'idle';
}

export function reservationDisplay(paymentState: PaymentView, seconds: number): ReservationDisplay {
  if (paymentState === 'paid') return 'confirmed';
  if (paymentState === 'checking' || paymentState === 'processing') return 'processing';
  return seconds > 0 ? 'active' : 'expired';
}
