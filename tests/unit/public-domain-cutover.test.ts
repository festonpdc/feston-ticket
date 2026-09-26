import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueEmailTicketAccess, verifyEmailTicketAccess } from '../../apps/web/lib/email-ticket-access';
import { ticketPublicUrl, ticketToken, ticketTokenHash } from '../../apps/web/lib/ticket-token';

const root=readFileSync('apps/web/app/page.tsx','utf8');
const event=readFileSync('apps/web/app/fiesta-de-disfraces/page.tsx','utf8');
const paymentCreate=readFileSync('apps/web/app/api/payments/create/route.ts','utf8');
const official='https://tickets.gruposantino.com.mx';
const previousOrigin=process.env.PUBLIC_APP_URL;
const previousSecret=process.env.TICKET_QR_SECRET;

describe('public Santino domain cutover',()=>{
  beforeEach(()=>{
    process.env.PUBLIC_APP_URL=official;
    process.env.TICKET_QR_SECRET='test-ticket-secret-that-is-long-enough-for-hmac';
  });
  afterEach(()=>{
    if(previousOrigin===undefined)delete process.env.PUBLIC_APP_URL;else process.env.PUBLIC_APP_URL=previousOrigin;
    if(previousSecret===undefined)delete process.env.TICKET_QR_SECRET;else process.env.TICKET_QR_SECRET=previousSecret;
  });

  it('redirects the root to the active event without exposing internal foundation copy',()=>{
    expect(root).toContain("redirect('/fiesta-de-disfraces')");
    expect(root).not.toMatch(/Programita Ticketing Core|Foundation/);
    expect(event).toContain('TicketsSection');
  });

  it('generates new ticket links only on the configured official HTTPS origin',()=>{
    const token=ticketToken('11111111-1111-4111-8111-111111111111');
    const hash=ticketTokenHash(token);
    const url=ticketPublicUrl(token);
    expect(url).toBe(`${official}/t/${token}`);
    expect(url).not.toMatch(/localhost|vercel\.app/);
    process.env.PUBLIC_APP_URL='https://legacy.example.test';
    expect(ticketTokenHash(token)).toBe(hash);
  });

  it('keeps cross-device capability valid while changing only its presentation origin',()=>{
    const capability=issueEmailTicketAccess('22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333',Date.now()+60_000);
    expect(verifyEmailTicketAccess(capability)).toMatchObject({orderId:'33333333-3333-4333-8333-333333333333'});
    expect(capability).not.toContain(official);
  });

  it('uses PUBLIC_APP_URL for the Stripe customer return and never trusts Host or APP_URL',()=>{
    expect(paymentCreate).toContain("publicAppUrl('/fiesta-de-disfraces?payment_return=1#entradas')");
    const returnHelper=paymentCreate.slice(paymentCreate.indexOf('function paymentReturnUrl'));
    expect(returnHelper).not.toMatch(/APP_URL|headers|host|localhost|vercel\.app/i);
  });
});
