import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { clearCompletedCheckout } from '../../apps/web/app/fiesta-de-disfraces/checkout-session';

const source=readFileSync('apps/web/app/fiesta-de-disfraces/tickets.tsx','utf8');

describe('fresh purchase after a completed checkout',()=>{
  it('clears only checkout-local session keys',()=>{
    const removeItem=vi.fn();
    clearCompletedCheckout({removeItem});
    expect(removeItem.mock.calls).toEqual([
      ['feston-payment-session'],
      ['feston-payment-active']
    ]);
  });

  it('keeps paid recovery by default and exposes an explicit reset action',()=>{
    expect(source).toContain("sessionStorage.getItem('feston-payment-session')");
    expect(source).toContain('PAGO CONFIRMADO');
    expect(source).toContain('COMPRAR MÁS ENTRADAS');
    expect(source).toContain('setDone(null);setCounts({})');
  });

  it('does not mutate financial, ticket, or delivery state during reset',()=>{
    const reset=source.slice(source.indexOf('const startNewPurchase='),source.indexOf('const submit='));
    expect(reset).not.toMatch(/fetch|\/api\/|order|payment|ticket|delivery/i);
  });

  it('renders current authoritative release labels and charge amounts',()=>{
    expect(source).toContain('t.display_price_label??money(t.price,t.currency)');
    expect(source).toContain("t.display_price_label?.startsWith('USD ')");
    expect(source).toContain('Cobro: ${money(t.price,t.currency)} c/u');
  });
});
