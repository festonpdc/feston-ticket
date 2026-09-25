/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPayment, type PaymentRepository } from '../../packages/payments/src/core';
import type { PaymentProvider } from '../../packages/payments/src';

const order = { id: 'o1', organizationId: 'org', eventId: 'event', status: 'pending_payment' as const, total: 54000, currency: 'MXN', reservedUntil: new Date(Date.now() + 60000).toISOString(), itemCount: 2 };
function repo(): PaymentRepository { return { getOrderForPayment: vi.fn(async () => order), findReusablePayment: vi.fn(async () => null), createPayment: vi.fn(async p => ({ ...p, id: 'p1' })), attachIntent: vi.fn(async () => {}), markPaymentFailed: vi.fn(async () => {}), applyVerifiedEvent: vi.fn() }; }
const provider: PaymentProvider = { createPaymentIntent: vi.fn(async input => ({ providerPaymentId: `pi_${input.orderId}`, status: 'pending' as const, clientSecret: 'secret' })), verifyWebhook: vi.fn() };

describe('payment creation command', () => {
  beforeEach(() => vi.clearAllMocks());
  it('uses only authoritative order amount/currency and is idempotent for a reusable payment', async () => { const r = repo(); const result = await createPayment(r, provider, 'o1', 'card', 'attempt-1'); expect(result.intent.providerPaymentId).toBe('pi_o1'); expect((provider.createPaymentIntent as any).mock.calls[0][0]).toMatchObject({ amount: 54000, currency: 'MXN' }); });
  it('rejects expired card reservations and never calls Stripe', async () => { const r = repo(); (r.getOrderForPayment as any).mockResolvedValue({ ...order, reservedUntil: new Date(Date.now() - 1).toISOString() }); await expect(createPayment(r, provider, 'o1', 'card', 'attempt-1')).rejects.toThrow('Reservation expired'); expect(provider.createPaymentIntent).not.toHaveBeenCalled(); });
});
