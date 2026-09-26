-- Align the OXXO lifecycle with Stripe's voucher events. The global lock
-- order remains inventory event -> payment -> order for every transition.
create or replace function private.apply_stripe_payment_event(
  p_provider_event_id text, p_provider_payment_id text, p_event_type text,
  p_amount public.minor_units, p_currency public.currency_code, p_method text,
  p_provider_event_created_at timestamptz,
  p_voucher_expires_at timestamptz default null, p_voucher_url text default null
) returns jsonb language plpgsql security definer set search_path = public, private as $$
declare
  pay public.payments%rowtype;
  ord public.orders%rowtype;
  next_status public.payment_status;
  event_capacity integer;
  event_used bigint;
  order_quantity bigint;
  late_card_success boolean := false;
begin
  if p_provider_event_id is null or p_provider_event_id = ''
     or p_provider_payment_id is null or p_provider_payment_id = ''
     or p_provider_event_created_at is null or not isfinite(p_provider_event_created_at) then
    raise exception 'Invalid provider event' using errcode='22023';
  end if;

  select * into pay from public.payments
    where provider='stripe' and provider_payment_id=p_provider_payment_id;
  if not found then return jsonb_build_object('status','rejected','reason','payment_not_found'); end if;
  select * into ord from public.orders
    where organization_id=pay.organization_id and id=pay.order_id;
  if not found then return jsonb_build_object('status','rejected','reason','order_not_found'); end if;

  perform private.lock_inventory_event(ord.organization_id,ord.event_id);
  select * into pay from public.payments
    where id=pay.id and provider='stripe' and provider_payment_id=p_provider_payment_id for update;
  if not found then return jsonb_build_object('status','rejected','reason','payment_not_found'); end if;
  select * into ord from public.orders
    where organization_id=pay.organization_id and id=pay.order_id for update;
  if not found then return jsonb_build_object('status','rejected','reason','order_not_found'); end if;

  if pay.currency <> ord.currency or pay.amount <> ord.total
     or p_currency <> pay.currency or p_amount <> pay.amount then
    return jsonb_build_object('status','rejected','reason','amount_or_currency_mismatch');
  end if;
  if pay.method is distinct from p_method then
    return jsonb_build_object('status','rejected','reason','payment_method_mismatch');
  end if;
  if pay.provider_event_id = p_provider_event_id then
    return jsonb_build_object('status','duplicate','payment_id',pay.id,'order_id',ord.id);
  end if;

  if p_event_type = 'payment_intent.succeeded' then next_status := 'paid';
  elsif p_event_type = 'payment_intent.requires_action' and p_method='oxxo' then next_status := 'awaiting_cash';
  elsif p_event_type = 'payment_intent.processing' and p_method='oxxo' then next_status := 'awaiting_cash';
  elsif p_event_type = 'payment_intent.processing' then next_status := 'processing';
  elsif p_event_type = 'payment_intent.payment_failed' then next_status := 'failed';
  elsif p_event_type = 'payment_intent.canceled' and p_method='oxxo' then next_status := 'cancelled';
  else return jsonb_build_object('status','rejected','reason','unsupported_event'); end if;

  -- A paid result is terminal. Older or contradictory events never degrade it.
  if pay.status='paid' then
    return jsonb_build_object('status','rejected','reason','payment_already_paid');
  end if;
  if pay.provider_event_id is not null and not (
    p_method='oxxo' and (
      pay.status='awaiting_cash' and p_event_type in ('payment_intent.succeeded','payment_intent.payment_failed','payment_intent.canceled')
      or pay.status='expired' and p_event_type='payment_intent.succeeded'
    )
  ) then
    return jsonb_build_object('status','rejected','reason','different_event_already_applied');
  end if;

  if next_status='paid' and ord.status not in ('pending_payment','paid') then
    update public.payments set
      provider_event_id=p_provider_event_id,
      provider_event_created_at=p_provider_event_created_at,
      updated_at=now()
    where id=pay.id;
    return jsonb_build_object('status','reconciliation_required','reason','order_state','payment_id',pay.id,'order_id',ord.id);
  end if;

  if next_status='paid' and p_method='card' then
    if p_provider_event_created_at > ord.reserved_until then
      update public.payments set provider_event_id=p_provider_event_id,
        provider_event_created_at=p_provider_event_created_at,updated_at=now() where id=pay.id;
      return jsonb_build_object('status','reconciliation_required','reason','event_after_reservation_expiry','payment_id',pay.id,'order_id',ord.id);
    end if;
    late_card_success := ord.status='pending_payment' and ord.reserved_until <= clock_timestamp();
    if late_card_success then
      select capacity into event_capacity from public.events
        where organization_id=ord.organization_id and id=ord.event_id;
      select coalesce(sum(c.sold+c.reserved),0) into event_used
        from private.inventory_counts(ord.organization_id,ord.event_id,clock_timestamp()) c;
      select coalesce(sum(quantity),0) into order_quantity from public.order_items
        where organization_id=ord.organization_id and order_id=ord.id;
      if event_capacity is not null and event_used+order_quantity > event_capacity
         or exists (
           select 1 from public.order_items i
           join public.ticket_types t on t.organization_id=i.organization_id and t.id=i.ticket_type_id and t.event_id=i.event_id
           left join private.inventory_counts(ord.organization_id,ord.event_id,clock_timestamp()) c on c.ticket_type_id=i.ticket_type_id
           where i.organization_id=ord.organization_id and i.order_id=ord.id
             and t.capacity is not null and coalesce(c.sold+c.reserved,0)+i.quantity > t.capacity
         ) then
        update public.payments set provider_event_id=p_provider_event_id,
          provider_event_created_at=p_provider_event_created_at,updated_at=now() where id=pay.id;
        return jsonb_build_object('status','reconciliation_required','reason','capacity_conflict','payment_id',pay.id,'order_id',ord.id);
      end if;
      perform set_config('private.allow_verified_card_completion','on',true);
    end if;
  end if;

  if next_status='awaiting_cash' then
    if p_method <> 'oxxo' or p_voucher_expires_at is null
       or p_voucher_expires_at <= clock_timestamp()
       or p_voucher_expires_at <= p_provider_event_created_at
       or p_voucher_expires_at > p_provider_event_created_at + interval '2 days 5 minutes'
       or p_voucher_url is null or p_voucher_url !~ '^https://[^[:space:]]+$' then
      return jsonb_build_object('status','rejected','reason','invalid_voucher');
    end if;
    perform set_config('private.allow_oxxo_reservation_extension','on',true);
    update public.orders set reserved_until=p_voucher_expires_at,updated_at=now()
      where id=ord.id and status='pending_payment';
  elsif next_status in ('failed','cancelled') and p_method='oxxo' then
    update public.orders set status='expired',updated_at=now()
      where id=ord.id and status='pending_payment';
    if found then
      insert into public.audit_logs(organization_id,event_type,entity_type,entity_id,metadata)
      values(ord.organization_id,'reservation_expired','order',ord.id,
        jsonb_build_object('source','stripe_oxxo'));
    end if;
  end if;

  if next_status='paid' then
    update public.orders set status='paid',updated_at=now()
      where id=ord.id and status in ('pending_payment','paid');
    perform set_config('private.allow_verified_card_completion','off',true);
  end if;
  update public.payments set
    provider_event_id=p_provider_event_id,
    provider_event_created_at=p_provider_event_created_at,
    status=next_status,
    voucher_expires_at=case when next_status='awaiting_cash' then p_voucher_expires_at else voucher_expires_at end,
    voucher_url=case when next_status='awaiting_cash' then p_voucher_url else voucher_url end,
    updated_at=now()
  where id=pay.id;

  return jsonb_build_object('status','applied','payment_status',next_status,'payment_id',pay.id,'order_id',ord.id);
end;
$$;

-- Expire the OXXO payment and its reservation together. Card and unpaid
-- reservations retain the existing behavior. Locks match the payment core.
create or replace function public.expire_reservations(
  p_before timestamptz default statement_timestamp(), p_limit integer default 500
) returns integer language plpgsql volatile security definer set search_path = '' as $$
declare
  candidate record;
  expired_count integer := 0;
  changed uuid;
  oxxo_payment_id uuid;
begin
  if p_before is null or not isfinite(p_before) or p_before>clock_timestamp()
     or p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'Invalid expiration cutoff or batch size' using errcode='22023';
  end if;
  for candidate in select id,organization_id,event_id from public.orders
    where status='pending_payment' and reserved_until<=p_before order by event_id,id limit p_limit loop
    changed := null;
    oxxo_payment_id := null;
    perform private.lock_inventory_event(candidate.organization_id,candidate.event_id);
    select id into oxxo_payment_id from public.payments
      where organization_id=candidate.organization_id and order_id=candidate.id
        and method='oxxo' and status='awaiting_cash'
      order by created_at desc limit 1 for update;
    perform 1 from public.orders where id=candidate.id and organization_id=candidate.organization_id for update;
    update public.orders set status='expired',updated_at=now()
      where id=candidate.id and status='pending_payment' and reserved_until<=p_before returning id into changed;
    if changed is not null then
      if oxxo_payment_id is not null then
        update public.payments set status='expired',updated_at=now()
          where id=oxxo_payment_id and status='awaiting_cash' and voucher_expires_at<=p_before;
        if not found then raise exception 'OXXO expiration invariant failed' using errcode='23514'; end if;
      end if;
      insert into public.audit_logs(organization_id,event_type,entity_type,entity_id,metadata)
        values(candidate.organization_id,'reservation_expired','order',changed,
          jsonb_build_object('source','inventory_engine'));
      expired_count := expired_count+1;
    end if;
  end loop;
  return expired_count;
end;
$$;

revoke all on function public.expire_reservations(timestamptz,integer) from public,anon,authenticated,service_role;
grant execute on function public.expire_reservations(timestamptz,integer) to service_role;
revoke all on function private.apply_stripe_payment_event(
  text,text,text,public.minor_units,public.currency_code,text,timestamptz,timestamptz,text
) from public,anon,authenticated,service_role;
grant execute on function private.apply_stripe_payment_event(
  text,text,text,public.minor_units,public.currency_code,text,timestamptz,timestamptz,text
) to service_role;
