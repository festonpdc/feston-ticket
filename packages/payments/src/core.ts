import type { PaymentIntentInput, PaymentIntentResult, PaymentMethod, PaymentProvider, PaymentStatus } from './index';

export type PayableOrder = { id: string; organizationId: string; eventId: string; status: 'pending_payment' | 'paid' | 'expired' | 'cancelled'; total: number; currency: string; reservedUntil: string | null; itemCount: number };
export type LogicalPayment = { id: string; orderId: string; organizationId: string; provider: 'stripe'; method: PaymentMethod; amount: number; currency: string; status: PaymentStatus; providerPaymentId: string | null; providerEventId?: string | null };
export interface PaymentRepository { getOrderForPayment(orderId: string): Promise<PayableOrder | null>; findReusablePayment(orderId: string, method: PaymentMethod): Promise<LogicalPayment | null>; createPayment(payment: Omit<LogicalPayment, 'id'>): Promise<LogicalPayment>; attachIntent(paymentId: string, providerPaymentId: string): Promise<void>; markPaymentFailed(paymentId: string): Promise<void>; applyVerifiedEvent(input: { eventId: string; providerPaymentId: string; amount: number; currency: string; succeeded: boolean }): Promise<'applied' | 'duplicate' | 'rejected'>; }
export async function createPayment(repository: PaymentRepository, provider: PaymentProvider, orderId: string, method: PaymentMethod, idempotencyKey: string): Promise<{ payment: LogicalPayment; intent: PaymentIntentResult }> {
  const order = await repository.getOrderForPayment(orderId);
  if (!order || order.status !== 'pending_payment' || order.itemCount < 1 || order.total <= 0 || order.currency !== 'MXN') throw new Error('Order is not payable');
  if (method === 'card' && order.reservedUntil && new Date(order.reservedUntil).getTime() <= Date.now()) throw new Error('Reservation expired');
  const existing = await repository.findReusablePayment(order.id, method);
  if (existing?.providerPaymentId) return { payment: existing, intent: { providerPaymentId: existing.providerPaymentId, status: existing.status, clientSecret: null } };
  const payment = existing ?? await repository.createPayment({ orderId: order.id, organizationId: order.organizationId, provider: 'stripe', method, amount: order.total, currency: order.currency, status: 'pending', providerPaymentId: null });
  const input: PaymentIntentInput = { orderId: order.id, organizationId: order.organizationId, eventId: order.eventId, amount: payment.amount, currency: payment.currency, method, idempotencyKey };
  try { const intent = await provider.createPaymentIntent(input); await repository.attachIntent(payment.id, intent.providerPaymentId); return { payment: { ...payment, providerPaymentId: intent.providerPaymentId, status: intent.status }, intent }; }
  catch (error) { await repository.markPaymentFailed(payment.id); throw error; }
}

export async function processVerifiedStripeEvent(repository: PaymentRepository, event: { id: string; type: string; paymentIntentId: string; amount: number; currency: string }): Promise<'applied' | 'duplicate' | 'rejected'> {
  if (event.type !== 'payment_intent.succeeded' && event.type !== 'payment_intent.payment_failed' && event.type !== 'payment_intent.processing') return 'rejected';
  return repository.applyVerifiedEvent({ eventId: event.id, providerPaymentId: event.paymentIntentId, amount: event.amount, currency: event.currency.toUpperCase(), succeeded: event.type === 'payment_intent.succeeded' });
}
