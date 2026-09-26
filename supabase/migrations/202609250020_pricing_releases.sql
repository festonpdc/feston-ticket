alter table public.ticket_types add constraint ticket_types_organization_event_id_unique unique(organization_id,event_id,id);
create table public.pricing_releases (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, event_id uuid not null, ticket_type_id uuid not null,
  sequence integer not null check(sequence>0), label text, threshold integer check(threshold is null or threshold>0),
  charge_amount public.minor_units not null, charge_currency public.currency_code not null, display_label text, enabled boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(organization_id,event_id,ticket_type_id) references public.ticket_types(organization_id,event_id,id),
  unique(organization_id,ticket_type_id,sequence)
);
alter table public.pricing_releases enable row level security; alter table public.pricing_releases force row level security;
revoke all on public.pricing_releases from public,anon,authenticated; grant select,insert,update,delete on public.pricing_releases to service_role;

create or replace function private.reserve_tickets(p_organization_id uuid, p_event_id uuid, p_customer_id uuid, p_items jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  e public.events%rowtype; t public.ticket_types%rowtype; settings private.inventory_settings%rowtype;
  line jsonb; requested integer := 0; count_items integer := 0; q integer;
  unit text; total_amount numeric := 0; at_time timestamptz; deadline timestamptz;
  effective_price bigint; effective_currency text; occupancy bigint; selected_release public.pricing_releases%rowtype;
  priced_items jsonb := '[]'::jsonb;
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
    select coalesce(c.sold+c.reserved,0) into occupancy from private.inventory_counts(p_organization_id,p_event_id,at_time) c where c.ticket_type_id=t.id;
    occupancy := coalesce(occupancy,0);
    select * into selected_release from public.pricing_releases r where r.organization_id=p_organization_id and r.event_id=p_event_id and r.ticket_type_id=t.id and r.enabled and (r.threshold is null or occupancy<r.threshold) order by r.sequence limit 1;
    if found then effective_price:=selected_release.charge_amount; effective_currency:=selected_release.charge_currency; else effective_price:=t.price; effective_currency:=t.currency; end if;
    if unit is not null and unit<>effective_currency then raise exception 'Mixed currencies' using errcode='22023'; end if;
    unit := effective_currency;
    total_amount := total_amount + effective_price::numeric*(line->>'quantity')::integer;
    priced_items := priced_items || jsonb_build_array(jsonb_build_object('ticket_type_id',t.id,'quantity',(line->>'quantity')::integer,'unit_price',effective_price,'currency',effective_currency));
  end loop;
  if total_amount>9007199254740991 then raise exception 'Order amount overflow' using errcode='22003'; end if;
  -- Constraint checks stay deferred while creating this aggregate, then are
  -- explicitly flushed before returning. No partial aggregate can escape.
  set constraints public.order_total_check, public.item_total_check deferred;
  insert into public.orders(id,organization_id,event_id,customer_id,public_code,currency,subtotal,total)
    values(order_id,p_organization_id,p_event_id,p_customer_id,code,unit,total_amount::bigint,total_amount::bigint);
  insert into public.order_items(organization_id,order_id,event_id,ticket_type_id,currency,quantity,unit_price,subtotal)
    select p_organization_id,order_id,p_event_id,(j.value->>'ticket_type_id')::uuid,(j.value->>'currency')::public.currency_code,(j.value->>'quantity')::integer,(j.value->>'unit_price')::bigint,
      ((j.value->>'unit_price')::numeric*(j.value->>'quantity')::integer)::bigint
    from jsonb_array_elements(priced_items) j order by (j.value->>'ticket_type_id')::uuid;
  update public.orders set status='pending_payment',reserved_until=deadline where id=order_id;
  -- The order status trigger checks both type and event capacity under the lock.
  set constraints public.order_total_check, public.item_total_check immediate;
  insert into public.audit_logs(organization_id,event_type,entity_type,entity_id,metadata)
    values(p_organization_id,'inventory_reserved','order',order_id,'{"source":"inventory_engine"}');
  return jsonb_build_object('order_id',order_id,'public_code',code,'status','pending_payment',
    'reserved_until',deadline,'currency',unit,'subtotal',total_amount,'total',total_amount);
end;
$$;

drop function public.ticket_availability(uuid,uuid);
create function public.ticket_availability(p_organization_id uuid,p_event_id uuid)
returns table(ticket_type_id uuid,name text,price bigint,currency text,status public.ticket_type_status,available_quantity bigint,sales_open boolean,release_sequence integer,release_label text,display_price_label text,commercial_occupancy bigint)
language sql stable security definer set search_path='' as $$
  with moment as (select statement_timestamp() at_time),counts as (select c.* from moment m,private.inventory_counts(p_organization_id,p_event_id,m.at_time)c),used as(select coalesce(sum(sold+reserved),0) total from counts)
  select t.id,t.name,coalesce(r.charge_amount,t.price)::bigint,coalesce(r.charge_currency,t.currency)::text,t.status,
    case when t.capacity is null then null::bigint else greatest(0,least(t.capacity-coalesce(c.sold+c.reserved,0),coalesce(e.capacity-used.total,2147483647)))::bigint end,
    e.status='published' and t.status='active' and e.ends_at>m.at_time and(e.sales_start is null or e.sales_start<=m.at_time)and(e.sales_end is null or m.at_time<e.sales_end)and(t.sales_start is null or t.sales_start<=m.at_time)and(t.sales_end is null or m.at_time<t.sales_end),
    r.sequence,r.label,r.display_label,coalesce(c.sold+c.reserved,0)::bigint
  from public.events e join public.ticket_types t on t.event_id=e.id and t.organization_id=e.organization_id cross join moment m cross join used left join counts c on c.ticket_type_id=t.id
  left join lateral(select x.* from public.pricing_releases x where x.organization_id=t.organization_id and x.event_id=t.event_id and x.ticket_type_id=t.id and x.enabled and(x.threshold is null or coalesce(c.sold+c.reserved,0)<x.threshold)order by x.sequence limit 1)r on true
  where e.id=p_event_id and e.organization_id=p_organization_id and e.status in('published','sales_closed')and t.status in('active','paused','sold_out')order by t.sort_order,t.id;
$$;
revoke all on function public.ticket_availability(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.ticket_availability(uuid,uuid) to anon,authenticated,service_role;
