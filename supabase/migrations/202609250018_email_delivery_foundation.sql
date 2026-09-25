create type public.delivery_channel as enum ('email','whatsapp');
create type public.delivery_status as enum ('pending','sending','sent','failed');

alter table public.orders add constraint orders_organization_id_id_unique unique(organization_id,id);

create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  order_id uuid not null,
  channel public.delivery_channel not null,
  purpose text not null check (purpose ~ '^[a-z][a-z0-9_]{0,79}$'),
  sequence integer not null default 1 check (sequence > 0),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{0,39}$'),
  destination text not null check (length(destination) between 3 and 320),
  status public.delivery_status not null default 'pending',
  provider_message_id text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  failed_at timestamptz,
  error_code text check (error_code is null or error_code ~ '^[a-z0-9_]{1,80}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id,order_id) references public.orders(organization_id,id),
  unique (organization_id,order_id,channel,purpose,sequence),
  unique (provider,provider_message_id),
  check (channel <> 'email' or destination = lower(btrim(destination))),
  check (status <> 'sent' or (provider_message_id is not null and sent_at is not null)),
  check (status <> 'failed' or failed_at is not null)
);
create index deliveries_order_idx on public.deliveries(organization_id,order_id,created_at desc);
alter table public.deliveries enable row level security;
alter table public.deliveries force row level security;
revoke all on public.deliveries from public,anon,authenticated;
grant select,insert,update,delete on public.deliveries to service_role;

create function public.claim_order_ticket_email_delivery(p_organization_id uuid,p_order_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare d public.deliveries%rowtype; recipient text; expected integer; actual integer;
begin
  select lower(btrim(c.email)) into recipient from public.orders o
    join public.customers c on c.organization_id=o.organization_id and c.id=o.customer_id
    where o.organization_id=p_organization_id and o.id=p_order_id and o.status='paid'
      and exists(select 1 from public.payments p where p.organization_id=o.organization_id and p.order_id=o.id and p.status='paid' and p.amount=o.total and p.currency=o.currency)
    for update of o;
  if recipient is null then return jsonb_build_object('status','rejected','reason','order_not_paid'); end if;
  select coalesce(sum(quantity),0)::integer into expected from public.order_items where organization_id=p_organization_id and order_id=p_order_id;
  select count(*)::integer into actual from public.tickets where organization_id=p_organization_id and order_id=p_order_id and status='valid';
  if expected<1 or actual<>expected then return jsonb_build_object('status','rejected','reason','tickets_incomplete'); end if;
  insert into public.deliveries(organization_id,order_id,channel,purpose,sequence,provider,destination)
    values(p_organization_id,p_order_id,'email','tickets_initial',1,'resend',recipient)
    on conflict(organization_id,order_id,channel,purpose,sequence) do nothing;
  select * into d from public.deliveries where organization_id=p_organization_id and order_id=p_order_id and channel='email' and purpose='tickets_initial' and sequence=1 for update;
  if d.status='sent' then return jsonb_build_object('status','already_sent','delivery_id',d.id); end if;
  if d.status='sending' and d.last_attempt_at>now()-interval '10 minutes' then return jsonb_build_object('status','busy','delivery_id',d.id); end if;
  update public.deliveries set status='sending',attempt_count=attempt_count+1,last_attempt_at=now(),failed_at=null,error_code=null,updated_at=now()
    where id=d.id returning * into d;
  return jsonb_build_object('status','claimed','delivery_id',d.id,'recipient',recipient,'attempt_count',d.attempt_count);
end $$;

create function public.finish_order_ticket_email_delivery(p_delivery_id uuid,p_success boolean,p_provider_message_id text default null,p_error_code text default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare d public.deliveries%rowtype;
begin
  select * into d from public.deliveries where id=p_delivery_id for update;
  if not found or d.channel<>'email' or d.purpose<>'tickets_initial' then return jsonb_build_object('status','rejected'); end if;
  if d.status='sent' then return jsonb_build_object('status','sent','provider_message_id',d.provider_message_id); end if;
  if p_success then
    if p_provider_message_id is null or length(p_provider_message_id)>255 then raise exception 'Invalid provider message id' using errcode='22023'; end if;
    update public.deliveries set status='sent',provider_message_id=p_provider_message_id,sent_at=now(),failed_at=null,error_code=null,updated_at=now() where id=d.id;
    return jsonb_build_object('status','sent','provider_message_id',p_provider_message_id);
  end if;
  if p_error_code is null or p_error_code!~'^[a-z0-9_]{1,80}$' then p_error_code:='provider_error'; end if;
  update public.deliveries set status='failed',failed_at=now(),error_code=p_error_code,updated_at=now() where id=d.id;
  return jsonb_build_object('status','failed','error_code',p_error_code);
end $$;

revoke all on function public.claim_order_ticket_email_delivery(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.finish_order_ticket_email_delivery(uuid,boolean,text,text) from public,anon,authenticated,service_role;
grant execute on function public.claim_order_ticket_email_delivery(uuid,uuid) to service_role;
grant execute on function public.finish_order_ticket_email_delivery(uuid,boolean,text,text) to service_role;
