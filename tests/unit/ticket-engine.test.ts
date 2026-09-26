import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ticketManifest, ticketPublicUrl, ticketTokenHash } from '../../apps/web/lib/ticket-token';

const api=readFileSync('apps/web/app/api/tickets/route.ts','utf8');
const publicTicket=readFileSync('apps/web/app/t/[token]/page.tsx','utf8');

describe('secure ticket delivery',()=>{
  const originalSecret=process.env.TICKET_QR_SECRET;
  const originalUrl=process.env.PUBLIC_APP_URL;
  const originalAppUrl=process.env.APP_URL;
  const originalHost=process.env.HOST;
  beforeEach(()=>{process.env.TICKET_QR_SECRET='test-ticket-secret-that-is-long-enough-for-hmac';process.env.PUBLIC_APP_URL='https://tickets.example.test'});
  afterEach(()=>{if(originalSecret===undefined)delete process.env.TICKET_QR_SECRET;else process.env.TICKET_QR_SECRET=originalSecret;if(originalUrl===undefined)delete process.env.PUBLIC_APP_URL;else process.env.PUBLIC_APP_URL=originalUrl;if(originalAppUrl===undefined)delete process.env.APP_URL;else process.env.APP_URL=originalAppUrl;if(originalHost===undefined)delete process.env.HOST;else process.env.HOST=originalHost});

  it('creates deterministic unique per-unit identities without storing raw tokens in the DB manifest',()=>{
    const first=ticketManifest([{id:'11111111-1111-4111-8111-111111111111',quantity:3}]);
    const retry=ticketManifest([{id:'11111111-1111-4111-8111-111111111111',quantity:3}]);
    expect(first).toEqual(retry);
    expect(new Set(first.map(ticket=>ticket.id)).size).toBe(3);
    expect(new Set(first.map(ticket=>ticket.token)).size).toBe(3);
    expect(first.every(ticket=>ticket.secure_token_hash===ticketTokenHash(ticket.token))).toBe(true);
    expect(api).toContain('secure_token_hash:ticket.secure_token_hash');
    expect(api).not.toContain('token:ticket.token');
  });
  it('builds external QR URLs only from the configured public HTTPS origin',()=>{
    const token=ticketManifest([{id:'11111111-1111-4111-8111-111111111111',quantity:1}])[0]!.token;
    expect(ticketPublicUrl(token)).toBe(`https://tickets.example.test/t/${token}`);
    process.env.APP_URL='http://localhost:3000';
    process.env.HOST='attacker.example';
    expect(ticketPublicUrl(token)).toBe(`https://tickets.example.test/t/${token}`);
    delete process.env.PUBLIC_APP_URL;
    expect(()=>ticketPublicUrl(token)).toThrow('PUBLIC_APP_URL is required');
    process.env.PUBLIC_APP_URL='http://localhost:3000';
    expect(()=>ticketPublicUrl(token)).toThrow('HTTPS origin');
  });
  it('keeps ticket tokens and hashes unchanged when the public origin changes',()=>{
    const item={id:'11111111-1111-4111-8111-111111111111',quantity:1};
    const before=ticketManifest([item])[0]!;
    process.env.PUBLIC_APP_URL='https://future.example.test';
    const after=ticketManifest([item])[0]!;
    expect(after).toEqual(before);
    expect(ticketPublicUrl(after.token)).toBe(`https://future.example.test/t/${after.token}`);
  });
  it('requires an order capability and never accepts order_id alone',()=>{
    expect(api).toContain('verifyPaymentStatusCapability(body.capability,body.order_id)');
    expect(api).toContain("typeof body.capability!=='string'");
  });
  it('keeps the public token page read-only and free of PII',()=>{
    expect(publicTicket).toContain("eq('secure_token_hash',hash)");
    expect(publicTicket).not.toMatch(/\.insert\(|check_ins|customer|email|phone|stripe/i);
    expect(publicTicket).not.toMatch(/db\.from\([^)]*\)\.update\(/i);
  });
});
