-- Permit only the verified OXXO voucher command to extend an active reservation.
create or replace function private.guard_order() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then raise exception 'Orders start as draft' using errcode = '23514'; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then raise exception 'Orders are historical; cancel instead' using errcode = '23514'; end if;
  if old.status <> 'draft' and
    (new.currency, new.subtotal, new.total, new.customer_id, new.event_id, new.public_code)
      is distinct from
    (old.currency, old.subtotal, old.total, old.customer_id, old.event_id, old.public_code) then
    raise exception 'Order snapshot is immutable' using errcode = '23514';
  end if;
  if old.status <> 'draft' and new.reserved_until is distinct from old.reserved_until
     and not (old.status='pending_payment' and new.status='pending_payment'
       and current_setting('private.allow_oxxo_reservation_extension', true)='on') then
    raise exception 'Order snapshot is immutable' using errcode = '23514';
  end if;
  if new.status <> old.status and not (
    (old.status = 'draft' and new.status in ('pending_payment', 'cancelled')) or
    (old.status = 'pending_payment' and new.status in ('paid', 'expired', 'cancelled')) or
    (old.status = 'paid' and new.status = 'refunded')
  ) then raise exception 'Invalid order transition' using errcode = '23514'; end if;
  return new;
end;
$$;

create or replace function private.apply_stripe_payment_event(
  p_provider_event_id text, p_provider_payment_id text, p_event_type text,
  p_amount public.minor_units, p_currency public.currency_code, p_method text,
  p_voucher_expires_at timestamptz default null, p_voucher_url text default null
) returns jsonb language plpgsql security definer set search_path = public, private as $$
declare pay public.payments%rowtype; ord public.orders%rowtype; next_status public.payment_status;
begin
  if p_provider_event_id is null or p_provider_payment_id is null then raise exception using errcode='22023'; end if;
  select * into pay from public.payments where provider='stripe' and provider_payment_id=p_provider_payment_id for update;
  if not found then return jsonb_build_object('status','rejected','reason','payment_not_found'); end if;
  select * into ord from public.orders where organization_id=pay.organization_id and id=pay.order_id for update;
  if not found or pay.currency <> ord.currency or pay.amount <> ord.total or p_currency <> pay.currency or p_amount <> pay.amount then
    return jsonb_build_object('status','rejected','reason','amount_or_currency_mismatch');
  end if;
  if pay.provider_event_id = p_provider_event_id then return jsonb_build_object('status','duplicate','payment_id',pay.id,'order_id',ord.id); end if;
  if pay.provider_event_id is not null and not (pay.status = 'awaiting_cash' and p_event_type = 'payment_intent.succeeded') then
    return jsonb_build_object('status','rejected','reason','different_event_already_applied');
  end if;
  if p_event_type = 'payment_intent.succeeded' then next_status := 'paid';
  elsif p_event_type = 'payment_intent.processing' and p_method='oxxo' then next_status := 'awaiting_cash';
  elsif p_event_type = 'payment_intent.processing' then next_status := 'processing';
  elsif p_event_type = 'payment_intent.payment_failed' then next_status := 'failed';
  else return jsonb_build_object('status','rejected','reason','unsupported_event'); end if;
  if next_status='paid' and ord.status not in ('pending_payment','paid') then return jsonb_build_object('status','rejected','reason','order_state'); end if;
  if next_status='awaiting_cash' then
    if p_method <> 'oxxo' or p_voucher_expires_at is null or p_voucher_expires_at <= clock_timestamp()
       or p_voucher_url is not null and p_voucher_url !~ '^https://' then
      return jsonb_build_object('status','rejected','reason','invalid_voucher');
    end if;
    perform set_config('private.allow_oxxo_reservation_extension','on',true);
    update public.orders set reserved_until=p_voucher_expires_at where id=ord.id and status='pending_payment';
  end if;
  update public.payments set provider_event_id=p_provider_event_id,status=next_status,voucher_expires_at=p_voucher_expires_at,voucher_url=p_voucher_url,updated_at=now() where id=pay.id;
  if next_status='paid' then update public.orders set status='paid',updated_at=now() where id=ord.id and status in ('pending_payment','paid'); end if;
  return jsonb_build_object('status','applied','payment_status',next_status,'payment_id',pay.id,'order_id',ord.id);
end; $$;
revoke all on function private.apply_stripe_payment_event(text,text,text,public.minor_units,public.currency_code,text,timestamptz,text) from public, anon, authenticated;
grant execute on function private.apply_stripe_payment_event(text,text,text,public.minor_units,public.currency_code,text,timestamptz,text) to service_role;
