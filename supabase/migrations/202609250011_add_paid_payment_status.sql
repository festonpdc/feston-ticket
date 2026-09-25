-- Canonical success state for the Stripe payment core.
alter type public.payment_status add value if not exists 'paid';
