-- LOCAL DEMO ONLY. Prices, capacities, currency, time and timezone are UNCONFIRMED.
-- UTC is a placeholder, not an assertion about the venue's real timezone.
insert into public.organizations(id,name,slug)
values ('d0000000-0000-4000-8000-000000000001','Grupo Santino','grupo-santino-demo') on conflict do nothing;
insert into public.locations(id,organization_id,name,slug,timezone)
values ('d1000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001','La Hacienda','la-hacienda-demo','UTC') on conflict do nothing;
insert into public.events(id,organization_id,location_id,name,slug,description,starts_at,ends_at,timezone,status,capacity)
values ('d2000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001',
  'Fiesta de Disfraces 2026','fiesta-de-disfraces-2026-demo',
  'DEMO: horario, zona horaria, moneda, precios y capacidades sin confirmar por el cliente.',
  '2026-10-31 21:00:00+00','2026-11-01 05:00:00+00','UTC','draft',1000) on conflict do nothing;
insert into public.ticket_types(id,organization_id,event_id,name,description,price,currency,capacity,sort_order)
values
 ('d3000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','Early Access','DEMO: importe/capacidad/moneda sin confirmar',100000,'ARS',200,0),
 ('d3000000-0000-4000-8000-000000000002','d0000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','General','DEMO: importe/capacidad/moneda sin confirmar',150000,'ARS',600,1),
 ('d3000000-0000-4000-8000-000000000003','d0000000-0000-4000-8000-000000000001','d2000000-0000-4000-8000-000000000001','VIP','DEMO: importe/capacidad/moneda sin confirmar',250000,'ARS',200,2)
on conflict do nothing;
