-- Preserve the provider-authenticated occurrence time so webhook delivery and
-- retries do not redefine whether a Card success happened inside the hold.
alter table public.payments
  add column provider_event_created_at timestamptz;

-- The ordinary inventory guard remains strict. Only the verified Stripe core
-- may authorize one transaction-local late delivery after checking the event
-- occurrence time and current capacity under the event lock.
create or replace function private.guard_inventory_order() returns trigger
language plpgsql security definer set search_path = '' as $$
declare allow_verified_card_completion boolean :=
  current_setting('private.allow_verified_card_completion', true) = 'on';
begin
  if new.order_kind <> old.order_kind then raise exception 'Order kind is immutable' using errcode='23514'; end if;
  if new.status is distinct from old.status then
    perform private.lock_inventory_event(new.organization_id,new.event_id);
    if old.status='pending_payment' and new.status='paid' and old.reserved_until <= clock_timestamp()
       and not allow_verified_card_completion then
      raise exception 'Reservation has expired' using errcode='23514';
    end if;
    if new.order_kind='complimentary' and new.status='pending_payment' then
      raise exception 'Complimentary issuance is not implemented' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;

create function private.apply_stripe_payment_event(
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

  -- Resolve immutable context without row locks, then follow the inventory
  -- engine's global lock order: event -> payment -> order.
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
  if pay.provider_event_id is not null
     and not (pay.status = 'awaiting_cash' and p_event_type = 'payment_intent.succeeded') then
    return jsonb_build_object('status','rejected','reason','different_event_already_applied');
  end if;

  if p_event_type = 'payment_intent.succeeded' then next_status := 'paid';
  elsif p_event_type = 'payment_intent.processing' and p_method='oxxo' then next_status := 'awaiting_cash';
  elsif p_event_type = 'payment_intent.processing' then next_status := 'processing';
  elsif p_event_type = 'payment_intent.payment_failed' then next_status := 'failed';
  else return jsonb_build_object('status','rejected','reason','unsupported_event'); end if;

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
      update public.payments set
        provider_event_id=p_provider_event_id,
        provider_event_created_at=p_provider_event_created_at,
        updated_at=now()
      where id=pay.id;
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
           select 1
           from public.order_items i
           join public.ticket_types t on t.organization_id=i.organization_id and t.id=i.ticket_type_id and t.event_id=i.event_id
           left join private.inventory_counts(ord.organization_id,ord.event_id,clock_timestamp()) c on c.ticket_type_id=i.ticket_type_id
           where i.organization_id=ord.organization_id and i.order_id=ord.id
             and t.capacity is not null and coalesce(c.sold+c.reserved,0)+i.quantity > t.capacity
         ) then
        update public.payments set
          provider_event_id=p_provider_event_id,
          provider_event_created_at=p_provider_event_created_at,
          updated_at=now()
        where id=pay.id;
        return jsonb_build_object('status','reconciliation_required','reason','capacity_conflict','payment_id',pay.id,'order_id',ord.id);
      end if;
      perform set_config('private.allow_verified_card_completion','on',true);
    end if;
  end if;

  if next_status='awaiting_cash' then
    if p_method <> 'oxxo' or p_voucher_expires_at is null or p_voucher_expires_at <= clock_timestamp()
       or p_voucher_url is not null and p_voucher_url !~ '^https://' then
      return jsonb_build_object('status','rejected','reason','invalid_voucher');
    end if;
    perform set_config('private.allow_oxxo_reservation_extension','on',true);
    update public.orders set reserved_until=p_voucher_expires_at where id=ord.id and status='pending_payment';
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
    voucher_expires_at=p_voucher_expires_at,
    voucher_url=p_voucher_url,
    updated_at=now()
  where id=pay.id;

  return jsonb_build_object('status','applied','payment_status',next_status,'payment_id',pay.id,'order_id',ord.id);
end;
$$;

create function public.apply_stripe_payment_event(
  p_provider_event_id text,
  p_provider_payment_id text,
  p_event_type text,
  p_amount public.minor_units,
  p_currency public.currency_code,
  p_method text,
  p_provider_event_created_at timestamptz,
  p_voucher_expires_at timestamptz default null,
  p_voucher_url text default null
) returns jsonb
language sql
volatile
security definer
set search_path = pg_catalog
as $$
  select private.apply_stripe_payment_event(
    p_provider_event_id,
    p_provider_payment_id,
    p_event_type,
    p_amount,
    p_currency,
    p_method,
    p_provider_event_created_at,
    p_voucher_expires_at,
    p_voucher_url
  );
$$;

revoke all on function public.apply_stripe_payment_event(
  text,text,text,public.minor_units,public.currency_code,text,timestamptz,timestamptz,text
) from public,anon,authenticated,service_role;
grant execute on function public.apply_stripe_payment_event(
  text,text,text,public.minor_units,public.currency_code,text,timestamptz,timestamptz,text
) to service_role;
revoke all on function private.apply_stripe_payment_event(
  text,text,text,public.minor_units,public.currency_code,text,timestamptz,timestamptz,text
) from public,anon,authenticated,service_role;
grant execute on function private.apply_stripe_payment_event(
  text,text,text,public.minor_units,public.currency_code,text,timestamptz,timestamptz,text
) to service_role;

drop function public.apply_stripe_payment_event(
  text,text,text,public.minor_units,public.currency_code,text,timestamptz,text
);
drop function private.apply_stripe_payment_event(
  text,text,text,public.minor_units,public.currency_code,text,timestamptz,text
);
