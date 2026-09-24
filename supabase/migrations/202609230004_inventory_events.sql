-- Enum additions commit separately before the engine uses the new values.
alter type public.audit_event_type add value 'inventory_reserved';
alter type public.audit_event_type add value 'reservation_expired';
alter type public.audit_event_type add value 'reservation_cancelled';
alter type public.audit_event_type add value 'order_confirmed';
