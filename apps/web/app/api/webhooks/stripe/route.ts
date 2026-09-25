import { NextResponse } from 'next/server';
import { StripePaymentProvider } from '@programita/payments';
import { processVerifiedStripeEvent, type PaymentRepository } from '@programita/payments/core';
import { createAdminClient } from '@programita/database/admin';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const signature = request.headers.get('stripe-signature');
  if (!signature) return NextResponse.json({ error: 'Invalid webhook' }, { status: 400 });
  const payload = await request.text();
  let event: VerifiedStripeEvent;
  try {
    event = new StripePaymentProvider().verifyWebhook(payload, signature);
  } catch {
    return NextResponse.json({ error: 'Invalid webhook' }, { status: 400 });
  }
  try {
    const db = createAdminClient();
    const result = await applyVerifiedStripeEvent(event, db);
    if (result === 'ignored') return NextResponse.json({ received: true });
    return NextResponse.json({ received: true, result });
  } catch {
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}

type VerifiedStripeEvent = { id: string; type: string; data: { object: unknown } };
export async function applyVerifiedStripeEvent(event: VerifiedStripeEvent, db: ReturnType<typeof createAdminClient>) {
    if (!['payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.processing'].includes(event.type)) return 'ignored' as const;
    const intent = event.data.object as { id?: string; amount?: number; currency?: string; payment_method_types?: string[] };
    if (!intent.id || typeof intent.amount !== 'number' || typeof intent.currency !== 'string') throw new Error('invalid_payment_intent');
    const method = intent.payment_method_types?.includes('oxxo') ? 'oxxo' : 'card';
    const repository = {
      applyVerifiedEvent: async (input) => {
        const result = await db.rpc('apply_stripe_payment_event' as never, {
          p_provider_event_id: input.eventId, p_provider_payment_id: input.providerPaymentId,
          p_event_type: input.eventType, p_amount: input.amount, p_currency: input.currency,
          p_method: input.method,
        } as never);
        if (result.error) throw new Error('payment_event_rpc_failed');
        const value = result.data as { status?: string } | null;
        return value?.status === 'duplicate' ? 'duplicate' : value?.status === 'applied' ? 'applied' : 'rejected';
      },
    } as Pick<PaymentRepository, 'applyVerifiedEvent'> as PaymentRepository;
    const result = await processVerifiedStripeEvent(repository, {
      id: event.id, type: event.type, paymentIntentId: intent.id,
      amount: intent.amount, currency: intent.currency, method,
    });
    return result;
}
