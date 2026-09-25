import { NextResponse } from 'next/server';
import { StripePaymentProvider } from '@programita/payments';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const signature = request.headers.get('stripe-signature');
  if (!signature) return NextResponse.json({ error: 'Invalid webhook' }, { status: 400 });
  try {
    const payload = await request.text();
    const event = new StripePaymentProvider().verifyWebhook(payload, signature);
    // Fase 5A only verifies and classifies. Paid transitions require the DB service in 5B.
    if (!['payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.processing'].includes(event.type)) return NextResponse.json({ received: true });
    return NextResponse.json({ received: true, classified: event.type });
  } catch { return NextResponse.json({ error: 'Invalid webhook' }, { status: 400 }); }
}
