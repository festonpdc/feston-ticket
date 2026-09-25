-- A NULL ticket-type capacity means no commercial cap is configured.
-- Inventory counts remain authoritative through order_items and inventory_counts.
alter table public.ticket_types alter column capacity drop not null;

create or replace function public.ticket_availability(p_organization_id uuid, p_event_id uuid)
returns table(ticket_type_id uuid, name text, price bigint, currency text, status public.ticket_type_status,
  available_quantity bigint, sales_open boolean)
language sql stable security definer set search_path = '' as $$
  with moment as (select statement_timestamp() as at_time),
  counts as (select c.* from moment m, private.inventory_counts(p_organization_id,p_event_id,m.at_time) c),
  used as (select coalesce(sum(sold+reserved),0) as total from counts)
  select t.id,t.name,t.price::bigint,t.currency::text,t.status,
    case when t.capacity is null then null::bigint
      else greatest(0,least(t.capacity-coalesce(c.sold+c.reserved,0),coalesce(e.capacity-used.total,2147483647)))::bigint end,
    e.status='published' and t.status='active' and e.ends_at>m.at_time
    and (e.sales_start is null or e.sales_start<=m.at_time) and (e.sales_end is null or m.at_time<e.sales_end)
    and (t.sales_start is null or t.sales_start<=m.at_time) and (t.sales_end is null or m.at_time<t.sales_end)
  from public.events e join public.ticket_types t on t.event_id=e.id and t.organization_id=e.organization_id
  cross join moment m cross join used left join counts c on c.ticket_type_id=t.id
  where e.id=p_event_id and e.organization_id=p_organization_id and e.status in ('published','sales_closed')
    and t.status in ('active','paused','sold_out') order by t.sort_order,t.id;
$$;

comment on column public.ticket_types.capacity is 'NULL means no commercial ticket-type cap; order_items remain the inventory ledger.';
