create function public.claim_order_ticket_email_delivery_controlled(
  p_organization_id uuid,
  p_order_id uuid,
  p_purpose text,
  p_sequence integer
)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare d public.deliveries%rowtype; recipient text; expected integer; actual integer;
begin
  if p_purpose not in ('tickets_initial','tickets_manual')
    or p_sequence is null or p_sequence < 1
    or (p_purpose='tickets_initial' and p_sequence<>1) then
    raise exception 'Invalid delivery identity' using errcode='22023';
  end if;

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
    values(p_organization_id,p_order_id,'email',p_purpose,p_sequence,'resend',recipient)
    on conflict(organization_id,order_id,channel,purpose,sequence) do nothing;
  select * into d from public.deliveries
    where organization_id=p_organization_id and order_id=p_order_id and channel='email' and purpose=p_purpose and sequence=p_sequence
    for update;
  if d.status='sent' then return jsonb_build_object('status','already_sent','delivery_id',d.id); end if;
  if d.status='sending' and d.last_attempt_at>now()-interval '10 minutes' then return jsonb_build_object('status','busy','delivery_id',d.id); end if;
  update public.deliveries set status='sending',attempt_count=attempt_count+1,last_attempt_at=now(),failed_at=null,error_code=null,updated_at=now()
    where id=d.id returning * into d;
  return jsonb_build_object('status','claimed','delivery_id',d.id,'recipient',recipient,'attempt_count',d.attempt_count,'purpose',d.purpose,'sequence',d.sequence);
end $$;

create function public.finish_order_ticket_email_delivery_controlled(
  p_delivery_id uuid,
  p_success boolean,
  p_provider_message_id text default null,
  p_error_code text default null
)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare d public.deliveries%rowtype;
begin
  select * into d from public.deliveries where id=p_delivery_id for update;
  if not found or d.channel<>'email' or d.purpose not in ('tickets_initial','tickets_manual') then return jsonb_build_object('status','rejected'); end if;
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

revoke all on function public.claim_order_ticket_email_delivery_controlled(uuid,uuid,text,integer) from public,anon,authenticated,service_role;
revoke all on function public.finish_order_ticket_email_delivery_controlled(uuid,boolean,text,text) from public,anon,authenticated,service_role;
grant execute on function public.claim_order_ticket_email_delivery_controlled(uuid,uuid,text,integer) to service_role;
grant execute on function public.finish_order_ticket_email_delivery_controlled(uuid,boolean,text,text) to service_role;
