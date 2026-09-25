import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {sendOrderTicketsEmail} from '../../apps/web/lib/order-ticket-email';
import type {EmailProvider,EmailRequest} from '../../apps/web/lib/email-provider';

function fakeDb(claim:{status:string;delivery_id?:string;recipient?:string}={status:'claimed',delivery_id:'delivery-1',recipient:'buyer@example.test'}){
  const rows:Record<string,unknown[]>={
    orders:[{id:'order-1',customer_id:'customer-1',status:'paid'}],
    order_items:[{id:'item-1',quantity:1}],
    tickets:[{id:'11111111-1111-4111-8111-111111111111',public_code:'TKT_11111111111111111111111111111111',status:'valid',order_item_id:'item-1',unit_index:1}],
    customers:[{email:'buyer@example.test'}],
  };
  const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>({data:name==='claim_order_ticket_email_delivery'?claim:{status:args.p_success?'sent':'failed'},error:null}));
  type Builder={select:()=>Builder;eq:()=>Builder;maybeSingle:()=>Promise<unknown>;then:(resolve:(value:unknown)=>void)=>void};
  return {db:{from:(name:string)=>{const builder={} as Builder;builder.select=()=>builder;builder.eq=()=>builder;builder.maybeSingle=async()=>({data:rows[name]?.[0]??null,error:null});builder.then=resolve=>resolve({data:rows[name]??[],error:null});return builder},rpc},rpc};
}

describe('transactional email delivery foundation',()=>{
  beforeEach(()=>{process.env.EMAIL_FROM='Fest-On <tickets@example.test>';process.env.EMAIL_REPLY_TO='help@example.test';process.env.APP_URL='https://tickets.example.test';process.env.TICKET_QR_SECRET='test-ticket-secret-that-is-long-enough-for-hmac'});
  afterEach(()=>vi.restoreAllMocks());
  it('loads the recipient from DB and persists the accepted provider message id',async()=>{
    const {db,rpc}=fakeDb();let request:EmailRequest|undefined;
    const provider:EmailProvider={send:async value=>{request=value;return {messageId:'message-1'}}};
    await expect(sendOrderTicketsEmail('org-1','order-1',{db:db as never,provider})).resolves.toMatchObject({status:'sent',deliveryId:'delivery-1'});
    expect(request?.to).toBe('buyer@example.test');
    expect(request?.idempotencyKey).toBe('tickets_initial:delivery-1');
    expect(rpc).toHaveBeenLastCalledWith('finish_order_ticket_email_delivery',expect.objectContaining({p_success:true,p_provider_message_id:'message-1'}));
  });
  it('sanitizes provider failure and changes only the delivery record',async()=>{
    const {db,rpc}=fakeDb();const provider:EmailProvider={send:async()=>{throw new Error('private upstream detail')}};
    await expect(sendOrderTicketsEmail('org-1','order-1',{db:db as never,provider})).resolves.toMatchObject({status:'failed'});
    expect(rpc).toHaveBeenLastCalledWith('finish_order_ticket_email_delivery',expect.objectContaining({p_success:false,p_error_code:'provider_error'}));
  });
  it('has no browser recipient input and keeps Resend server-only',()=>{
    const service=readFileSync('apps/web/lib/order-ticket-email.ts','utf8');const provider=readFileSync('apps/web/lib/email-provider.ts','utf8');
    expect(service).toContain("select('email')");
    expect(service).not.toMatch(/recipient\s*:/);
    expect(provider.startsWith("import 'server-only';")).toBe(true);
    expect(provider).toContain('process.env.RESEND_API_KEY');
    expect(readFileSync('apps/web/app/fiesta-de-disfraces/tickets.tsx','utf8')).not.toContain('RESEND_API_KEY');
  });
});
