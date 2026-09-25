import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issuePaymentCapability, verifyPaymentCapability, verifyPaymentStatusCapability } from '../../apps/web/lib/payment-capability';

describe('payment capability', () => {
  const original = process.env.SUPABASE_SERVICE_ROLE_KEY;
  beforeEach(() => { process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only-capability-secret'; });
  afterEach(() => {
    if (original === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = original;
  });

  it('authorizes only its order before expiration', () => {
    const token = issuePaymentCapability('order-a', new Date(Date.now() + 60_000).toISOString());
    expect(verifyPaymentCapability(token, 'order-a')).toBe(true);
    expect(verifyPaymentCapability(token, 'order-b')).toBe(false);
  });

  it('rejects tampering and expired capabilities', () => {
    const valid = issuePaymentCapability('order-a', new Date(Date.now() + 60_000).toISOString());
    expect(verifyPaymentCapability(valid + 'x', 'order-a')).toBe(false);
    const expired = issuePaymentCapability('order-a', new Date(Date.now() - 1).toISOString());
    expect(verifyPaymentCapability(expired, 'order-a')).toBe(false);
  });
  it('allows a signed expired reservation capability only for short status recovery', () => {
    const recentlyExpired = issuePaymentCapability('order-a', new Date(Date.now() - 60_000).toISOString());
    expect(verifyPaymentCapability(recentlyExpired, 'order-a')).toBe(false);
    expect(verifyPaymentStatusCapability(recentlyExpired, 'order-a')).toBe(true);
    expect(verifyPaymentStatusCapability(recentlyExpired, 'order-b')).toBe(false);
    const tooOld = issuePaymentCapability('order-a', new Date(Date.now() - 25*60*60*1000).toISOString());
    expect(verifyPaymentStatusCapability(tooOld, 'order-a')).toBe(false);
  });
});
