-- Fase 5A: payment provider foundation. Prepare only; do not apply remotely yet.
alter type public.payment_status add value if not exists 'processing';
alter type public.payment_status add value if not exists 'failed';
alter type public.payment_status add value if not exists 'expired';
alter type public.payment_status add value if not exists 'awaiting_cash';
alter table public.payments add column if not exists provider_event_id text;
alter table public.payments add column if not exists voucher_expires_at timestamptz;
alter table public.payments add column if not exists voucher_url text;
create unique index if not exists payments_provider_event_uidx on public.payments(provider, provider_event_id) where provider_event_id is not null;
alter table public.payments add constraint payments_voucher_url_safe check (voucher_url is null or voucher_url ~ '^https://');

create or replace function private.apply_stripe_payment_event(
  p_provider_event_id text, p_provider_payment_id text, p_event_type text,
  p_amount public.minor_units, p_currency public.currency_code, p_method text,
  p_voucher_expires_at timestamptz default null, p_voucher_url text default null
) returns jsonb language plpgsql security definer set search_path = public, private as $$
declare pay public.payments%rowtype; ord public.orders%rowtype; next_status public.payment_status;
begin
  if p_provider_event_id is null or p_provider_payment_id is null then raise exception using errcode='22023'; end if;
  -- Stable order: payment first, then its order. This serializes webhook and expiry transitions.
  select * into pay from public.payments where provider='stripe' and provider_payment_id=p_provider_payment_id for update;
  if not found then return jsonb_build_object('status','rejected','reason','payment_not_found'); end if;
  select * into ord from public.orders where organization_id=pay.organization_id and id=pay.order_id for update;
  if not found or pay.currency <> ord.currency or pay.amount <> ord.total or p_currency <> pay.currency or p_amount <> pay.amount then
    return jsonb_build_object('status','rejected','reason','amount_or_currency_mismatch');
  end if;
  if pay.provider_event_id = p_provider_event_id then return jsonb_build_object('status','duplicate','payment_id',pay.id,'order_id',ord.id); end if;
  if pay.provider_event_id is not null then return jsonb_build_object('status','rejected','reason','different_event_already_applied'); end if;
  if p_event_type = 'payment_intent.succeeded' then next_status := 'paid';
  elsif p_event_type = 'payment_intent.processing' and p_method='oxxo' then next_status := 'awaiting_cash';
  elsif p_event_type = 'payment_intent.processing' then next_status := 'processing';
  elsif p_event_type = 'payment_intent.payment_failed' then next_status := 'failed';
  else return jsonb_build_object('status','rejected','reason','unsupported_event'); end if;
  update public.payments set provider_event_id=p_provider_event_id,status=next_status,voucher_expires_at=p_voucher_expires_at,voucher_url=p_voucher_url,updated_at=now() where id=pay.id;
  if next_status='paid' then
    if ord.status not in ('pending_payment','paid') then return jsonb_build_object('status','rejected','reason','order_state'); end if;
    update public.orders set status='paid',updated_at=now() where id=ord.id and status in ('pending_payment','paid');
  end if;
  return jsonb_build_object('status','applied','payment_status',next_status,'payment_id',pay.id,'order_id',ord.id);
end; $$;
revoke all on function private.apply_stripe_payment_event(text,text,text,public.minor_units,public.currency_code,text,timestamptz,text) from public, anon, authenticated;
grant execute on function private.apply_stripe_payment_event(text,text,text,public.minor_units,public.currency_code,text,timestamptz,text) to service_role;
