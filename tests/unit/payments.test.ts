import { describe, expect, it } from 'vitest';
import { mapStripeStatus } from '../../packages/payments/src/index';

describe('Stripe payment foundation', () => {
  it('maps card and OXXO states without treating voucher generation as paid', () => {
    expect(mapStripeStatus('succeeded', 'card')).toBe('paid');
    expect(mapStripeStatus('processing', 'card')).toBe('processing');
    expect(mapStripeStatus('processing', 'oxxo')).toBe('awaiting_cash');
    expect(mapStripeStatus('requires_payment_method', 'card')).toBe('pending');
  });
});
