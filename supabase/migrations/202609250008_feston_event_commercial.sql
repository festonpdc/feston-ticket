-- Initial confirmed Fest-On commercial configuration. The technical end time is
-- provisional and intentionally documented here for later operational editing.
insert into public.organizations(id,name,slug)
values ('f3000000-0000-4000-8000-000000000001','Fest-On','fest-on')
on conflict (id) do nothing;
insert into public.locations(id,organization_id,name,slug,timezone)
values ('f3000000-0000-4000-8000-000000000002','f3000000-0000-4000-8000-000000000001','La Hacienda Riviera Maya','la-hacienda-riviera-maya','America/Cancun')
on conflict (id) do nothing;
insert into public.events(id,organization_id,location_id,name,slug,starts_at,ends_at,timezone,status,capacity)
values ('f3000000-0000-4000-8000-000000000003','f3000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000002','Fiesta de Disfraces Halloween 2026','fiesta-de-disfraces','2026-10-31 22:00:00-05','2026-11-01 06:00:00-05','America/Cancun','published',null)
on conflict (id) do update set starts_at=excluded.starts_at,timezone=excluded.timezone;
insert into public.ticket_types(id,organization_id,event_id,name,price,currency,capacity,status,sort_order)
values ('f3000000-0000-4000-8000-000000000004','f3000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000003','HOMBRES',50000,'MXN',null,'active',1),
       ('f3000000-0000-4000-8000-000000000005','f3000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000003','MUJERES',2000,'MXN',null,'active',2)
on conflict (id) do update set price=excluded.price,currency=excluded.currency,capacity=excluded.capacity,status=excluded.status;
comment on table public.events is 'The Fest-On event end time is provisional (06:00 local) pending operational confirmation.';
