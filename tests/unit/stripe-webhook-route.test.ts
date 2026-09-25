import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const verifyWebhookMock = vi.fn();
vi.mock('@programita/database/admin', () => ({ createAdminClient: () => ({ rpc }) }));
vi.mock('@programita/payments', () => ({
  StripePaymentProvider: class { verifyWebhook(...args: unknown[]) { return verifyWebhookMock(...args); } },
}));

describe('Stripe webhook route', () => {
  beforeEach(() => { vi.resetModules(); rpc.mockReset(); verifyWebhookMock.mockReset(); });

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
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpc.mockResolvedValue({ data: null, error: {
      code: 'P0001',
      message: 'payment transition failed client_secret=pi_3_secret_private',
      details: 'buyer@example.com cannot use sk_test_private',
      hint: 'authorization=Bearer-private-token',
    } });
    const event = {
      id: 'evt_3',
      type: 'payment_intent.succeeded',
      data: { object: {
        id: 'pi_3', amount: 54000, currency: 'mxn', payment_method_types: ['card'],
        client_secret: 'pi_3_secret_raw-payload-value',
        raw_payload: 'payload-secret',
        metadata: { order_id: 'order_3', buyer_email: 'raw@example.com' },
      } },
    };

    const { handleVerifiedStripeEvent } = await import('../../apps/web/app/api/webhooks/stripe/route');
    const response = await handleVerifiedStripeEvent(event as never, { rpc } as never);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Webhook processing failed' });
    expect(log).toHaveBeenCalledWith('stripe_webhook.stage=payment_event_rpc_failed', {
      event_id: 'evt_3',
      event_type: 'payment_intent.succeeded',
      provider_payment_id: 'pi_3',
      order_id: 'order_3',
      code: 'P0001',
      message: 'payment transition failed client_secret=[REDACTED_CLIENT_SECRET]',
      details: '[REDACTED_EMAIL] cannot use [REDACTED_STRIPE_SECRET]',
      hint: 'authorization=[REDACTED]',
    });
    const serializedLog = JSON.stringify(log.mock.calls);
    expect(serializedLog).not.toContain('pi_3_secret_private');
    expect(serializedLog).not.toContain('payload-secret');
    expect(serializedLog).not.toContain('raw@example.com');
    expect(serializedLog).not.toContain('sk_test_private');
    log.mockRestore();
  });
});
