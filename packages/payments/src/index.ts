import 'server-only';
import Stripe from 'stripe';

export type PaymentMethod = 'card' | 'oxxo';
export type PaymentStatus = 'pending' | 'processing' | 'paid' | 'failed' | 'cancelled' | 'expired' | 'awaiting_cash';
export type PaymentIntentInput = { orderId: string; amount: number; currency: string; method: PaymentMethod; organizationId?: string; eventId?: string; idempotencyKey: string };
export type PaymentIntentResult = { providerPaymentId: string; status: PaymentStatus; clientSecret: string | null; voucher?: { expiresAt: string | null; hostedVoucherUrl: string | null } };
export interface PaymentProvider { createPaymentIntent(input: PaymentIntentInput): Promise<PaymentIntentResult>; verifyWebhook(payload: string | Buffer, signature: string): Stripe.Event; }
function mapStripeStatus(status: Stripe.PaymentIntent.Status, method: PaymentMethod): PaymentStatus { if (status === 'succeeded') return 'paid'; if (status === 'processing' || status === 'requires_action' && method === 'oxxo') return method === 'oxxo' ? 'awaiting_cash' : 'processing'; if (status === 'canceled') return 'cancelled'; if (status === 'requires_payment_method') return 'pending'; return 'pending'; }
export class StripePaymentProvider implements PaymentProvider {
  private readonly stripe: Stripe; private readonly webhookSecret: string | undefined;
  constructor(secretKey = process.env.STRIPE_SECRET_KEY, webhookSecret = process.env.STRIPE_WEBHOOK_SECRET, stripeClient?: Stripe) { if (!secretKey) throw new Error('Stripe server environment is not configured'); this.stripe = stripeClient ?? new Stripe(secretKey); this.webhookSecret = webhookSecret; }
  async createPaymentIntent(input: PaymentIntentInput): Promise<PaymentIntentResult> {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new Error('Invalid payment amount');
    const payment_method_types = input.method === 'oxxo' ? ['oxxo'] : ['card'];
    const intent = await this.stripe.paymentIntents.create({ amount: input.amount, currency: input.currency.toLowerCase(), payment_method_types, ...(input.method === 'oxxo' ? { payment_method_options: { oxxo: { expires_after_days: 1 } } } : {}), metadata: { order_id: input.orderId, ...(input.organizationId ? { organization_id: input.organizationId } : {}), ...(input.eventId ? { event_id: input.eventId } : {}) } }, { idempotencyKey: input.idempotencyKey });
    const voucher = input.method === 'oxxo' && intent.next_action?.type === 'oxxo_display_details' ? { expiresAt: intent.next_action.oxxo_display_details?.expires_after ? new Date(intent.next_action.oxxo_display_details.expires_after * 1000).toISOString() : null, hostedVoucherUrl: intent.next_action.oxxo_display_details?.hosted_voucher_url ?? null } : undefined;
    return { providerPaymentId: intent.id, status: mapStripeStatus(intent.status, input.method), clientSecret: intent.client_secret, ...(voucher ? { voucher } : {}) };
  }
  async retrievePaymentIntent(providerPaymentId: string): Promise<PaymentIntentResult> {
    const intent = await this.stripe.paymentIntents.retrieve(providerPaymentId);
    const method: PaymentMethod = intent.payment_method_types.includes('oxxo') ? 'oxxo' : 'card';
    return {
      providerPaymentId: intent.id,
      status: mapStripeStatus(intent.status, method),
      clientSecret: intent.client_secret,
    };
  }
  verifyWebhook(payload: string | Buffer, signature: string): Stripe.Event { if (!this.webhookSecret) throw new Error('Stripe webhook environment is not configured'); return this.stripe.webhooks.constructEvent(payload, signature, this.webhookSecret); }
}
export { mapStripeStatus };
