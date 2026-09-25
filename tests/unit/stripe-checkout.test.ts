import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const paymentElement = readFileSync('apps/web/app/fiesta-de-disfraces/payment-element.tsx', 'utf8');
const tickets = readFileSync('apps/web/app/fiesta-de-disfraces/tickets.tsx', 'utf8');
const createRoute = readFileSync('apps/web/app/api/payments/create/route.ts', 'utf8');
const statusRoute = readFileSync('apps/web/app/api/payments/status/route.ts', 'utf8');
const paymentState = readFileSync('apps/web/app/fiesta-de-disfraces/payment-state.ts', 'utf8');

describe('Stripe card checkout contract', () => {
  it('uses official Elements in card-only mode and confirms through Stripe', () => {
    expect(paymentElement).toContain('stripe.confirmPayment');
    expect(paymentElement).toContain("paymentMethodOrder: ['card']");
    expect(paymentElement).toContain("redirect: 'if_required'");
    expect(paymentElement).not.toMatch(/card_number|\bpan\b|\bcvc\b/i);
  });
  it('never sends browser amount or currency to payment creation', () => {
    const request = tickets.match(/fetch\('\/api\/payments\/create'[\s\S]*?\}\)\}\);/)?.[0] ?? '';
    expect(request).toContain('capability:data.payment_capability');
    expect(request).not.toMatch(/amount|currency/);
    expect(createRoute).toContain('Number(order.total)');
    expect(createRoute).toContain('currency: order.currency');
  });
  it('never accepts provider event time from the browser payment route', () => {
    expect(tickets).not.toContain('provider_event_created_at');
    expect(createRoute).not.toContain('provider_event_created_at');
  });
  it('persists the Stripe identifier in the immutable payment snapshot at insert time', () => {
    expect(createRoute).toContain('provider_payment_id: intent.providerPaymentId');
    expect(createRoute).not.toMatch(/from\('payments'\)\.update\(\{\s*provider_payment_id/);
    expect(createRoute).toContain("if (existing) return fail('No pudimos preparar el pago', 409)");
    expect(createRoute).toContain('if (created.error || !created.data)');
    expect(createRoute.indexOf("if (existing) return fail('No pudimos preparar el pago', 409)")).toBeLessThan(createRoute.indexOf('provider.createPaymentIntent'));
  });
  it('protects create and status with the reservation capability', () => {
    expect(createRoute).toContain('verifyPaymentCapability');
    expect(statusRoute).toContain('verifyPaymentStatusCapability');
    expect(tickets).toContain("sessionStorage.setItem('feston-payment-session'");
    expect(tickets).not.toMatch(/sessionStorage\.setItem\([^\n]*clientSecret/);
  });
  it('polls authoritative status and renders paid only from the server result', () => {
    expect(tickets).toContain("fetch('/api/payments/status'");
    expect(tickets).toContain('paymentViewFromStatus(result)');
    expect(paymentState).toContain("result.order_status === 'paid' && result.payment_status === 'paid'");
    expect(tickets).toContain('PAGO CONFIRMADO');
  });
});
