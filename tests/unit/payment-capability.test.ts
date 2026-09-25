import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issuePaymentCapability, verifyPaymentCapability } from '../../apps/web/lib/payment-capability';

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
});
