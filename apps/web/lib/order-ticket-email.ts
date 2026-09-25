import 'server-only';
import { createAdminClient } from '@programita/database/admin';
import { ResendEmailProvider,type EmailProvider } from './email-provider';
import { ticketPublicUrl,ticketToken } from './ticket-token';

type DbLike=ReturnType<typeof createAdminClient>;
const safeCode=(error:unknown)=>error instanceof Error&&/^[a-z0-9_]{1,80}$/.test(error.message)?error.message:'provider_error';
const esc=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));

export async function sendOrderTicketsEmail(organizationId:string,orderId:string,deps?:{db?:DbLike;provider?:EmailProvider}){
  const db=deps?.db??createAdminClient();
  const provider=deps?.provider??new ResendEmailProvider();
  const [orderResult,itemsResult,ticketsResult]=await Promise.all([
    db.from('orders').select('id,customer_id,status').eq('organization_id',organizationId).eq('id',orderId).maybeSingle(),
    db.from('order_items').select('id,quantity').eq('organization_id',organizationId).eq('order_id',orderId),
    db.from('tickets').select('id,public_code,status,order_item_id').eq('organization_id',organizationId).eq('order_id',orderId),
  ]);
  const order=orderResult.data;const items=itemsResult.data??[];const tickets=ticketsResult.data??[];
  if(orderResult.error||itemsResult.error||ticketsResult.error||!order||order.status!=='paid')return {status:'rejected',reason:'order_not_paid'} as const;
  const expected=items.reduce((sum,item)=>sum+Number(item.quantity),0);
  if(expected<1||tickets.length!==expected||tickets.some(ticket=>ticket.status!=='valid'))return {status:'rejected',reason:'tickets_incomplete'} as const;
  const customerResult=await db.from('customers').select('email').eq('organization_id',organizationId).eq('id',order.customer_id).maybeSingle();
  if(customerResult.error||!customerResult.data)return {status:'rejected',reason:'customer_not_found'} as const;
  const claim=await db.rpc('claim_order_ticket_email_delivery' as never,{p_organization_id:organizationId,p_order_id:orderId} as never);
  if(claim.error)throw new Error('delivery_claim_failed');
  const receipt=claim.data as {status:string;delivery_id?:string;recipient?:string};
  if(receipt.status!=='claimed')return {status:receipt.status} as const;
  if(!receipt.delivery_id||receipt.recipient!==customerResult.data.email.trim().toLowerCase())throw new Error('delivery_recipient_mismatch');
  const links=tickets.map(ticket=>`<li>${esc(ticket.public_code)} — <a href="${esc(ticketPublicUrl(ticketToken(ticket.id)))}">VER ENTRADA</a></li>`).join('');
  try{
    const sent=await provider.send({to:receipt.recipient,from:required('EMAIL_FROM'),replyTo:required('EMAIL_REPLY_TO'),subject:'Tus entradas Fest-On están listas',html:`<h1>TUS ENTRADAS ESTÁN LISTAS</h1><ul>${links}</ul>`,idempotencyKey:`tickets_initial:${receipt.delivery_id}`});
    const finish=await db.rpc('finish_order_ticket_email_delivery' as never,{p_delivery_id:receipt.delivery_id,p_success:true,p_provider_message_id:sent.messageId,p_error_code:null} as never);
    if(finish.error)throw new Error('delivery_finish_failed');
    return {status:'sent',deliveryId:receipt.delivery_id} as const;
  }catch(error){
    await db.rpc('finish_order_ticket_email_delivery' as never,{p_delivery_id:receipt.delivery_id,p_success:false,p_provider_message_id:null,p_error_code:safeCode(error)} as never);
    return {status:'failed',deliveryId:receipt.delivery_id} as const;
  }
}
function required(name:'EMAIL_FROM'|'EMAIL_REPLY_TO'){const value=process.env[name];if(!value)throw new Error(`${name.toLowerCase()}_missing`);return value}
