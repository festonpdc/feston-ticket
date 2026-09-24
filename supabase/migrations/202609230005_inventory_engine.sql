create table private.inventory_settings (
  singleton boolean primary key default true check (singleton),
  online_reservation_seconds integer not null default 900 check (online_reservation_seconds between 60 and 3600),
  max_tickets_per_order integer not null default 10 check (max_tickets_per_order between 1 and 100)
);
insert into private.inventory_settings default values;
revoke all on private.inventory_settings from public, anon, authenticated, service_role;
alter table private.inventory_settings enable row level security;
alter table private.inventory_settings force row level security;

-- Complimentary is reserved for a later authorized command; no fake payment.
alter table public.orders add column order_kind text not null default 'standard'
  check (order_kind in ('standard', 'complimentary'));
alter table public.orders add constraint complimentary_zero_total
  check (order_kind <> 'complimentary' or (subtotal = 0 and total = 0));
create index orders_pending_expiry_idx on public.orders(reserved_until, event_id)
  where status = 'pending_payment';

-- RC is essential: queries AFTER acquiring the event lock must see prior commits.
create function private.lock_inventory_event(org uuid, event uuid) returns void
language plpgsql volatile set search_path = '' as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Inventory commands require READ COMMITTED' using errcode = '25001';
  end if;
  perform 1 from public.events where id = event and organization_id = org for update;
  if not found then raise exception 'Invalid event context' using errcode = '22023'; end if;
end;
$$;

create function private.inventory_counts(org uuid, event uuid, at_time timestamptz)
returns table(ticket_type_id uuid, sold bigint, reserved bigint)
language sql stable set search_path = '' as $$
  select i.ticket_type_id,
    coalesce(sum(i.quantity) filter (where o.status in ('paid','refunded')),0)::bigint,
    coalesce(sum(i.quantity) filter (where o.status = 'pending_payment' and o.reserved_until > at_time),0)::bigint
  from public.order_items i join public.orders o on o.id=i.order_id and o.organization_id=i.organization_id
  where o.organization_id=org and o.event_id=event
  group by i.ticket_type_id;
$$;

create function private.assert_inventory(org uuid, event uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare at_time timestamptz := clock_timestamp(); cap integer; used bigint;
begin
  select capacity into cap from public.events where id=event and organization_id=org;
  select coalesce(sum(c.sold+c.reserved),0) into used from private.inventory_counts(org,event,at_time) c;
  if cap is not null and used > cap then
    raise exception 'Insufficient event inventory' using errcode = '23514';
  end if;
  if exists (select 1 from public.ticket_types t join private.inventory_counts(org,event,at_time) c on c.ticket_type_id=t.id
    where t.organization_id=org and t.event_id=event and c.sold+c.reserved > t.capacity) then
    raise exception 'Insufficient ticket inventory' using errcode = '23514';
  end if;
end;
$$;

create function private.guard_inventory_order() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.order_kind <> old.order_kind then raise exception 'Order kind is immutable' using errcode='23514'; end if;
  if new.status is distinct from old.status then
    perform private.lock_inventory_event(new.organization_id,new.event_id);
    if old.status='pending_payment' and new.status='paid' and old.reserved_until <= clock_timestamp() then
      raise exception 'Reservation has expired' using errcode='23514';
    end if;
    if new.order_kind='complimentary' and new.status='pending_payment' then
      raise exception 'Complimentary issuance is not implemented' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger inventory_order_guard before update on public.orders
  for each row execute function private.guard_inventory_order();
create function private.check_inventory_order() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then perform private.assert_inventory(new.organization_id,new.event_id); end if;
  return null;
end;
$$;
create trigger inventory_order_check after update on public.orders
  for each row execute function private.check_inventory_order();

-- Direct catalog edits cannot lower capacity underneath sold/live reservations.
create function private.guard_inventory_catalog() returns trigger
language plpgsql security definer set search_path = '' as $$
declare used bigint; at_time timestamptz;
begin
  if tg_table_name='events' then
    if current_setting('transaction_isolation') <> 'read committed' then
      raise exception 'Inventory writes require READ COMMITTED' using errcode='25001';
    end if;
    at_time := clock_timestamp();
    select coalesce(sum(c.sold+c.reserved),0) into used from private.inventory_counts(new.organization_id,new.id,at_time) c;
    if new.capacity is not null and new.capacity < used then raise exception 'Capacity below inventory consumed' using errcode='23514'; end if;
  else
    if new.event_id <> old.event_id then raise exception 'Ticket event is immutable' using errcode='23514'; end if;
    perform private.lock_inventory_event(old.organization_id,old.event_id);
    at_time := clock_timestamp();
    select coalesce(c.sold+c.reserved,0) into used from private.inventory_counts(old.organization_id,old.event_id,at_time) c where c.ticket_type_id=old.id;
    if new.capacity < coalesce(used,0) then raise exception 'Capacity below inventory consumed' using errcode='23514'; end if;
  end if;
  return new;
end;
$$;
create trigger inventory_event_catalog before update on public.events for each row execute function private.guard_inventory_catalog();
create trigger inventory_type_catalog before update on public.ticket_types for each row execute function private.guard_inventory_catalog();

create function public.ticket_availability(p_organization_id uuid, p_event_id uuid)
returns table(ticket_type_id uuid, name text, price bigint, currency text, status public.ticket_type_status,
  available_quantity bigint, sales_open boolean)
language sql stable security definer set search_path = '' as $$
  with moment as (select statement_timestamp() as at_time),
  counts as (select c.* from moment m, private.inventory_counts(p_organization_id,p_event_id,m.at_time) c),
  used as (select coalesce(sum(sold+reserved),0) as total from counts)
  select t.id,t.name,t.price::bigint,t.currency::text,t.status,
    greatest(0,least(t.capacity-coalesce(c.sold+c.reserved,0),coalesce(e.capacity-used.total,2147483647)))::bigint,
    e.status='published' and t.status='active' and e.ends_at>m.at_time
    and (e.sales_start is null or e.sales_start<=m.at_time) and (e.sales_end is null or m.at_time<e.sales_end)
    and (t.sales_start is null or t.sales_start<=m.at_time) and (t.sales_end is null or m.at_time<t.sales_end)
  from public.events e join public.ticket_types t on t.event_id=e.id and t.organization_id=e.organization_id
  cross join moment m cross join used left join counts c on c.ticket_type_id=t.id
  where e.id=p_event_id and e.organization_id=p_organization_id and e.status in ('published','sales_closed')
    and t.status in ('active','paused','sold_out')
  order by t.sort_order,t.id;
$$;

create function public.reserve_tickets(p_organization_id uuid, p_event_id uuid, p_customer_id uuid, p_items jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  e public.events%rowtype; t public.ticket_types%rowtype; settings private.inventory_settings%rowtype;
  line jsonb; requested integer := 0; count_items integer := 0; q integer;
  unit text; total_amount numeric := 0; at_time timestamptz; deadline timestamptz;
  order_id uuid := gen_random_uuid(); code text := 'ORD_' || replace(gen_random_uuid()::text,'-','');
begin
  if p_organization_id is null or p_event_id is null or p_customer_id is null
    or p_items is null or jsonb_typeof(p_items)<>'array' then
    raise exception 'Invalid reservation input' using errcode='22023';
  end if;
  select * into strict settings from private.inventory_settings where singleton;
  if jsonb_array_length(p_items) not between 1 and settings.max_tickets_per_order then
    raise exception 'Invalid order size' using errcode='22023';
  end if;
  -- No prices, event overrides, duplicate types or arbitrary fields are accepted.
  for line in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(line)<>'object' or not (line ?& array['ticket_type_id','quantity'])
      or (line - 'ticket_type_id' - 'quantity') <> '{}'::jsonb
      or jsonb_typeof(line->'quantity')<>'number' or (line->>'quantity') !~ '^[1-9][0-9]{0,2}$'
      or jsonb_typeof(line->'ticket_type_id')<>'string' then
      raise exception 'Invalid reservation line' using errcode='22023';
    end if;
    q := (line->>'quantity')::integer;
    requested := requested+q;
    count_items := count_items+1;
  end loop;
  if requested>settings.max_tickets_per_order or count_items<>(select count(distinct (value->>'ticket_type_id')::uuid) from jsonb_array_elements(p_items)) then
    raise exception 'Order limit exceeded or duplicate ticket type' using errcode='22023';
  end if;
  perform private.lock_inventory_event(p_organization_id,p_event_id);
  at_time := clock_timestamp();
  deadline := at_time+make_interval(secs=>settings.online_reservation_seconds);
  select * into strict e from public.events where id=p_event_id and organization_id=p_organization_id;
  if e.status<>'published' or e.ends_at<=at_time or (e.sales_start is not null and e.sales_start>at_time)
    or (e.sales_end is not null and e.sales_end<=at_time) then
    raise exception 'Event sales are closed' using errcode='23514';
  end if;
  if not exists(select 1 from public.customers where id=p_customer_id and organization_id=p_organization_id) then
    raise exception 'Invalid customer context' using errcode='22023';
  end if;
  for line in select value from jsonb_array_elements(p_items) loop
    select * into t from public.ticket_types where id=(line->>'ticket_type_id')::uuid and organization_id=p_organization_id and event_id=p_event_id;
    if not found then raise exception 'Invalid ticket context' using errcode='22023'; end if;
    if t.status<>'active' or (t.sales_start is not null and t.sales_start>at_time) or (t.sales_end is not null and t.sales_end<=at_time) then
      raise exception 'Ticket sales are closed' using errcode='23514';
    end if;
    if unit is not null and unit<>t.currency then raise exception 'Mixed currencies' using errcode='22023'; end if;
    unit := t.currency;
    total_amount := total_amount + t.price::numeric*(line->>'quantity')::integer;
  end loop;
  if total_amount>9007199254740991 then raise exception 'Order amount overflow' using errcode='22003'; end if;
  -- Constraint checks stay deferred while creating this aggregate, then are
  -- explicitly flushed before returning. No partial aggregate can escape.
  set constraints public.order_total_check, public.item_total_check deferred;
  insert into public.orders(id,organization_id,event_id,customer_id,public_code,currency,subtotal,total)
    values(order_id,p_organization_id,p_event_id,p_customer_id,code,unit,total_amount::bigint,total_amount::bigint);
  insert into public.order_items(organization_id,order_id,event_id,ticket_type_id,currency,quantity,unit_price,subtotal)
    select p_organization_id,order_id,p_event_id,catalog.id,catalog.currency,(j.value->>'quantity')::integer,catalog.price,
      (catalog.price::numeric*(j.value->>'quantity')::integer)::bigint
    from jsonb_array_elements(p_items) j join public.ticket_types catalog on catalog.id=(j.value->>'ticket_type_id')::uuid;
  update public.orders set status='pending_payment',reserved_until=deadline where id=order_id;
  -- The order status trigger checks both type and event capacity under the lock.
  set constraints public.order_total_check, public.item_total_check immediate;
  insert into public.audit_logs(organization_id,event_type,entity_type,entity_id,metadata)
    values(p_organization_id,'inventory_reserved','order',order_id,'{"source":"inventory_engine"}');
  return jsonb_build_object('order_id',order_id,'public_code',code,'status','pending_payment',
    'reserved_until',deadline,'currency',unit,'subtotal',total_amount,'total',total_amount);
end;
$$;

create function public.cancel_reservation(p_organization_id uuid, p_order_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare o public.orders%rowtype;
begin
  select * into o from public.orders where id=p_order_id and organization_id=p_organization_id;
  if not found then raise exception 'Invalid order context' using errcode='22023'; end if;
  perform private.lock_inventory_event(p_organization_id,o.event_id);
  select * into strict o from public.orders where id=p_order_id and organization_id=p_organization_id for update;
  if o.status='cancelled' then return jsonb_build_object('order_id',o.id,'status',o.status); end if;
  if o.status<>'pending_payment' then raise exception 'Only pending reservations can be cancelled' using errcode='23514'; end if;
  update public.orders set status='cancelled' where id=o.id;
  insert into public.audit_logs(organization_id,event_type,entity_type,entity_id,metadata)
    values(p_organization_id,'reservation_cancelled','order',o.id,'{"source":"inventory_engine"}');
  return jsonb_build_object('order_id',o.id,'status','cancelled');
end;
$$;

-- Internal provider-independent transition, service_role only. Never creates a payment/ticket.
create function public.confirm_reserved_order(p_organization_id uuid, p_order_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare o public.orders%rowtype;
begin
  select * into o from public.orders where id=p_order_id and organization_id=p_organization_id;
  if not found then raise exception 'Invalid order context' using errcode='22023'; end if;
  perform private.lock_inventory_event(p_organization_id,o.event_id);
  select * into strict o from public.orders where id=p_order_id and organization_id=p_organization_id for update;
  if o.status='paid' then return jsonb_build_object('order_id',o.id,'status',o.status); end if;
  if o.status<>'pending_payment' or o.reserved_until<=clock_timestamp() then
    raise exception 'A live reservation is required' using errcode='23514';
  end if;
  update public.orders set status='paid' where id=o.id;
  insert into public.audit_logs(organization_id,event_type,entity_type,entity_id,metadata)
    values(p_organization_id,'order_confirmed','order',o.id,'{"source":"inventory_engine"}');
  return jsonb_build_object('order_id',o.id,'status','paid');
end;
$$;

create function public.expire_reservations(p_before timestamptz default statement_timestamp(), p_limit integer default 500)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare candidate record; expired_count integer := 0; changed uuid;
begin
  if p_before is null or not isfinite(p_before) or p_before>clock_timestamp() or p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'Invalid expiration cutoff or batch size' using errcode='22023';
  end if;
  -- Global order of event locks prevents job/job deadlocks. Recheck after locking.
  for candidate in select id,organization_id,event_id from public.orders
    where status='pending_payment' and reserved_until<=p_before order by event_id,id limit p_limit loop
    perform private.lock_inventory_event(candidate.organization_id,candidate.event_id);
    update public.orders set status='expired' where id=candidate.id and status='pending_payment' and reserved_until<=p_before returning id into changed;
    if changed is not null then
      insert into public.audit_logs(organization_id,event_type,entity_type,entity_id,metadata)
        values(candidate.organization_id,'reservation_expired','order',changed,'{"source":"inventory_engine"}');
      expired_count := expired_count+1;
    end if;
  end loop;
  return expired_count;
end;
$$;

-- No changes to Phase 1 table policies. Public may only read the safe projection.
revoke all on function public.ticket_availability(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.ticket_availability(uuid,uuid) to anon,authenticated,service_role;
revoke all on function public.reserve_tickets(uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.cancel_reservation(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.confirm_reserved_order(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.expire_reservations(timestamptz,integer) from public,anon,authenticated,service_role;
grant execute on function public.reserve_tickets(uuid,uuid,uuid,jsonb) to service_role;
grant execute on function public.cancel_reservation(uuid,uuid) to service_role;
grant execute on function public.confirm_reserved_order(uuid,uuid) to service_role;
grant execute on function public.expire_reservations(timestamptz,integer) to service_role;
revoke all on function private.lock_inventory_event(uuid,uuid),private.inventory_counts(uuid,uuid,timestamptz),private.assert_inventory(uuid,uuid),
  private.guard_inventory_order(),private.check_inventory_order(),private.guard_inventory_catalog()
  from public,anon,authenticated,service_role;
-- Force the application service to use commands for inventory-affecting writes.
revoke insert,update,delete on public.orders,public.order_items from service_role;
