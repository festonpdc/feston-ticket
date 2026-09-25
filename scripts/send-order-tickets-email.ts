import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
const {loadEnvConfig}=createRequire(import.meta.url)('@next/env') as typeof import('@next/env');

type Options={organizationId:string;orderId:string;send:boolean};
type Summary={organizationId:string;orderPublicCode:string;orderStatus:string;paymentStatus:string;ticketCount:number;ticketTypes:string[];destination:string;deliveryStatus:string};
type Dependencies={inspect:(organizationId:string,orderId:string)=>Promise<Summary>;send:(organizationId:string,orderId:string)=>Promise<{status:string}>;log:(line:string)=>void};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseOperatorArgs(args:string[]):Options{
  let organizationId='',orderId='',send=false,seenOrganization=false,seenOrder=false;
  for(let i=0;i<args.length;i++){const arg=args[i];if(arg==='--send'){send=true;continue}if(arg==='--organization'){if(seenOrganization)throw new Error('Only one organization is allowed');seenOrganization=true;organizationId=args[++i]??'';continue}if(arg==='--order'){if(seenOrder)throw new Error('Only one order is allowed');seenOrder=true;orderId=args[++i]??'';continue}throw new Error(`Unsupported argument: ${arg}`)}
  organizationId||=process.env.EMAIL_DELIVERY_ORGANIZATION_ID??'';orderId||=process.env.EMAIL_DELIVERY_ORDER_ID??'';
  if(!uuid.test(organizationId)||!uuid.test(orderId))throw new Error('Valid --organization and --order UUIDs are required');
  return {organizationId,orderId,send};
}
export function maskEmail(value:string){const [local,domain]=value.split('@');if(!local||!domain)return '***';return `${local.slice(0,1)}***@${domain}`}
export async function runOperatorCommand(args:string[],deps:Dependencies){
  const options=parseOperatorArgs(args),summary=await deps.inspect(options.organizationId,options.orderId);
  for(const line of ['EMAIL DELIVERY — TEST ORDER',`Mode: ${options.send?'SEND':'DRY-RUN'}`,`Organization: ${summary.organizationId}`,`Order public reference: ${summary.orderPublicCode}`,`Order status: ${summary.orderStatus}`,`Payment status: ${summary.paymentStatus}`,`Ticket count: ${summary.ticketCount}`,`Ticket types: ${summary.ticketTypes.join(', ')}`,`Destination: ${maskEmail(summary.destination)}`,`Existing delivery status: ${summary.deliveryStatus}`])deps.log(line);
  if(!options.send){deps.log('Result: dry_run — Resend was not called.');return {status:'dry_run'} as const}
  const result=await deps.send(options.organizationId,options.orderId);deps.log(`Result: ${result.status}`);return result;
}
async function inspect(organizationId:string,orderId:string):Promise<Summary>{
  const {createAdminClient}=await import('../packages/database/src/admin');
  const db=createAdminClient();const order=await db.from('orders').select('public_code,status,customer_id,event_id').eq('organization_id',organizationId).eq('id',orderId).maybeSingle();if(order.error||!order.data)throw new Error('Order not found');
  const[customer,payments,items,tickets,delivery]=await Promise.all([db.from('customers').select('email').eq('organization_id',organizationId).eq('id',order.data.customer_id).maybeSingle(),db.from('payments').select('status').eq('organization_id',organizationId).eq('order_id',orderId),db.from('order_items').select('ticket_type_id,quantity').eq('organization_id',organizationId).eq('order_id',orderId),db.from('tickets').select('id').eq('organization_id',organizationId).eq('order_id',orderId),db.from('deliveries' as never).select('status').eq('organization_id',organizationId).eq('order_id',orderId).eq('channel','email').eq('purpose','tickets_initial').eq('sequence',1).maybeSingle()]);
  if(customer.error||!customer.data||payments.error||items.error||tickets.error)throw new Error('Order summary unavailable');const types=await db.from('ticket_types').select('id,name').eq('organization_id',organizationId).eq('event_id',order.data.event_id);if(types.error)throw new Error('Order summary unavailable');const names=new Map((types.data??[]).map(type=>[type.id,type.name]));
  return {organizationId,orderPublicCode:order.data.public_code,orderStatus:order.data.status,paymentStatus:[...new Set((payments.data??[]).map(payment=>payment.status))].join(','),ticketCount:tickets.data?.length??0,ticketTypes:(items.data??[]).map(item=>`${item.quantity} ${names.get(item.ticket_type_id)??'ENTRADA'}`),destination:customer.data.email,deliveryStatus:(delivery.data as {status?:string}|null)?.status??'none'};
}
const requiredEnvironment=['NEXT_PUBLIC_SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','RESEND_API_KEY','EMAIL_FROM','EMAIL_REPLY_TO','APP_URL','TICKET_QR_SECRET'] as const;
export function loadWebEnvironment(directory=resolve(process.cwd(),'apps/web')){loadEnvConfig(directory,true,{info:()=>{},error:()=>{}},true);const missing=requiredEnvironment.filter(name=>!process.env[name]);if(missing.length)throw new Error(`Missing required web environment: ${missing.join(', ')}`);return {present:requiredEnvironment.length}}
async function main(){loadWebEnvironment();if(!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'))throw new Error('Operator command is restricted to the current Stripe TEST environment');const {sendOrderTicketsEmail}=await import('../apps/web/lib/order-ticket-email');await runOperatorCommand(process.argv.slice(2),{inspect,send:sendOrderTicketsEmail,log:console.log})}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)main().catch(error=>{console.error(error instanceof Error?error.message:'Operator command failed');process.exitCode=1});
