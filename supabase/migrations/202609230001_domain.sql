create schema if not exists private;
revoke all on schema private from public;

create type public.member_role as enum ('owner', 'manager', 'door');
create type public.event_status as enum ('draft', 'published', 'sales_closed', 'completed', 'cancelled');
create type public.ticket_type_status as enum ('draft', 'active', 'paused', 'sold_out', 'archived');
create type public.order_status as enum ('draft', 'pending_payment', 'paid', 'expired', 'cancelled', 'refunded');
create type public.payment_status as enum ('pending', 'approved', 'rejected', 'cancelled', 'refunded');
create type public.ticket_status as enum ('valid', 'redeemed', 'cancelled', 'refunded');
create type public.audit_event_type as enum ('order_created', 'payment_confirmed', 'ticket_issued', 'ticket_redeemed', 'ticket_redeem_attempt', 'ticket_resent', 'complimentary_created', 'ticket_cancelled', 'refund');
create domain public.minor_units as bigint check (value between 0 and 9007199254740991);
create domain public.currency_code as text check (value ~ '^[A-Z]{3}$');
create domain public.slug as text check (length(value) <= 120 and value ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- Only bounded, non-free-text operational metadata. No provider payloads or PII.
create function private.safe_metadata(value jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(value) = 'object' and pg_column_size(value) <= 2048
    and not exists (select 1 from jsonb_each(value) e where
      e.key not in ('source', 'reason_code', 'correlation_id', 'demo')
      or jsonb_typeof(e.value) not in ('string', 'boolean')
      or length(e.value #>> '{}') > 128);
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text check (length(full_name) between 1 and 200),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.organizations (
  id uuid primary key default gen_random_uuid(), name text not null check (length(name) between 1 and 200),
  slug public.slug not null unique,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.organization_members (
  organization_id uuid not null references public.organizations(id),
  user_id uuid not null references public.profiles(id), role public.member_role not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index organization_members_user_idx on public.organization_members(user_id, organization_id);
create table public.locations (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  name text not null check (length(name) between 1 and 200), slug public.slug not null,
  address text, timezone text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (organization_id, id), unique (organization_id, slug)
);
create table public.events (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  location_id uuid not null, name text not null check (length(name) between 1 and 200), slug public.slug not null,
  description text, starts_at timestamptz not null, ends_at timestamptz not null, timezone text not null,
  status public.event_status not null default 'draft', sales_start timestamptz, sales_end timestamptz,
  capacity integer check (capacity >= 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (organization_id, id), unique (organization_id, slug),
  foreign key (organization_id, location_id) references public.locations(organization_id, id),
  check (ends_at > starts_at), check (sales_end is null or sales_start is null or sales_end >= sales_start),
  check (sales_end is null or sales_end <= ends_at)
);
create index events_location_idx on public.events(organization_id, location_id);
create table public.ticket_types (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, event_id uuid not null,
  name text not null check (length(name) between 1 and 200), description text,
  price public.minor_units not null, currency public.currency_code not null,
  capacity integer not null check (capacity >= 0), sales_start timestamptz, sales_end timestamptz,
  status public.ticket_type_status not null default 'draft', sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (organization_id, id, event_id, currency),
  foreign key (organization_id, event_id) references public.events(organization_id, id),
  check (sales_end is null or sales_start is null or sales_end >= sales_start)
);
create index ticket_types_event_idx on public.ticket_types(organization_id, event_id, sort_order);
create table public.customers (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  full_name text not null check (length(full_name) between 1 and 200),
  email text not null check (email = lower(btrim(email)) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  phone text check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (organization_id, id), unique (organization_id, email)
);
create index customers_phone_idx on public.customers(organization_id, phone) where phone is not null;
create table public.orders (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, event_id uuid not null,
  customer_id uuid not null, public_code text not null unique check (public_code ~ '^ORD_[a-f0-9]{32}$'),
  status public.order_status not null default 'draft', currency public.currency_code not null,
  subtotal public.minor_units not null default 0, total public.minor_units not null default 0,
  reserved_until timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (organization_id, id, event_id, currency), unique (organization_id, id, currency),
  foreign key (organization_id, event_id) references public.events(organization_id, id),
  foreign key (organization_id, customer_id) references public.customers(organization_id, id),
  check (total = subtotal),
  check (reserved_until is null or reserved_until > created_at),
  check (status <> 'pending_payment' or reserved_until is not null)
);
create index orders_event_status_idx on public.orders(organization_id, event_id, status);
create index orders_customer_idx on public.orders(organization_id, customer_id);
create table public.order_items (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, order_id uuid not null,
  event_id uuid not null, currency public.currency_code not null, ticket_type_id uuid not null,
  quantity integer not null check (quantity > 0), unit_price public.minor_units not null,
  subtotal public.minor_units not null, created_at timestamptz not null default now(),
  unique (organization_id, id, order_id, event_id, ticket_type_id),
  foreign key (organization_id, order_id, event_id, currency) references public.orders(organization_id, id, event_id, currency),
  foreign key (organization_id, ticket_type_id, event_id, currency) references public.ticket_types(organization_id, id, event_id, currency),
  check (subtotal::numeric = quantity::numeric * unit_price::numeric)
);
create index order_items_order_idx on public.order_items(organization_id, order_id);
create index order_items_type_idx on public.order_items(organization_id, ticket_type_id, event_id, currency);
create table public.payments (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, order_id uuid not null,
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{0,39}$'), provider_payment_id text,
  method text check (method ~ '^[a-z][a-z0-9_]{0,39}$'), status public.payment_status not null default 'pending',
  amount public.minor_units not null, currency public.currency_code not null,
  metadata jsonb not null default '{}' check (private.safe_metadata(metadata)),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (organization_id, order_id, currency) references public.orders(organization_id, id, currency),
  unique (organization_id, provider, provider_payment_id)
);
create index payments_order_provider_idx on public.payments(organization_id, order_id, provider);
create table public.tickets (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, event_id uuid not null,
  order_id uuid not null, order_item_id uuid not null, ticket_type_id uuid not null,
  public_code text not null unique check (public_code ~ '^TKT_[a-f0-9]{32}$'),
  secure_token_hash text not null unique check (secure_token_hash ~ '^[a-f0-9]{64}$'),
  status public.ticket_status not null default 'valid', issued_at timestamptz not null default now(), redeemed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (organization_id, id, event_id),
  foreign key (organization_id, order_item_id, order_id, event_id, ticket_type_id)
    references public.order_items(organization_id, id, order_id, event_id, ticket_type_id),
  check (status <> 'redeemed' or redeemed_at is not null),
  check (status <> 'valid' or redeemed_at is null), check (redeemed_at is null or redeemed_at >= issued_at)
);
create index tickets_event_status_idx on public.tickets(organization_id, event_id, status);
create index tickets_item_idx on public.tickets(organization_id, order_item_id, order_id, event_id, ticket_type_id);
create table public.check_ins (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, event_id uuid not null, ticket_id uuid not null,
  checked_in_by uuid not null, checked_in_at timestamptz not null default now(), gate text check (length(gate) <= 100),
  metadata jsonb not null default '{}' check (private.safe_metadata(metadata)),
  foreign key (organization_id, ticket_id, event_id) references public.tickets(organization_id, id, event_id),
  foreign key (organization_id, checked_in_by) references public.organization_members(organization_id, user_id),
  unique (ticket_id)
);
create index check_ins_event_ticket_idx on public.check_ins(organization_id, event_id, ticket_id);
create index check_ins_actor_idx on public.check_ins(organization_id, checked_in_by);
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  actor_user_id uuid references public.profiles(id), event_type public.audit_event_type not null,
  entity_type text not null check (entity_type in ('order', 'payment', 'ticket', 'check_in')),
  entity_id uuid not null, metadata jsonb not null default '{}' check (private.safe_metadata(metadata)),
  created_at timestamptz not null default now()
);
create index audit_logs_org_time_idx on public.audit_logs(organization_id, created_at desc);
create index audit_logs_actor_idx on public.audit_logs(actor_user_id) where actor_user_id is not null;
