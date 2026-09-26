import 'server-only';
import crypto from 'node:crypto';
import {publicAppUrl} from './public-app-url';

const key=()=>{const secret=process.env.TICKET_QR_SECRET;if(!secret||secret.length<40)throw new Error('TICKET_QR_SECRET is required');return crypto.createHash('sha256').update(`email-ticket-access:${secret}`).digest()};

export function issueEmailTicketAccess(organizationId:string,orderId:string,expiresAt=Date.now()+90*24*60*60*1000){
  const iv=crypto.createHmac('sha256',key()).update(`iv:${organizationId}:${orderId}:${expiresAt}`).digest().subarray(0,12);const cipher=crypto.createCipheriv('aes-256-gcm',key(),iv);
  const payload=Buffer.from(JSON.stringify({organizationId,orderId,expiresAt}));
  const encrypted=Buffer.concat([cipher.update(payload),cipher.final()]);
  return `fse1_${Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url')}`;
}
export function verifyEmailTicketAccess(token:string,now=Date.now()){
  if(!/^fse1_[A-Za-z0-9_-]{60,500}$/.test(token))return null;
  try{const raw=Buffer.from(token.slice(5),'base64url');const iv=raw.subarray(0,12),tag=raw.subarray(12,28),encrypted=raw.subarray(28);const decipher=crypto.createDecipheriv('aes-256-gcm',key(),iv);decipher.setAuthTag(tag);const data=JSON.parse(Buffer.concat([decipher.update(encrypted),decipher.final()]).toString()) as {organizationId?:unknown;orderId?:unknown;expiresAt?:unknown};if(typeof data.organizationId!=='string'||typeof data.orderId!=='string'||typeof data.expiresAt!=='number'||data.expiresAt<=now)return null;return {organizationId:data.organizationId,orderId:data.orderId,expiresAt:data.expiresAt}}catch{return null}
}
export function emailTicketAccessUrl(organizationId:string,orderId:string,expiresAt?:number){return publicAppUrl(`/entradas/${encodeURIComponent(issueEmailTicketAccess(organizationId,orderId,expiresAt))}`)}
