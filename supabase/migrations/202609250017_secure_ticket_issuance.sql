-- One ticket per purchased unit. Existing historical tickets are assigned the
-- stable position they already occupied within each order item.
alter table public.tickets add column unit_index integer;
with ranked as (
  select id,row_number() over(partition by order_item_id order by created_at,id)::integer unit_index
  from public.tickets
)
update public.tickets t set unit_index=ranked.unit_index from ranked where ranked.id=t.id;
alter table public.tickets alter column unit_index set not null;
alter table public.tickets add constraint tickets_unit_index_positive check(unit_index>0);
alter table public.tickets add constraint tickets_order_item_unit_unique
  unique(organization_id,order_item_id,unit_index);

-- Financial settlement remains independent. This retryable command can run
-- immediately after the webhook or later without duplicating issued tickets.
create function public.issue_tickets_for_paid_order(
  p_organization_id uuid,
  p_order_id uuid,
  p_manifest jsonb
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  ord public.orders%rowtype;
  line jsonb;
  expected integer;
  issued integer;
  result jsonb;
begin
  if p_organization_id is null or p_order_id is null or p_manifest is null
     or jsonb_typeof(p_manifest)<>'array' then
    raise exception 'Invalid ticket issuance input' using errcode='22023';
  end if;

  select * into ord from public.orders
    where organization_id=p_organization_id and id=p_order_id for update;
  if not found then return jsonb_build_object('status','rejected','reason','order_not_found'); end if;
  if ord.status<>'paid' or not exists(
    select 1 from public.payments p
    where p.organization_id=ord.organization_id and p.order_id=ord.id
      and p.status='paid' and p.amount=ord.total and p.currency=ord.currency
  ) then
    return jsonb_build_object('status','rejected','reason','order_not_paid');
  end if;

  select coalesce(sum(quantity),0)::integer into expected from public.order_items
    where organization_id=ord.organization_id and order_id=ord.id;
  if expected<1 or jsonb_array_length(p_manifest)<>expected then
    raise exception 'Ticket manifest quantity mismatch' using errcode='22023';
  end if;

  for line in select value from jsonb_array_elements(p_manifest) loop
    if jsonb_typeof(line)<>'object'
       or not (line ?& array['id','order_item_id','unit_index','public_code','secure_token_hash'])
       or (line-'id'-'order_item_id'-'unit_index'-'public_code'-'secure_token_hash')<>'{}'::jsonb
       or jsonb_typeof(line->'id')<>'string'
       or jsonb_typeof(line->'order_item_id')<>'string'
       or jsonb_typeof(line->'unit_index')<>'number'
       or (line->>'unit_index')!~'^[1-9][0-9]*$'
       or jsonb_typeof(line->'public_code')<>'string'
       or (line->>'public_code')!~'^TKT_[a-f0-9]{32}$'
       or jsonb_typeof(line->'secure_token_hash')<>'string'
       or (line->>'secure_token_hash')!~'^[a-f0-9]{64}$' then
      raise exception 'Invalid ticket manifest line' using errcode='22023';
    end if;
  end loop;

  if exists(
    select 1
    from jsonb_to_recordset(p_manifest) m(id uuid,order_item_id uuid,unit_index integer,public_code text,secure_token_hash text)
    left join public.order_items i on i.id=m.order_item_id and i.organization_id=ord.organization_id and i.order_id=ord.id
    where i.id is null or m.unit_index>i.quantity
  ) or (select count(*) from jsonb_to_recordset(p_manifest) m(id uuid,order_item_id uuid,unit_index integer,public_code text,secure_token_hash text))
       <> (select count(*) from (select distinct m.order_item_id,m.unit_index from jsonb_to_recordset(p_manifest) m(id uuid,order_item_id uuid,unit_index integer,public_code text,secure_token_hash text)) unique_units) then
    raise exception 'Invalid ticket manifest mapping' using errcode='22023';
  end if;

  insert into public.tickets(
    id,organization_id,event_id,order_id,order_item_id,ticket_type_id,
    unit_index,public_code,secure_token_hash,status
  )
  select m.id,ord.organization_id,ord.event_id,ord.id,i.id,i.ticket_type_id,
    m.unit_index,m.public_code,m.secure_token_hash,'valid'
  from jsonb_to_recordset(p_manifest) m(id uuid,order_item_id uuid,unit_index integer,public_code text,secure_token_hash text)
  join public.order_items i on i.id=m.order_item_id and i.organization_id=ord.organization_id and i.order_id=ord.id
  on conflict do nothing;

  select count(*)::integer into issued from public.tickets
    where organization_id=ord.organization_id and order_id=ord.id;
  if issued<>expected then
    raise exception 'Ticket issuance is incomplete' using errcode='23514';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',t.id,
    'order_item_id',t.order_item_id,
    'ticket_type_id',t.ticket_type_id,
    'ticket_type_name',tt.name,
    'unit_index',t.unit_index,
    'item_quantity',i.quantity,
    'public_code',t.public_code,
    'secure_token_hash',t.secure_token_hash,
    'status',t.status,
    'issued_at',t.issued_at
  ) order by i.id,t.unit_index),'[]'::jsonb) into result
  from public.tickets t
  join public.order_items i on i.id=t.order_item_id and i.organization_id=t.organization_id
  join public.ticket_types tt on tt.id=t.ticket_type_id and tt.organization_id=t.organization_id
  where t.organization_id=ord.organization_id and t.order_id=ord.id;

  return jsonb_build_object('status','issued','order_id',ord.id,'quantity',issued,'tickets',result);
end;
$$;

revoke all on function public.issue_tickets_for_paid_order(uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.issue_tickets_for_paid_order(uuid,uuid,jsonb) to service_role;
