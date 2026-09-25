-- Corrected operational schedule. The end time is technical only and remains
-- provisional until Fest-On confirms the actual event close.
update public.events
set starts_at='2026-10-31 23:59:00-05'::timestamptz,
    ends_at='2026-11-01 08:00:00-05'::timestamptz,
    timezone='America/Cancun'
where id='f3000000-0000-4000-8000-000000000003'
  and organization_id='f3000000-0000-4000-8000-000000000001';
comment on table public.events is 'Fest-On event starts 2026-10-31 23:59 America/Cancun. The 2026-11-01 08:00 end is technical provisional only; final close pending confirmation.';
