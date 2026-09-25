# Transactional email delivery foundation

Migration 018 adds `public.deliveries` as an audit record independent from
orders, payments and tickets. The initial ticket email is uniquely identified
by organization, order, channel `email`, purpose `tickets_initial`, and
sequence `1`. A future manual resend can use a later sequence without changing
the initial delivery record.

`claim_order_ticket_email_delivery` locks and validates the paid order, its
matching paid payment and the complete set of valid tickets. It resolves the
normalized customer email from PostgreSQL and atomically claims the retry.
`finish_order_ticket_email_delivery` records only the provider message ID or a
sanitized error code. Both RPCs use a fixed empty `search_path`, are unavailable
to anon/authenticated, and are executable only by `service_role`.

`sendOrderTicketsEmail` is server-only and accepts only organization and order
identifiers. It never accepts a browser-selected recipient. Resend receives a
stable idempotency key derived from the delivery ID. Provider failure updates
only the delivery row; financial and ticket state remain unchanged. No public
send endpoint or Stripe webhook integration exists in this foundation phase.
