import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
const {loadEnvConfig}=createRequire(import.meta.url)('@next/env') as typeof import('@next/env');

type Purpose='tickets_initial'|'tickets_manual';
type Options={organizationId:string;orderId:string;send:boolean;purpose:Purpose;sequence:number};
type Summary={organizationId:string;orderPublicCode:string;orderStatus:string;paymentStatus:string;ticketCount:number;ticketTypes:string[];destination:string;deliveryStatus:string;publicOrigin:string};
type Dependencies={inspect:(options:Options)=>Promise<Summary>;send:(options:Options)=>Promise<{status:string}>;log:(line:string)=>void};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseOperatorArgs(args:string[]):Options{
  let organizationId='',orderId='',send=false,purpose:Purpose='tickets_initial',sequence=1,seenOrganization=false,seenOrder=false,seenPurpose=false,seenSequence=false;
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg==='--send'){send=true;continue}
    if(arg==='--organization'){if(seenOrganization)throw new Error('Only one organization is allowed');seenOrganization=true;organizationId=args[++i]??'';continue}
    if(arg==='--order'){if(seenOrder)throw new Error('Only one order is allowed');seenOrder=true;orderId=args[++i]??'';continue}
    if(arg==='--purpose'){if(seenPurpose)throw new Error('Only one purpose is allowed');seenPurpose=true;const value=args[++i];if(value!=='tickets_initial'&&value!=='tickets_manual')throw new Error('Unsupported delivery purpose');purpose=value;continue}
    if(arg==='--sequence'){if(seenSequence)throw new Error('Only one sequence is allowed');seenSequence=true;sequence=Number(args[++i]);continue}
    throw new Error(`Unsupported argument: ${arg}`);
  }
  organizationId||=process.env.EMAIL_DELIVERY_ORGANIZATION_ID??'';orderId||=process.env.EMAIL_DELIVERY_ORDER_ID??'';
  if(!uuid.test(organizationId)||!uuid.test(orderId))throw new Error('Valid --organization and --order UUIDs are required');
  if(!Number.isSafeInteger(sequence)||sequence<1)throw new Error('Sequence must be a positive integer');
  if(purpose==='tickets_manual'&&!seenSequence)throw new Error('--sequence is required for tickets_manual');
  if(purpose==='tickets_initial'&&sequence!==1)throw new Error('tickets_initial only supports sequence 1');
  return {organizationId,orderId,send,purpose,sequence};
}
export function maskEmail(value:string){const [local,domain]=value.split('@');if(!local||!domain)return '***';return `${local.slice(0,1)}***@${domain}`}
export async function runOperatorCommand(args:string[],deps:Dependencies){
  const options=parseOperatorArgs(args),summary=await deps.inspect(options);
  for(const line of ['EMAIL DELIVERY — TEST ORDER',`Mode: ${options.send?'SEND':'DRY-RUN'}`,`Organization: ${summary.organizationId}`,`Order public reference: ${summary.orderPublicCode}`,`Order status: ${summary.orderStatus}`,`Payment status: ${summary.paymentStatus}`,`Ticket count: ${summary.ticketCount}`,`Ticket types: ${summary.ticketTypes.join(', ')}`,`Destination: ${maskEmail(summary.destination)}`,`Public origin: ${summary.publicOrigin}`,`Purpose: ${options.purpose}`,`Sequence: ${options.sequence}`,`Existing delivery status: ${summary.deliveryStatus}`])deps.log(line);
  if(!options.send){deps.log('Result: dry_run — Resend was not called.');return {status:'dry_run'} as const}
  const result=await deps.send(options);deps.log(`Result: ${result.status}`);return result;
}
async function inspect(options:Options):Promise<Summary>{
  const {organizationId,orderId,purpose,sequence}=options;
  const {createAdminClient}=await import('../packages/database/src/admin');
  const db=createAdminClient();const order=await db.from('orders').select('public_code,status,customer_id,event_id').eq('organization_id',organizationId).eq('id',orderId).maybeSingle();if(order.error||!order.data)throw new Error('Order not found');
  const[customer,payments,items,tickets,delivery]=await Promise.all([db.from('customers').select('email').eq('organization_id',organizationId).eq('id',order.data.customer_id).maybeSingle(),db.from('payments').select('status').eq('organization_id',organizationId).eq('order_id',orderId),db.from('order_items').select('ticket_type_id,quantity').eq('organization_id',organizationId).eq('order_id',orderId),db.from('tickets').select('id').eq('organization_id',organizationId).eq('order_id',orderId),db.from('deliveries' as never).select('status').eq('organization_id',organizationId).eq('order_id',orderId).eq('channel','email').eq('purpose',purpose).eq('sequence',sequence).maybeSingle()]);
  if(customer.error||!customer.data||payments.error||items.error||tickets.error||delivery.error)throw new Error('Order summary unavailable');const types=await db.from('ticket_types').select('id,name').eq('organization_id',organizationId).eq('event_id',order.data.event_id);if(types.error)throw new Error('Order summary unavailable');const names=new Map((types.data??[]).map(type=>[type.id,type.name]));
  const configured=process.env.PUBLIC_APP_URL;if(!configured)throw new Error('PUBLIC_APP_URL is required');const publicOrigin=new URL(configured).origin;
  return {organizationId,orderPublicCode:order.data.public_code,orderStatus:order.data.status,paymentStatus:[...new Set((payments.data??[]).map(payment=>payment.status))].join(','),ticketCount:tickets.data?.length??0,ticketTypes:(items.data??[]).map(item=>`${item.quantity} ${names.get(item.ticket_type_id)??'ENTRADA'}`),destination:customer.data.email,deliveryStatus:(delivery.data as {status?:string}|null)?.status??'none',publicOrigin};
}
const requiredEnvironment=['NEXT_PUBLIC_SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','RESEND_API_KEY','EMAIL_FROM','EMAIL_REPLY_TO','PUBLIC_APP_URL','TICKET_QR_SECRET'] as const;
export function loadWebEnvironment(directory=resolve(process.cwd(),'apps/web')){loadEnvConfig(directory,true,{info:()=>{},error:()=>{}},true);const missing=requiredEnvironment.filter(name=>!process.env[name]);if(missing.length)throw new Error(`Missing required web environment: ${missing.join(', ')}`);return {present:requiredEnvironment.length}}
async function main(){loadWebEnvironment();if(!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'))throw new Error('Operator command is restricted to the current Stripe TEST environment');const {sendOrderTicketsEmail}=await import('../apps/web/lib/order-ticket-email');await runOperatorCommand(process.argv.slice(2),{inspect,send:options=>sendOrderTicketsEmail(options.organizationId,options.orderId,{purpose:options.purpose,sequence:options.sequence}),log:console.log})}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)main().catch(error=>{console.error(error instanceof Error?error.message:'Operator command failed');process.exitCode=1});
