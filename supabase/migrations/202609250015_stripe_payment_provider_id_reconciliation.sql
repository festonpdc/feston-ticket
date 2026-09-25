-- One-way reconciliation for legacy Stripe payments created before their
-- provider identifier was included in the immutable payment snapshot.
create or replace function private.guard_payment() returns trigger
language plpgsql set search_path = '' as $$
declare allow_reconciliation boolean :=
  current_setting('private.allow_stripe_provider_id_reconciliation', true) = 'on';
begin
  if tg_op = 'DELETE' then
    raise exception 'Payments are historical' using errcode = '23514';
  end if;
  if (new.order_id, new.amount, new.currency, new.provider, new.provider_payment_id)
    is distinct from (old.order_id, old.amount, old.currency, old.provider, old.provider_payment_id)
    and not (
      allow_reconciliation
      and old.provider = 'stripe'
      and new.provider = old.provider
      and old.provider_payment_id is null
      and new.provider_payment_id is not null
      and new.order_id = old.order_id
      and new.amount = old.amount
      and new.currency = old.currency
      and old.status = 'pending'
      and new.status = old.status
    ) then
    raise exception 'Payment snapshot is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.reconcile_stripe_payment_provider_id(
  p_payment_id uuid,
  p_organization_id uuid,
  p_order_id uuid,
  p_provider_payment_id text,
  p_amount public.minor_units,
  p_currency public.currency_code
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  pay public.payments%rowtype;
  ord public.orders%rowtype;
  stripe_payment_count integer;
begin
  if p_payment_id is null or p_organization_id is null or p_order_id is null
     or p_provider_payment_id is null or p_provider_payment_id !~ '^pi_[A-Za-z0-9_]+$' then
    return jsonb_build_object('status','rejected','reason','invalid_input');
  end if;

  select * into pay from public.payments where id = p_payment_id for update;
  if not found then return jsonb_build_object('status','rejected','reason','payment_not_found'); end if;

  select * into ord from public.orders where id = p_order_id for update;
  if not found then return jsonb_build_object('status','rejected','reason','order_not_found'); end if;

  select count(*) into stripe_payment_count
  from public.payments
  where organization_id = p_organization_id and order_id = p_order_id and provider = 'stripe';

  if pay.organization_id <> p_organization_id or pay.order_id <> p_order_id
     or ord.organization_id <> p_organization_id or ord.id <> pay.order_id then
    return jsonb_build_object('status','rejected','reason','organization_or_order_mismatch');
  end if;
  if stripe_payment_count <> 1 then
    return jsonb_build_object('status','rejected','reason','ambiguous_payment');
  end if;
  if pay.provider <> 'stripe' then
    return jsonb_build_object('status','rejected','reason','provider_mismatch');
  end if;
  if pay.amount <> p_amount or ord.total <> p_amount
     or pay.currency <> p_currency or ord.currency <> p_currency then
    return jsonb_build_object('status','rejected','reason','amount_or_currency_mismatch');
  end if;
  if pay.status <> 'pending' then
    return jsonb_build_object('status','rejected','reason','payment_state');
  end if;
  if ord.status <> 'pending_payment' then
    return jsonb_build_object('status','rejected','reason','order_state');
  end if;
  if pay.provider_event_id is not null then
    return jsonb_build_object('status','rejected','reason','event_already_consumed');
  end if;
  if pay.provider_payment_id = p_provider_payment_id then
    return jsonb_build_object('status','already_applied','payment_id',pay.id,'order_id',ord.id);
  end if;
  if pay.provider_payment_id is not null then
    return jsonb_build_object('status','rejected','reason','provider_payment_id_immutable');
  end if;
  if exists (
    select 1 from public.payments
    where provider = 'stripe' and provider_payment_id = p_provider_payment_id and id <> pay.id
  ) then
    return jsonb_build_object('status','rejected','reason','provider_payment_id_in_use');
  end if;

  perform set_config('private.allow_stripe_provider_id_reconciliation','on',true);
  update public.payments
  set provider_payment_id = p_provider_payment_id, updated_at = now()
  where id = pay.id and provider_payment_id is null;

  if not found then
    return jsonb_build_object('status','rejected','reason','concurrent_change');
  end if;
  return jsonb_build_object('status','applied','payment_id',pay.id,'order_id',ord.id);
end;
$$;

revoke all on function public.reconcile_stripe_payment_provider_id(
  uuid,uuid,uuid,text,public.minor_units,public.currency_code
) from public, anon, authenticated;
grant execute on function public.reconcile_stripe_payment_provider_id(
  uuid,uuid,uuid,text,public.minor_units,public.currency_code
) to service_role;
