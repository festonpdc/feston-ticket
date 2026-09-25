import 'server-only';
import { createAdminClient } from '@programita/database/admin';
import { ResendEmailProvider,type EmailProvider } from './email-provider';
import { ticketPublicUrl,ticketToken } from './ticket-token';
import { emailTicketAccessUrl } from './email-ticket-access';
import { renderTicketEmail,ticketEmailSubject } from './ticket-email-template';

type DbLike=ReturnType<typeof createAdminClient>;
const safeCode=(error:unknown)=>error instanceof Error&&/^[a-z0-9_]{1,80}$/.test(error.message)?error.message:'provider_error';

export async function sendOrderTicketsEmail(organizationId:string,orderId:string,deps?:{db?:DbLike;provider?:EmailProvider}){
  const db=deps?.db??createAdminClient();
  const provider=deps?.provider??new ResendEmailProvider();
  const [orderResult,itemsResult,ticketsResult]=await Promise.all([
    db.from('orders').select('id,customer_id,event_id,status,created_at').eq('organization_id',organizationId).eq('id',orderId).maybeSingle(),
    db.from('order_items').select('id,quantity,ticket_type_id').eq('organization_id',organizationId).eq('order_id',orderId),
    db.from('tickets').select('id,public_code,status,order_item_id').eq('organization_id',organizationId).eq('order_id',orderId),
  ]);
  const order=orderResult.data;const items=itemsResult.data??[];const tickets=ticketsResult.data??[];
  if(orderResult.error||itemsResult.error||ticketsResult.error||!order||order.status!=='paid')return {status:'rejected',reason:'order_not_paid'} as const;
  const expected=items.reduce((sum,item)=>sum+Number(item.quantity),0);
  if(expected<1||tickets.length!==expected||tickets.some(ticket=>ticket.status!=='valid'))return {status:'rejected',reason:'tickets_incomplete'} as const;
  const [customerResult,eventResult,typesResult]=await Promise.all([
    db.from('customers').select('email,full_name').eq('organization_id',organizationId).eq('id',order.customer_id).maybeSingle(),
    db.from('events').select('name,starts_at,timezone,location_id').eq('organization_id',organizationId).eq('id',order.event_id).maybeSingle(),
    db.from('ticket_types').select('id,name').eq('organization_id',organizationId).eq('event_id',order.event_id),
  ]);
  if(customerResult.error||!customerResult.data)return {status:'rejected',reason:'customer_not_found'} as const;
  if(eventResult.error||!eventResult.data||typesResult.error)return {status:'rejected',reason:'event_not_found'} as const;
  const locationResult=await db.from('locations').select('name').eq('organization_id',organizationId).eq('id',eventResult.data.location_id).maybeSingle();
  if(locationResult.error||!locationResult.data)return {status:'rejected',reason:'event_not_found'} as const;
  const claim=await db.rpc('claim_order_ticket_email_delivery' as never,{p_organization_id:organizationId,p_order_id:orderId} as never);
  if(claim.error)throw new Error('delivery_claim_failed');
  const receipt=claim.data as {status:string;delivery_id?:string;recipient?:string};
  if(receipt.status!=='claimed')return {status:receipt.status} as const;
  if(!receipt.delivery_id||receipt.recipient!==customerResult.data.email.trim().toLowerCase())throw new Error('delivery_recipient_mismatch');
  const typeNames=new Map((typesResult.data??[]).map(type=>[type.id,type.name]));const itemMap=new Map(items.map(item=>[item.id,item]));
  const emailTickets=[...tickets].sort((a,b)=>a.order_item_id.localeCompare(b.order_item_id)||a.public_code.localeCompare(b.public_code)).map((ticket,index,all)=>{const item=itemMap.get(ticket.order_item_id);const siblings=all.filter(value=>value.order_item_id===ticket.order_item_id);return {type:typeNames.get(item?.ticket_type_id??'')??'ENTRADA',position:`Entrada ${siblings.findIndex(value=>value.id===ticket.id)+1} de ${item?.quantity??siblings.length}`,publicCode:ticket.public_code,url:ticketPublicUrl(ticketToken(ticket.id))}});
  const summary=items.map(item=>{const name=typeNames.get(item.ticket_type_id)??'ENTRADAS';const quantity=Number(item.quantity);return `${quantity} ${quantity===1?name.replace(/S$/,''):name}`});
  const createdAt=Date.parse(order.created_at);const accessUrl=emailTicketAccessUrl(organizationId,orderId,createdAt+365*24*60*60*1000);
  const rendered=renderTicketEmail({firstName:customerResult.data.full_name.trim().split(/\s+/)[0],eventName:eventResult.data.name,eventDate:new Intl.DateTimeFormat('es-MX',{day:'numeric',month:'long',year:'numeric',timeZone:eventResult.data.timezone}).format(new Date(eventResult.data.starts_at)).toUpperCase(),venue:locationResult.data.name,total:expected,summary,accessUrl,tickets:emailTickets});
  try{
    const sent=await provider.send({to:receipt.recipient,from:required('EMAIL_FROM'),replyTo:required('EMAIL_REPLY_TO'),subject:ticketEmailSubject,html:rendered.html,text:rendered.text,idempotencyKey:`tickets_initial:${receipt.delivery_id}`});
    const finish=await db.rpc('finish_order_ticket_email_delivery' as never,{p_delivery_id:receipt.delivery_id,p_success:true,p_provider_message_id:sent.messageId,p_error_code:null} as never);
    if(finish.error)throw new Error('delivery_finish_failed');
    return {status:'sent',deliveryId:receipt.delivery_id} as const;
  }catch(error){
    await db.rpc('finish_order_ticket_email_delivery' as never,{p_delivery_id:receipt.delivery_id,p_success:false,p_provider_message_id:null,p_error_code:safeCode(error)} as never);
    return {status:'failed',deliveryId:receipt.delivery_id} as const;
  }
}
function required(name:'EMAIL_FROM'|'EMAIL_REPLY_TO'){const value=process.env[name];if(!value)throw new Error(`${name.toLowerCase()}_missing`);return value}
