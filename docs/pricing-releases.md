# Pricing releases

Pricing releases choose the authoritative charge snapshot when a reservation is
created. A release belongs to one organization, event, and ticket type. Its
`threshold` is the maximum commercial occupancy before the next enabled release
applies; a `NULL` threshold is the final open-ended release.

Commercial occupancy is `paid + unexpired pending_payment`. Expired reservations
stop counting, while a paid order counts once. The event inventory row is locked
before occupancy and release selection, so concurrent reservations cannot both
claim the same boundary state. A reservation crossing a threshold keeps one
price for its whole line; only the next reservation advances.

The selected `charge_amount` and `charge_currency` are copied into immutable
`order_items` and `orders` snapshots. Stripe reads those order snapshots and
never recalculates a release. `display_label` is presentation metadata only; the
Fest-On USD labels use a fixed event-specific commercial equivalence and do not
perform dynamic foreign-exchange conversion.

Migration 020 installs the engine without changing Fest-On prices. After isolated
QA, migration 021 activates the approved HOMBRES and MUJERES release schedule.
The public availability RPC exposes only current sale information and occupancy;
the release table itself is inaccessible to browser roles.
