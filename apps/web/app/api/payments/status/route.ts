import { NextResponse } from 'next/server';
import { createAdminClient } from '@programita/database/admin';
import { verifyPaymentCapability } from '../../../../lib/payment-capability';
export const runtime = 'nodejs';
export async function POST(req: Request) {
  try {
    const body = await req.json() as { order_id?: unknown; capability?: unknown };
    if (typeof body.order_id !== 'string' || typeof body.capability !== 'string' || !verifyPaymentCapability(body.capability, body.order_id)) return NextResponse.json({ error: 'Reserva no autorizada' }, { status: 403 });
    const { data, error } = await createAdminClient().from('orders').select('id,status,total,currency').eq('id', body.order_id).maybeSingle();
    if (error || !data) return NextResponse.json({ error: 'Reserva no encontrada' }, { status: 404 });
    const { data: payment } = await createAdminClient().from('payments').select('status,provider_payment_id').eq('order_id', body.order_id).eq('provider', 'stripe').eq('method', 'card').maybeSingle();
    return NextResponse.json({ order_status: data.status, payment_status: payment?.status ?? null, total: data.total, currency: data.currency });
  } catch { return NextResponse.json({ error: 'No pudimos consultar el pago' }, { status: 500 }); }
}
