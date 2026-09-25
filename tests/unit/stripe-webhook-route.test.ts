import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const verifyWebhookMock = vi.fn();
vi.mock('@programita/database/admin', () => ({ createAdminClient: () => ({ rpc }) }));
vi.mock('@programita/payments', () => ({
  StripePaymentProvider: class { verifyWebhook = verifyWebhookMock; },
}));

describe('Stripe webhook route', () => {
  beforeEach(() => { rpc.mockReset(); verifyWebhookMock.mockReset(); });

  it('rejects a missing signature before verification or RPC', async () => {
    const { POST } = await import('../../apps/web/app/api/webhooks/stripe/route');
    const response = await POST(new Request('http://localhost/api/webhooks/stripe', { method: 'POST', body: '{}' }));
    expect(response.status).toBe(400);
    expect(verifyWebhookMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('passes a verified card success through the public financial bridge', async () => {
    verifyWebhookMock.mockReturnValue({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', amount: 54000, currency: 'mxn', payment_method_types: ['card'] } } });
    rpc.mockResolvedValue({ data: { status: 'applied' }, error: null });
    const { applyVerifiedStripeEvent } = await import('../../apps/web/app/api/webhooks/stripe/route');
    await expect(applyVerifiedStripeEvent(verifyWebhookMock() as never, { rpc } as never)).resolves.toBe('applied');
    expect(rpc).toHaveBeenCalledWith('apply_stripe_payment_event', expect.objectContaining({
      p_provider_event_id: 'evt_1', p_provider_payment_id: 'pi_1',
      p_event_type: 'payment_intent.succeeded', p_amount: 54000,
      p_currency: 'MXN', p_method: 'card',
    }));
  });

  it('never interprets a failed payment as paid', async () => {
    verifyWebhookMock.mockReturnValue({ id: 'evt_2', type: 'payment_intent.payment_failed', data: { object: { id: 'pi_2', amount: 54000, currency: 'mxn', payment_method_types: ['card'] } } });
    rpc.mockResolvedValue({ data: { status: 'applied', payment_status: 'failed' }, error: null });
    const { applyVerifiedStripeEvent } = await import('../../apps/web/app/api/webhooks/stripe/route');
    await applyVerifiedStripeEvent(verifyWebhookMock() as never, { rpc } as never);
    expect(rpc).toHaveBeenCalledWith('apply_stripe_payment_event', expect.objectContaining({ p_event_type: 'payment_intent.payment_failed' }));
  });

  it('returns a retryable server error when the financial bridge fails', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'XX000' } });
    const { applyVerifiedStripeEvent } = await import('../../apps/web/app/api/webhooks/stripe/route');
    await expect(applyVerifiedStripeEvent({ id: 'evt_3', type: 'payment_intent.succeeded', data: { object: { id: 'pi_3', amount: 54000, currency: 'mxn', payment_method_types: ['card'] } } }, { rpc } as never)).rejects.toThrow('payment_event_rpc_failed');
  });
});
