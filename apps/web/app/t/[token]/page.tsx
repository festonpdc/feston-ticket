import { createHash } from 'node:crypto';
import { createAdminClient } from '@programita/database/admin';

export const dynamic='force-dynamic';

export default async function TicketPage({params}:{params:Promise<{token:string}>}) {
  const {token}=await params;
  if(!/^fst1_[A-Za-z0-9_-]{43}$/.test(token))return <TicketMissing/>;
  const db=createAdminClient();
  const hash=createHash('sha256').update(token).digest('hex');
  const ticketResult=await db.from('tickets').select('public_code,status,ticket_type_id,event_id').eq('secure_token_hash',hash).maybeSingle();
  if(ticketResult.error||!ticketResult.data)return <TicketMissing/>;
  const [typeResult,eventResult]=await Promise.all([
    db.from('ticket_types').select('name').eq('id',ticketResult.data.ticket_type_id).maybeSingle(),
    db.from('events').select('name,starts_at,timezone,location_id').eq('id',ticketResult.data.event_id).maybeSingle(),
  ]);
  if(!typeResult.data||!eventResult.data)return <TicketMissing/>;
  const locationResult=await db.from('locations').select('name').eq('id',eventResult.data.location_id).maybeSingle();
  return <main className="public-ticket"><div className="public-ticket-card"><p className="section-kicker">FEST-ON</p><h1>FIESTA DE<br/><span>DISFRACES</span></h1><strong>{typeResult.data.name}</strong><p>{ticketResult.data.public_code}</p><p>{new Intl.DateTimeFormat('es-MX',{dateStyle:'long',timeZone:eventResult.data.timezone}).format(new Date(eventResult.data.starts_at))}</p><p>{locationResult.data?.name??'LA HACIENDA RIVIERA MAYA'}</p><span className="ticket-valid">{String(ticketResult.data.status).toUpperCase()}</span><small>Presentar este QR no registra el acceso automáticamente.</small></div></main>;
}
function TicketMissing(){return <main className="public-ticket"><div className="public-ticket-card"><p className="section-kicker">FEST-ON</p><h1>ENTRADA NO ENCONTRADA</h1><p>Verificá el enlace e intentá nuevamente.</p></div></main>}
