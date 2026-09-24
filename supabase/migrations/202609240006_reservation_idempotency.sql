-- Remove the non-idempotent public overload; core becomes an owner-only helper.
alter function public.reserve_tickets(uuid,uuid,uuid,jsonb) set schema private;
revoke all on function private.reserve_tickets(uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;

create or replace function private.reserve_tickets(p_organization_id uuid, p_event_id uuid, p_customer_id uuid, p_items jsonb)
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
    from jsonb_array_elements(p_items) j join public.ticket_types catalog on catalog.id=(j.value->>'ticket_type_id')::uuid
    order by catalog.id;
  update public.orders set status='pending_payment',reserved_until=deadline where id=order_id;
  -- The order status trigger checks both type and event capacity under the lock.
  set constraints public.order_total_check, public.item_total_check immediate;
  insert into public.audit_logs(organization_id,event_type,entity_type,entity_id,metadata)
    values(p_organization_id,'inventory_reserved','order',order_id,'{"source":"inventory_engine"}');
  return jsonb_build_object('order_id',order_id,'public_code',code,'status','pending_payment',
    'reserved_until',deadline,'currency',unit,'subtotal',total_amount,'total',total_amount);
end;
$$;

create table private.reservation_requests (
  key_hash text primary key check (key_hash ~ '^[a-f0-9]{64}$'),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  order_id uuid not null unique references public.orders(id),
  created_at timestamptz not null default now()
);
alter table private.reservation_requests enable row level security;
alter table private.reservation_requests force row level security;
revoke all on private.reservation_requests from public,anon,authenticated,service_role;
create trigger reservation_request_immutable before update or delete on private.reservation_requests
  for each row execute function private.reject_mutation();
create trigger reservation_request_no_truncate before truncate on private.reservation_requests
  for each statement execute function private.reject_mutation();

create function public.reserve_tickets(p_organization_id uuid, p_event_id uuid, p_customer_id uuid, p_items jsonb, p_idempotency_key text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  line jsonb; normalized jsonb; key_digest text; payload_digest text;
  previous private.reservation_requests%rowtype; receipt jsonb; o public.orders%rowtype;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Inventory commands require READ COMMITTED' using errcode='25001';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[a-f0-9]{64}$'
    or p_organization_id is null or p_event_id is null or p_customer_id is null
    or p_items is null or jsonb_typeof(p_items)<>'array' then
    raise exception 'Invalid reservation input' using errcode='22023';
  end if;
  -- Structural ceilings are independent of configurable business limits so an
  -- existing reservation remains recoverable after a settings/catalog change.
  if jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'Invalid order size' using errcode='22023';
  end if;
  for line in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(line)<>'object' or not (line ?& array['ticket_type_id','quantity'])
      or (line - 'ticket_type_id' - 'quantity')<>'{}'::jsonb
      or jsonb_typeof(line->'ticket_type_id')<>'string'
      or jsonb_typeof(line->'quantity')<>'number' or (line->>'quantity') !~ '^[1-9][0-9]{0,2}$' then
      raise exception 'Invalid reservation line' using errcode='22023';
    end if;
  end loop;
  if jsonb_array_length(p_items)<>(select count(distinct (value->>'ticket_type_id')::uuid) from jsonb_array_elements(p_items)) then
    raise exception 'Duplicate ticket type' using errcode='22023';
  end if;
  select jsonb_agg(jsonb_build_object('ticket_type_id',(value->>'ticket_type_id')::uuid,
    'quantity',(value->>'quantity')::integer) order by (value->>'ticket_type_id')::uuid)
    into normalized from jsonb_array_elements(p_items);
  key_digest := encode(sha256(convert_to(p_idempotency_key,'UTF8')),'hex');
  payload_digest := encode(sha256(convert_to(jsonb_build_object('version',1,'organization_id',p_organization_id,
    'event_id',p_event_id,'customer_id',p_customer_id,'items',normalized)::text,'UTF8')),'hex');
  -- Fixed namespace prefix; 64-bit collisions only serialize unrelated keys.
  -- The full SHA-256 key remains the durable unique identity.
  perform pg_advisory_xact_lock(hashtextextended('reservation:' || key_digest,0));
  select * into previous from private.reservation_requests where key_hash=key_digest;
  if found then
    if previous.payload_hash<>payload_digest then
      raise exception 'Idempotency key conflicts with reservation context' using errcode='PT409';
    end if;
    perform private.lock_inventory_event(p_organization_id,p_event_id);
    select * into strict o from public.orders where id=previous.order_id and organization_id=p_organization_id
      and event_id=p_event_id and customer_id=p_customer_id for update;
  else
    receipt := private.reserve_tickets(p_organization_id,p_event_id,p_customer_id,normalized);
    insert into private.reservation_requests(key_hash,payload_hash,order_id)
      values(key_digest,payload_digest,(receipt->>'order_id')::uuid);
    select * into strict o from public.orders where id=(receipt->>'order_id')::uuid;
  end if;
  -- Current lifecycle state, original frozen price/deadline. A retry never renews
  -- a reservation, reopens a terminal order or adds audit/stock consumption.
  return jsonb_build_object('order_id',o.id,'public_code',o.public_code,'status',o.status,
    'reserved_until',o.reserved_until,'currency',o.currency,'subtotal',o.subtotal,'total',o.total,
    'reservation_active',o.status='pending_payment' and o.reserved_until>clock_timestamp());
end;
$$;
revoke all on function public.reserve_tickets(uuid,uuid,uuid,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.reserve_tickets(uuid,uuid,uuid,jsonb,text) to service_role;
-- CREATE OR REPLACE preserves old grants; explicitly seal the internal helper.
revoke all on function private.reserve_tickets(uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;

