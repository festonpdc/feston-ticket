insert into auth.users(id) values
 ('00000000-0000-4000-8000-000000000001'),
 ('00000000-0000-4000-8000-000000000002'),
 ('00000000-0000-4000-8000-000000000003'),
 ('00000000-0000-4000-8000-000000000004'),
 ('00000000-0000-4000-8000-000000000005');
insert into public.organizations(id,name,slug) values
 ('10000000-0000-4000-8000-000000000001','Test A','test-org-a'),
 ('10000000-0000-4000-8000-000000000002','Test B','test-org-b');
insert into public.organization_members(organization_id,user_id,role) values
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','owner'),
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','manager'),
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','door'),
 ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000004','owner');
insert into public.locations(id,organization_id,name,slug,timezone)
 select ('20000000-0000-4000-8000-00000000000' || n)::uuid,
 ('10000000-0000-4000-8000-00000000000' || n)::uuid, 'Test venue', 'test-venue', 'UTC'
 from generate_series(1,2) n;
insert into public.events(id,organization_id,location_id,name,slug,starts_at,ends_at,timezone)
 select ('30000000-0000-4000-8000-00000000000' || n)::uuid,
 ('10000000-0000-4000-8000-00000000000' || n)::uuid,
 ('20000000-0000-4000-8000-00000000000' || n)::uuid,
 'Test event', 'test-event', '2026-10-31 20:00Z','2026-11-01 05:00Z','UTC' from generate_series(1,2) n;
insert into public.ticket_types(id,organization_id,event_id,name,price,currency,capacity)
 select ('40000000-0000-4000-8000-00000000000' || n)::uuid,
 ('10000000-0000-4000-8000-00000000000' || n)::uuid,
 ('30000000-0000-4000-8000-00000000000' || n)::uuid,
 'General', 1500, 'USD', 100 from generate_series(1,2) n;
insert into public.customers(id,organization_id,full_name,email)
 select ('50000000-0000-4000-8000-00000000000' || n)::uuid,
 ('10000000-0000-4000-8000-00000000000' || n)::uuid,
 'Test customer', 'fixture@example.invalid' from generate_series(1,2) n;
insert into public.orders(id,organization_id,event_id,customer_id,public_code,currency,subtotal,total)
 select ('60000000-0000-4000-8000-00000000000' || n)::uuid,
 ('10000000-0000-4000-8000-00000000000' || n)::uuid,
 ('30000000-0000-4000-8000-00000000000' || n)::uuid,
 ('50000000-0000-4000-8000-00000000000' || n)::uuid,
 'ORD_' || lpad(n::text,32,'0'), 'USD',1500,1500 from generate_series(1,2) n;
insert into public.order_items(id,organization_id,order_id,event_id,ticket_type_id,currency,quantity,unit_price,subtotal)
 select ('70000000-0000-4000-8000-00000000000' || n)::uuid,
 ('10000000-0000-4000-8000-00000000000' || n)::uuid,
 ('60000000-0000-4000-8000-00000000000' || n)::uuid,
 ('30000000-0000-4000-8000-00000000000' || n)::uuid,
 ('40000000-0000-4000-8000-00000000000' || n)::uuid,
 'USD',1,1500,1500 from generate_series(1,2) n;
update public.orders set status='pending_payment', reserved_until=now()+interval '15 minutes' where organization_id in ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002');
update public.orders set status='paid' where organization_id in ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002');
insert into public.payments(organization_id,order_id,provider,amount,currency,status)
 select organization_id,id,'demo',1500,'USD','approved' from public.orders where organization_id in ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002');
insert into public.tickets(id,organization_id,event_id,order_id,order_item_id,ticket_type_id,unit_index,public_code,secure_token_hash)
 select ('80000000-0000-4000-8000-00000000000' || n)::uuid,
 ('10000000-0000-4000-8000-00000000000' || n)::uuid,
 ('30000000-0000-4000-8000-00000000000' || n)::uuid,
 ('60000000-0000-4000-8000-00000000000' || n)::uuid,
 ('70000000-0000-4000-8000-00000000000' || n)::uuid,
 ('40000000-0000-4000-8000-00000000000' || n)::uuid, 1,
 'TKT_' || lpad(n::text,32,'0'), lpad(n::text,64,'0') from generate_series(1,2) n;
insert into public.audit_logs(organization_id,event_type,entity_type,entity_id)
 select organization_id,'order_created','order',id from public.orders where organization_id in ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002');
set constraints all immediate;
