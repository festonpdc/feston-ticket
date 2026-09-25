import Image from 'next/image';
import { supabaseServer } from '../../lib/supabase';
import { ticketAvailability } from '@programita/database/inventory';
import { TicketsSection, type TicketAvailability } from './tickets';

export default async function FiestaDeDisfracesPage() {
  let tickets: TicketAvailability[] = []; let availabilityError = false;
  const org = process.env.FESTON_ORGANIZATION_ID ?? 'f3000000-0000-4000-8000-000000000001'; const event = process.env.FESTON_EVENT_ID ?? 'f3000000-0000-4000-8000-000000000003';
  if (org && event) { try { tickets = (await ticketAvailability(await supabaseServer(), org, event) as TicketAvailability[]) ?? []; } catch { availabilityError = true; } }
  return <main className="event-page">
    <section className="hero" aria-labelledby="event-title">
      <div className="nav">
        <a className="wordmark" href="/fiesta-de-disfraces" aria-label="Fest-On inicio"><Image src="/events/fiesta-de-disfraces/logo-feston-web.png" alt="Fest-On" width={126} height={42} priority /></a>
        <nav className="navlinks" aria-label="Navegación principal"><a href="#evento">EVENTO</a><a href="#lineup">LINE UP</a><a href="#entradas">ENTRADAS</a><a className="nav-cta" href="#entradas">COMPRAR</a></nav>
      </div>
      <div className="hero-content" id="evento"><p className="eyebrow">FEST-ON PRESENTA</p><h1 id="event-title"><span>Fiesta de</span><span className="red">Disfraces</span><span>Halloween</span></h1><div className="date-block"><p className="date">SÁBADO 31 OCTUBRE 2026</p><p className="venue">LA HACIENDA<br/>RIVIERA MAYA</p></div><div className="actions"><a className="primary-cta" href="#entradas">COMPRAR ENTRADAS <span aria-hidden="true">→</span></a><span className="scroll-note">entra al universo ↓</span></div></div>
      <div className="flyer-wrap" aria-label="Flyer oficial de Fiesta de Disfraces Halloween"><Image className="flyer" src="/events/fiesta-de-disfraces/flyer-oficial.jpeg" alt="Flyer oficial de Fiesta de Disfraces Halloween" width={1080} height={1536} priority sizes="(max-width: 640px) 100vw, 48vw" /></div>
    </section>
    <section className="lineup" id="lineup" aria-labelledby="lineup-title"><p className="section-kicker">FEST-ON · EXPERIENCIA</p><h2 id="lineup-title">LINE UP</h2><div className="lineup-universe"><p className="universe-label">ELECTRÓNICA EN LA SELVA</p><h3>CHAPA <em>&amp;</em> CASTELO</h3><p className="artist-row">GALGO <b>✦</b> JAY PERLESTEIN <b>✦</b> DA CARBONE <b>✦</b> ABT <b>✦</b> BERNI</p></div><div className="lineup-divider" aria-hidden="true">✦</div><div className="lineup-universe second"><p className="universe-label">REGGAETON FRENTE A LA IGLESIA</p><p className="artist-row major">GABRIEL BARRIENTOS <b>✦</b> NES CORTEZ</p></div></section>
    <section className="closing-line" aria-label="Entrada a tickets">DOS UNIVERSOS · UNA SOLA NOCHE · 31.10.26</section><TicketsSection tickets={tickets} error={availabilityError}/><footer className="site-footer"><strong>FEST-ON © 2026</strong><span>Ticketing &amp; technology by Programita</span></footer>
  </main>;
}

