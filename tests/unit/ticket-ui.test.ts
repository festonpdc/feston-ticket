import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {ticketManifest,ticketPublicUrl} from '../../apps/web/lib/ticket-token';

const page=readFileSync('apps/web/app/t/[token]/page.tsx','utf8');
const qrSource=readFileSync('apps/web/app/t/[token]/ticket-qr.tsx','utf8');
const css=readFileSync('apps/web/app/globals.css','utf8');

describe('individual digital ticket',()=>{
  const previousSecret=process.env.TICKET_QR_SECRET,previousOrigin=process.env.PUBLIC_APP_URL;
  beforeEach(()=>{process.env.TICKET_QR_SECRET='test-ticket-secret-that-is-long-enough-for-hmac';process.env.PUBLIC_APP_URL='https://tickets.example.test'});
  afterEach(()=>{if(previousSecret===undefined)delete process.env.TICKET_QR_SECRET;else process.env.TICKET_QR_SECRET=previousSecret;if(previousOrigin===undefined)delete process.env.PUBLIC_APP_URL;else process.env.PUBLIC_APP_URL=previousOrigin});

  it('renders a high-contrast QR whose payload is the exact public ticket URL',()=>{
    const token=ticketManifest([{id:'11111111-1111-4111-8111-111111111111',quantity:1}])[0]!.token;
    const url=ticketPublicUrl(token);
    expect(url).toBe(`https://tickets.example.test/t/${token}`);
    expect(qrSource).toContain('value={url}');expect(qrSource).toContain('size={320}');expect(qrSource).toContain('level="M"');expect(qrSource).toContain('marginSize={4}');expect(qrSource).toContain('bgColor="#ffffff"');expect(qrSource).toContain('fgColor="#000000"');
  });
  it('produces three distinct safe QR payloads for three existing ticket identities',()=>{
    const tickets=ticketManifest([{id:'11111111-1111-4111-8111-111111111111',quantity:1},{id:'22222222-2222-4222-8222-222222222222',quantity:2}]);
    const payloads=tickets.map(ticket=>ticketPublicUrl(ticket.token));
    expect(new Set(payloads).size).toBe(3);
    for(const payload of payloads){expect(payload).toMatch(/^https:\/\/tickets\.example\.test\/t\/fst1_[A-Za-z0-9_-]{43}$/);expect(payload).not.toMatch(/@|pi_|payment|order|customer|11111111|22222222/i)}
  });
  it('maps only real ticket states and keeps invalid tokens non-disclosing',()=>{
    expect(page).toContain("valid:{label:'VALID'");expect(page).toContain("redeemed:{label:'UTILIZADA'");expect(page).toContain("cancelled:{label:'ANULADA'");expect(page).toContain("refunded:{label:'ANULADA'");
    expect(page).toContain('ENTRADA NO');expect(page).not.toMatch(/order_id|payment_id|stripe|customer|email|phone/i);
  });
  it('is read-only on every render and has mobile overflow protection',()=>{
    expect(page).not.toMatch(/db\.from\([^)]*\)\.(insert|update|delete)\(|check_ins|db\.rpc\(/i);
    expect(css).toContain('.public-ticket-qr{');expect(css).toContain('width:min(100%,20rem)');expect(css).toContain('overflow-wrap:anywhere');
  });
});
