import { describe, expect, it } from 'vitest';
import { paymentViewFromStatus, reservationDisplay } from '../../apps/web/app/fiesta-de-disfraces/payment-state';

describe('checkout payment recovery state', () => {
  it('gives authoritative paid state precedence over an expired timer', () => {
    const state=paymentViewFromStatus({order_status:'paid',payment_status:'paid'});
    expect(state).toBe('paid');
    expect(reservationDisplay(state,0)).toBe('confirmed');
  });
  it('recovers a late-webhook paid result after refresh', () => {
    expect(reservationDisplay(paymentViewFromStatus({order_status:'paid',payment_status:'paid'}),-300)).toBe('confirmed');
  });
  it('keeps a recoverable payment processing after the reservation timer', () => {
    const state=paymentViewFromStatus({order_status:'pending_payment',payment_status:'pending',payment_recoverable:true});
    expect(reservationDisplay(state,0)).toBe('processing');
  });
  it('shows a live countdown for pending orders without a payment', () => {
    const state=paymentViewFromStatus({order_status:'pending_payment',payment_status:null,payment_recoverable:false});
    expect(reservationDisplay(state,120)).toBe('active');
  });
  it('expires a pending reservation without a recoverable payment', () => {
    const state=paymentViewFromStatus({order_status:'pending_payment',payment_status:null,payment_recoverable:false});
    expect(reservationDisplay(state,0)).toBe('expired');
  });
});
