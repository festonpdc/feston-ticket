# Ticket engine

Migration 017 extends the existing `public.tickets` model with a positive
`unit_index` and a unique `(organization_id, order_item_id, unit_index)` key.
`public.issue_tickets_for_paid_order` locks the order, verifies both the paid
order and its matching paid payment, validates the complete unit manifest, and
atomically returns exactly one ticket per purchased unit. Repeating or racing
the command returns the same set. Ticket issuance is intentionally retryable
after financial settlement, so a rendering or delivery failure cannot undo a
successful payment.

The server derives each opaque `fst1_` token with HMAC-SHA-256 from a dedicated
`TICKET_QR_SECRET` and the deterministic per-unit ticket identity. Only the
SHA-256 token hash is sent to and stored in PostgreSQL. The raw token exists
only while producing the authorized response and QR URL. `APP_URL` is the sole
origin used to build `/t/<opaque-token>` links; request `Host` headers are not
trusted. The same `TICKET_QR_SECRET` must be configured consistently in every
runtime so retries can regenerate the same token.

The browser lists tickets only with the signed order status capability. It
cannot authorize issuance from an order ID alone. The database command is
`SECURITY DEFINER`, has an empty `search_path`, and is executable only by
`service_role`. Tables remain protected by forced RLS. Opening the public token
route performs a hash lookup and presents minimal event data; it never creates
a check-in. Authenticated, atomic check-in remains a separate future phase.
