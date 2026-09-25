-- PostgREST bridge for the server-only Stripe webhook. Financial behavior
-- remains exclusively in private.apply_stripe_payment_event.
create or replace function public.apply_stripe_payment_event(
  p_provider_event_id text,
  p_provider_payment_id text,
  p_event_type text,
  p_amount public.minor_units,
  p_currency public.currency_code,
  p_method text,
  p_voucher_expires_at timestamptz default null,
  p_voucher_url text default null
) returns jsonb
language sql
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
    p_voucher_expires_at,
    p_voucher_url
  );
$$;

revoke all on function public.apply_stripe_payment_event(
  text, text, text, public.minor_units, public.currency_code, text, timestamptz, text
) from public, anon, authenticated;

grant execute on function public.apply_stripe_payment_event(
  text, text, text, public.minor_units, public.currency_code, text, timestamptz, text
) to service_role;
