import 'server-only';
import { Resend } from 'resend';

export type EmailRequest={to:string;from:string;replyTo:string;subject:string;html:string;text:string;idempotencyKey:string};
export interface EmailProvider{send(request:EmailRequest):Promise<{messageId:string}>}

export class ResendEmailProvider implements EmailProvider{
  private readonly client:Resend;
  constructor(apiKey=process.env.RESEND_API_KEY){if(!apiKey)throw new Error('RESEND_API_KEY is required');this.client=new Resend(apiKey)}
  async send(request:EmailRequest){
    const {data,error}=await this.client.emails.send({from:request.from,to:request.to,replyTo:request.replyTo,subject:request.subject,html:request.html,text:request.text},{idempotencyKey:request.idempotencyKey});
    if(error||!data?.id)throw new Error('resend_rejected');
    return {messageId:data.id};
  }
}
