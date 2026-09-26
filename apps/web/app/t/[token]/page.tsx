import {createHash} from 'node:crypto';
import {createAdminClient} from '@programita/database/admin';
import {ticketPublicUrl} from '../../../lib/ticket-token';
import {TicketQr} from './ticket-qr';

export const dynamic='force-dynamic';

const ticketState={
  valid:{label:'VALID',className:'is-valid'},
  redeemed:{label:'UTILIZADA',className:'is-redeemed'},
  cancelled:{label:'ANULADA',className:'is-cancelled'},
  refunded:{label:'ANULADA',className:'is-cancelled'},
} as const;

export default async function TicketPage({params}:{params:Promise<{token:string}>}){
  const {token}=await params;
  if(!/^fst1_[A-Za-z0-9_-]{43}$/.test(token))return <TicketMissing/>;
  const db=createAdminClient();
  const hash=createHash('sha256').update(token).digest('hex');
  const ticketResult=await db.from('tickets').select('public_code,status,ticket_type_id,event_id').eq('secure_token_hash',hash).maybeSingle();
  if(ticketResult.error||!ticketResult.data)return <TicketMissing/>;
  const[typeResult,eventResult]=await Promise.all([
    db.from('ticket_types').select('name').eq('id',ticketResult.data.ticket_type_id).maybeSingle(),
    db.from('events').select('starts_at,timezone,location_id').eq('id',ticketResult.data.event_id).maybeSingle(),
  ]);
  if(typeResult.error||!typeResult.data||eventResult.error||!eventResult.data)return <TicketMissing/>;
  const locationResult=await db.from('locations').select('name').eq('id',eventResult.data.location_id).maybeSingle();
  const state=ticketState[ticketResult.data.status];
  const publicUrl=ticketPublicUrl(token);
  const eventDate=new Intl.DateTimeFormat('es-MX',{day:'numeric',month:'long',year:'numeric',timeZone:eventResult.data.timezone}).format(new Date(eventResult.data.starts_at)).toUpperCase();
  return <main className="public-ticket">
    <article className="public-ticket-card digital-ticket">
      <header className="digital-ticket-header">
        <p className="section-kicker">FEST-ON · 31.10.26</p>
        <h1>FIESTA DE<br/><span>DISFRACES</span></h1>
        <div className="digital-ticket-meta"><strong>{typeResult.data.name}</strong><span className={`ticket-status ${state.className}`}>{state.label}</span></div>
      </header>
      <TicketQr url={publicUrl}/>
      <code className="public-ticket-code">{ticketResult.data.public_code}</code>
      <div className="public-ticket-event"><strong>{eventDate}</strong><span>{locationResult.data?.name??'LA HACIENDA RIVIERA MAYA'}</span></div>
      <p className="public-ticket-instruction">MOSTRÁ ESTE QR AL INGRESAR</p>
    </article>
  </main>;
}

function TicketMissing(){return <main className="public-ticket"><div className="public-ticket-card public-ticket-missing"><p className="section-kicker">FEST-ON · 31.10.26</p><h1>ENTRADA NO<br/><span>DISPONIBLE</span></h1><p>Verificá el enlace o solicitá ayuda al equipo de acceso.</p></div></main>}
