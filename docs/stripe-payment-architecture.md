# Stripe payment architecture (Fase 5A)

The payment boundary is `Order → Payment → PaymentIntent → Stripe → verified webhook → Paid`. The browser never supplies amount or currency and never marks an order paid.

`@programita/payments` exposes `PaymentProvider` and `StripePaymentProvider`. The adapter is server-only, uses Stripe idempotency keys, keeps metadata to opaque order/organization/event identifiers, and maps provider states to domain states.

Card uses `card` and can become `paid` only after a verified `payment_intent.succeeded` event. OXXO uses `oxxo`; voucher generation is represented as `awaiting_cash` and is never treated as payment confirmation. The inventory lifetime for OXXO vouchers remains a pending commercial decision and is intentionally not implemented.

Migration `202609240010_stripe_payment_foundation.sql` is prepared locally only. It adds provider event deduplication and safe voucher fields plus domain states; it has not been applied remotely.

Before 5B, add the authorized DB service that resolves an order snapshot, persists one payment, validates webhook amount/currency/provider IDs, applies atomic paid transitions, and records webhook idempotency. Rate limiting for PaymentIntent creation and `/api/reserve` remains a production blocker. Stripe.js CSP directives will be reviewed when Payment Element is introduced.
