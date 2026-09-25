import { NextResponse } from 'next/server';
import { createAdminClient } from '@programita/database/admin';
import { StripePaymentProvider } from '@programita/payments';
import { verifyPaymentCapability } from '../../../../lib/payment-capability';
export const runtime = 'nodejs';
const fail = (error: string, status = 400) => NextResponse.json({ error }, { status });
export async function POST(req: Request) {
  try {
    if (req.headers.get('content-type')?.split(';')[0] !== 'application/json') return fail('Solicitud invÃ¡lida', 415);
    const body = await req.json() as { order_id?: unknown; payment_method?: unknown; capability?: unknown; idempotency_key?: unknown };
    if (typeof body.order_id !== 'string' || typeof body.capability !== 'string' || body.payment_method !== 'card' || typeof body.idempotency_key !== 'string' || !/^[a-f0-9]{64}$/.test(body.idempotency_key)) return fail('Solicitud invÃ¡lida');
    if (!verifyPaymentCapability(body.capability, body.order_id)) return fail('Reserva no autorizada', 403);
    const db = createAdminClient();
    const { data: order, error } = await db.from('orders').select('id,organization_id,event_id,status,total,currency,reserved_until').eq('id', body.order_id).maybeSingle();
    if (error || !order || order.status !== 'pending_payment' || !order.reserved_until || Date.parse(order.reserved_until) <= Date.now() || order.currency !== 'MXN') return fail('La reserva no estÃ¡ disponible', 409);
    const provider = new StripePaymentProvider();
    const { data: existing } = await db.from('payments').select('id,provider_payment_id,status').eq('order_id', order.id).eq('provider', 'stripe').eq('method', 'card').maybeSingle();
    if (existing?.provider_payment_id) {
      const intent = await provider.retrievePaymentIntent(existing.provider_payment_id);
      if (!intent.clientSecret) return fail('No pudimos preparar el pago', 409);
      return NextResponse.json({ client_secret: intent.clientSecret, payment_intent_id: intent.providerPaymentId, status: intent.status, return_url: paymentReturnUrl() });
    }
    const intent = await provider.createPaymentIntent({ orderId: order.id, organizationId: order.organization_id, eventId: order.event_id, amount: Number(order.total), currency: order.currency, method: 'card', idempotencyKey: body.idempotency_key });
    const payment = existing ?? (await db.from('payments').insert({ organization_id: order.organization_id, order_id: order.id, provider: 'stripe', method: 'card', amount: order.total, currency: order.currency, status: 'pending' }).select('id').single()).data;
    if (!payment) return fail('No pudimos preparar el pago', 500);
    await db.from('payments').update({ provider_payment_id: intent.providerPaymentId, status: intent.status as never }).eq('id', payment.id);
    return NextResponse.json({ client_secret: intent.clientSecret, payment_intent_id: intent.providerPaymentId, status: intent.status as never, return_url: paymentReturnUrl() });
  } catch { return fail('No pudimos preparar el pago', 500); }
}
function paymentReturnUrl() {
  const configured = process.env.APP_URL;
  if (!configured) {
    if (process.env.NODE_ENV === 'production') throw new Error('APP_URL is required');
    return 'http://localhost:3000/fiesta-de-disfraces?payment_return=1#entradas';
  }
  const url = new URL(configured);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost')) throw new Error('APP_URL is invalid');
  return new URL('/fiesta-de-disfraces?payment_return=1#entradas', url).toString();
}

