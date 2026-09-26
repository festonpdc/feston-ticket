import { beforeEach, describe, expect, it, vi } from 'vitest';

const stripeCreate = vi.fn();

import { StripePaymentProvider } from '../../packages/payments/src';

describe('Stripe OXXO provider configuration', () => {
  beforeEach(() => stripeCreate.mockReset());

  it('requests a one-day OXXO voucher without changing authoritative money', async () => {
    stripeCreate.mockResolvedValue({
      id: 'pi_test_oxxo', status: 'requires_action', client_secret: 'redacted-in-test',
      next_action: { type: 'oxxo_display_details', oxxo_display_details: {
        expires_after: 1790452487, hosted_voucher_url: 'https://payments.stripe.com/oxxo/test',
      } },
    });
    const provider = new StripePaymentProvider('sk_test_placeholder', undefined, {
      paymentIntents: { create: stripeCreate },
    } as unknown as ConstructorParameters<typeof StripePaymentProvider>[2]);
    const result = await provider.createPaymentIntent({
      orderId: 'order-1', organizationId: 'org-1', eventId: 'event-1', amount: 28600,
      currency: 'MXN', method: 'oxxo', idempotencyKey: 'payment-order-1-oxxo',
    });
    expect(stripeCreate).toHaveBeenCalledWith(expect.objectContaining({
      amount: 28600, currency: 'mxn', payment_method_types: ['oxxo'],
      payment_method_options: { oxxo: { expires_after_days: 1 } },
    }), { idempotencyKey: 'payment-order-1-oxxo' });
    expect(result).toMatchObject({
      providerPaymentId: 'pi_test_oxxo', status: 'awaiting_cash',
      voucher: { expiresAt: '2026-09-26T19:54:47.000Z', hostedVoucherUrl: 'https://payments.stripe.com/oxxo/test' },
    });
  });
});
