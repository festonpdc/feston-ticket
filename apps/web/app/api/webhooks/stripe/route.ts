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
  return handleVerifiedStripeEvent(event, createAdminClient());
}

export async function handleVerifiedStripeEvent(event: VerifiedStripeEvent, db: ReturnType<typeof createAdminClient>) {
  try {
    const result = await applyVerifiedStripeEvent(event, db);
    if (result === 'ignored') return NextResponse.json({ received: true });
    return NextResponse.json({ received: true, result });
  } catch {
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}

type VerifiedStripeEvent = { id: string; type: string; created: number; data: { object: unknown } };

type SupabaseRpcError = {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
};

function sanitizeLogValue(value: unknown) {
  if (typeof value !== 'string') return undefined;

  return value
    .slice(0, 2_000)
    .replace(/\b(?:sk|pk|whsec)_(?:test|live)_[A-Za-z0-9_-]+\b/gi, '[REDACTED_STRIPE_SECRET]')
    .replace(/\bpi_[A-Za-z0-9]+_secret_[A-Za-z0-9_-]+\b/gi, '[REDACTED_CLIENT_SECRET]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_TOKEN]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\+?\d[\d ()-]{7,}\d/g, '[REDACTED_PHONE]')
    .replace(/\b(authorization|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function logRpcError(error: SupabaseRpcError, context: {
  eventId: string;
  eventType: string;
  providerPaymentId: string;
  orderId?: string;
}) {
  console.error('stripe_webhook.stage=payment_event_rpc_failed', {
    event_id: context.eventId,
    event_type: context.eventType,
    provider_payment_id: context.providerPaymentId,
    ...(context.orderId ? { order_id: context.orderId } : {}),
    code: sanitizeLogValue(error.code),
    message: sanitizeLogValue(error.message),
    details: sanitizeLogValue(error.details),
    hint: sanitizeLogValue(error.hint),
  });
}

export async function applyVerifiedStripeEvent(event: VerifiedStripeEvent, db: ReturnType<typeof createAdminClient>) {
    if (!['payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.processing'].includes(event.type)) return 'ignored' as const;
    const intent = event.data.object as { id?: string; amount?: number; currency?: string; payment_method_types?: string[]; metadata?: { order_id?: unknown } };
    if (!intent.id || typeof intent.amount !== 'number' || typeof intent.currency !== 'string') throw new Error('invalid_payment_intent');
    const method = intent.payment_method_types?.includes('oxxo') ? 'oxxo' : 'card';
    const repository = {
      applyVerifiedEvent: async (input) => {
        const result = await db.rpc('apply_stripe_payment_event' as never, {
          p_provider_event_id: input.eventId, p_provider_payment_id: input.providerPaymentId,
          p_event_type: input.eventType, p_amount: input.amount, p_currency: input.currency,
          p_method: input.method, p_provider_event_created_at: input.providerEventCreatedAt,
        } as never);
        if (result.error) {
          logRpcError(result.error, {
            eventId: input.eventId,
            eventType: input.eventType,
            providerPaymentId: input.providerPaymentId,
            ...(typeof intent.metadata?.order_id === 'string' ? { orderId: intent.metadata.order_id } : {}),
          });
          throw new Error('payment_event_rpc_failed');
        }
        const value = result.data as { status?: string } | null;
        return value?.status === 'duplicate' ? 'duplicate'
          : value?.status === 'applied' ? 'applied'
            : value?.status === 'reconciliation_required' ? 'reconciliation_required' : 'rejected';
      },
    } as Pick<PaymentRepository, 'applyVerifiedEvent'> as PaymentRepository;
    const result = await processVerifiedStripeEvent(repository, {
      id: event.id, type: event.type, created: event.created, paymentIntentId: intent.id,
      amount: intent.amount, currency: intent.currency, method,
    });
    return result;
}
