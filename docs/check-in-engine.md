# Atomic check-in engine

`public.check_in_ticket` is the only browser-callable mutation for admission. It
requires an authenticated organization member with the owner, manager, or door
role. Buyer capabilities and bearer ticket URLs remain read-only.

The command hashes the opaque token with SHA-256 and never stores or returns the
raw value. After authorization it locks the matching ticket row, checks event and
organization context, verifies a valid ticket backed by a paid order, inserts one
append-only check-in, marks the ticket redeemed, and appends an audit record.
PostgreSQL's ticket-row lock plus the existing unique constraint on
`check_ins.ticket_id` serializes concurrent scans. Lock order is ticket, existing
check-in lookup, order read, check-in insert, ticket update, audit insert. A retry
returns `already_checked_in` with the server timestamp and creates no new row.

The scanner requires a live connection. Offline admission is intentionally not
supported because local-only decisions cannot safely prevent double entry.
