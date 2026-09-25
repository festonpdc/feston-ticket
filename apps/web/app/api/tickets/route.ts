import { NextResponse } from 'next/server';
import { createAdminClient } from '@programita/database/admin';
import { verifyPaymentStatusCapability } from '../../../lib/payment-capability';
import { ticketManifest, ticketPublicUrl } from '../../../lib/ticket-token';

export const runtime='nodejs';
const fail=(status=400)=>NextResponse.json({error:'No pudimos cargar tus entradas'},{status});

export async function POST(request:Request) {
  try {
    if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return fail(415);
    const body=await request.json() as {order_id?:unknown;capability?:unknown};
    if(typeof body.order_id!=='string'||typeof body.capability!=='string'
      ||!verifyPaymentStatusCapability(body.capability,body.order_id))return fail(403);
    const db=createAdminClient();
    const orderResult=await db.from('orders').select('id,organization_id,event_id,status').eq('id',body.order_id).maybeSingle();
    if(orderResult.error||!orderResult.data||orderResult.data.status!=='paid')return fail(404);
    const itemsResult=await db.from('order_items').select('id,quantity').eq('organization_id',orderResult.data.organization_id).eq('order_id',orderResult.data.id);
    if(itemsResult.error||!itemsResult.data?.length)return fail(500);
    const manifest=ticketManifest(itemsResult.data.map(item=>({id:item.id,quantity:Number(item.quantity)})));
    const result=await db.rpc('issue_tickets_for_paid_order' as never,{
      p_organization_id:orderResult.data.organization_id,
      p_order_id:orderResult.data.id,
      p_manifest:manifest.map(ticket=>({
        id:ticket.id,
        order_item_id:ticket.order_item_id,
        unit_index:ticket.unit_index,
        public_code:ticket.public_code,
        secure_token_hash:ticket.secure_token_hash,
      })),
    } as never);
    if(result.error)return fail(500);
    const issued=result.data as {status?:string;quantity?:number;tickets?:Array<Record<string,unknown>>}|null;
    if(issued?.status!=='issued'||!Array.isArray(issued.tickets))return fail(409);
    const tokens=new Map(manifest.map(ticket=>[ticket.id,ticket.token]));
    const tickets=issued.tickets.map(ticket=>{
      const id=String(ticket.id);
      const token=tokens.get(id);
      if(!token||ticket.secure_token_hash!==manifest.find(item=>item.id===id)?.secure_token_hash)throw new Error('ticket_manifest_mismatch');
      return {
        public_code:ticket.public_code,
        ticket_type_name:ticket.ticket_type_name,
        unit_index:ticket.unit_index,
        item_quantity:ticket.item_quantity,
        status:ticket.status,
        qr_url:ticketPublicUrl(token),
      };
    });
    return NextResponse.json({quantity:issued.quantity,tickets});
  } catch {
    return fail(500);
  }
}
