import 'server-only';
import crypto from 'node:crypto';
import {publicAppUrl} from './public-app-url';

const secret = () => {
  const value=process.env.TICKET_QR_SECRET;
  if(!value || value.length<40) throw new Error('TICKET_QR_SECRET is required');
  return value;
};
const hmac=(value:string)=>crypto.createHmac('sha256',secret()).update(value).digest();
const hex=(value:string)=>hmac(value).toString('hex');

function deterministicUuid(value:string) {
  const bytes=Buffer.from(hmac(`ticket-id:${value}`).subarray(0,16));
  bytes[6]=(bytes[6]!&0x0f)|0x40;
  bytes[8]=(bytes[8]!&0x3f)|0x80;
  const encoded=bytes.toString('hex');
  return `${encoded.slice(0,8)}-${encoded.slice(8,12)}-${encoded.slice(12,16)}-${encoded.slice(16,20)}-${encoded.slice(20)}`;
}

export function ticketToken(ticketId:string) {
  return `fst1_${hmac(`ticket-token:${ticketId}`).toString('base64url')}`;
}
export function ticketTokenHash(token:string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
export function ticketManifest(items:Array<{id:string;quantity:number}>) {
  return items.flatMap(item=>Array.from({length:item.quantity},(_,offset)=>{
    const unitIndex=offset+1;
    const id=deterministicUuid(`${item.id}:${unitIndex}`);
    const token=ticketToken(id);
    return {
      id,
      order_item_id:item.id,
      unit_index:unitIndex,
      public_code:`TKT_${hex(`ticket-code:${id}`).slice(0,32)}`,
      secure_token_hash:ticketTokenHash(token),
      token,
    };
  }));
}

export function ticketPublicUrl(token:string) {
  return publicAppUrl(`/t/${encodeURIComponent(token)}`);
}
