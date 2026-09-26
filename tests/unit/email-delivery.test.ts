import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {sendOrderTicketsEmail} from '../../apps/web/lib/order-ticket-email';
import type {EmailProvider,EmailRequest} from '../../apps/web/lib/email-provider';

function fakeDb(claim:{status:string;delivery_id?:string;recipient?:string}={status:'claimed',delivery_id:'delivery-1',recipient:'buyer@example.test'}){
  const rows:Record<string,unknown[]>={
    orders:[{id:'order-1',customer_id:'customer-1',event_id:'event-1',status:'paid',created_at:'2026-01-01T00:00:00Z'}],
    order_items:[{id:'item-1',quantity:1,ticket_type_id:'type-1'},{id:'item-2',quantity:2,ticket_type_id:'type-2'}],
    tickets:[{id:'11111111-1111-4111-8111-111111111111',public_code:'TKT_11111111111111111111111111111111',status:'valid',order_item_id:'item-1',ticket_type_id:'type-1'},{id:'22222222-2222-4222-8222-222222222221',public_code:'TKT_22222222222222222222222222222221',status:'valid',order_item_id:'item-2',ticket_type_id:'type-2'},{id:'22222222-2222-4222-8222-222222222222',public_code:'TKT_22222222222222222222222222222222',status:'valid',order_item_id:'item-2',ticket_type_id:'type-2'}],
    customers:[{email:'buyer@example.test',full_name:'Buyer Test'}],events:[{name:'Fiesta de Disfraces',starts_at:'2026-10-31T23:59:00-05:00',timezone:'America/Cancun',location_id:'location-1'}],ticket_types:[{id:'type-1',name:'HOMBRES'},{id:'type-2',name:'MUJERES'}],locations:[{name:'La Hacienda Riviera Maya'}],
  };
  const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>({data:name==='claim_order_ticket_email_delivery_controlled'?claim:{status:args.p_success?'sent':'failed'},error:null}));
  type Builder={select:()=>Builder;eq:()=>Builder;maybeSingle:()=>Promise<unknown>;then:(resolve:(value:unknown)=>void)=>void};
  return {db:{from:(name:string)=>{const builder={} as Builder;builder.select=()=>builder;builder.eq=()=>builder;builder.maybeSingle=async()=>({data:rows[name]?.[0]??null,error:null});builder.then=resolve=>resolve({data:rows[name]??[],error:null});return builder},rpc},rpc};
}

describe('transactional email delivery foundation',()=>{
  beforeEach(()=>{process.env.EMAIL_FROM='Fest-On <tickets@example.test>';process.env.EMAIL_REPLY_TO='help@example.test';process.env.PUBLIC_APP_URL='https://tickets.example.test';process.env.TICKET_QR_SECRET='test-ticket-secret-that-is-long-enough-for-hmac'});
  afterEach(()=>vi.restoreAllMocks());
  it('loads the recipient from DB and persists the accepted provider message id',async()=>{
    const {db,rpc}=fakeDb();let request:EmailRequest|undefined;
    const provider:EmailProvider={send:async value=>{request=value;return {messageId:'message-1'}}};
    await expect(sendOrderTicketsEmail('org-1','order-1',undefined,{db:db as never,provider})).resolves.toMatchObject({status:'sent',deliveryId:'delivery-1'});
    expect(request?.to).toBe('buyer@example.test');
    expect(request?.idempotencyKey).toBe('tickets_initial:1:delivery-1');
    expect(request?.subject).toBe('Tus entradas para Fiesta de Disfraces están listas');
    expect(request?.html).toContain('TUS ENTRADAS');expect(request?.text).toContain('VER MIS ENTRADAS:');
    expect((request?.html.match(/VER ENTRADA</g)??[])).toHaveLength(3);expect(request?.html).toContain('1 HOMBRE · 2 MUJERES');
    expect(request?.html).toContain('https://tickets.example.test/entradas/');
    expect((request?.html.match(/https:\/\/tickets\.example\.test\/t\//g)??[])).toHaveLength(3);
    expect(`${request?.html}${request?.text}`).not.toContain('localhost');
    expect(rpc).toHaveBeenCalledWith('claim_order_ticket_email_delivery_controlled',expect.objectContaining({p_purpose:'tickets_initial',p_sequence:1}));
    expect(rpc).toHaveBeenLastCalledWith('finish_order_ticket_email_delivery_controlled',expect.objectContaining({p_success:true,p_provider_message_id:'message-1'}));
  });
  it('sanitizes provider failure and changes only the delivery record',async()=>{
    const {db,rpc}=fakeDb();const provider:EmailProvider={send:async()=>{throw new Error('private upstream detail')}};
    await expect(sendOrderTicketsEmail('org-1','order-1',undefined,{db:db as never,provider})).resolves.toMatchObject({status:'failed'});
    expect(rpc).toHaveBeenLastCalledWith('finish_order_ticket_email_delivery_controlled',expect.objectContaining({p_success:false,p_error_code:'provider_error'}));
  });
  it('uses a separate auditable identity for a manual resend while preserving the same tickets and public links',async()=>{
    const {db,rpc}=fakeDb();let request:EmailRequest|undefined;const provider:EmailProvider={send:async value=>{request=value;return {messageId:'message-manual-1'}}};
    await expect(sendOrderTicketsEmail('org-1','order-1',{purpose:'tickets_manual',sequence:1},{db:db as never,provider})).resolves.toMatchObject({status:'sent'});
    expect(rpc).toHaveBeenCalledWith('claim_order_ticket_email_delivery_controlled',expect.objectContaining({p_purpose:'tickets_manual',p_sequence:1}));
    expect(request?.idempotencyKey).toBe('tickets_manual:1:delivery-1');
    expect((request?.html.match(/https:\/\/tickets\.example\.test\/t\//g)??[])).toHaveLength(3);
    expect(request?.html).not.toContain('localhost');
  });
  it('does not call the provider when the same manual delivery is already sent',async()=>{
    const {db}=fakeDb({status:'already_sent',delivery_id:'delivery-1'});const provider:EmailProvider={send:vi.fn()};
    await expect(sendOrderTicketsEmail('org-1','order-1',{purpose:'tickets_manual',sequence:1},{db:db as never,provider})).resolves.toEqual({status:'already_sent'});
    expect(provider.send).not.toHaveBeenCalled();
  });
  it('has no browser recipient input and keeps Resend server-only',()=>{
    const service=readFileSync('apps/web/lib/order-ticket-email.ts','utf8');const provider=readFileSync('apps/web/lib/email-provider.ts','utf8');
    expect(service).toContain("select('email,full_name')");
    expect(service).not.toMatch(/recipient\s*:/);
    expect(provider.startsWith("import 'server-only';")).toBe(true);
    expect(provider).toContain('process.env.RESEND_API_KEY');
    expect(readFileSync('apps/web/app/fiesta-de-disfraces/tickets.tsx','utf8')).not.toContain('RESEND_API_KEY');
  });
});
