create function private.touch_and_lock_identity() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (to_jsonb(new)->'id') is distinct from (to_jsonb(old)->'id')
    or (to_jsonb(new)->'organization_id') is distinct from (to_jsonb(old)->'organization_id')
    or (to_jsonb(new)->'user_id') is distinct from (to_jsonb(old)->'user_id')
    or (to_jsonb(new)->'created_at') is distinct from (to_jsonb(old)->'created_at') then
    raise exception 'Identity and tenancy are immutable' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
do $$ declare t text; begin
  foreach t in array array['profiles','organizations','organization_members','locations','events','ticket_types','customers','orders','payments','tickets'] loop
    execute format('create trigger lock_identity before update on public.%I for each row execute function private.touch_and_lock_identity()', t);
  end loop;
end $$;

create function private.validate_timezone() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'Invalid IANA timezone' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger location_timezone before insert or update on public.locations for each row execute function private.validate_timezone();
create trigger event_timezone before insert or update on public.events for each row execute function private.validate_timezone();

create function private.create_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id) values (new.id);
  return new;
end;
$$;
create trigger auth_user_profile after insert on auth.users for each row execute function private.create_profile();

create function private.guard_order() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then raise exception 'Orders start as draft' using errcode = '23514'; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Orders are historical; cancel instead' using errcode = '23514';
  end if;
  if old.status <> 'draft' and
    (new.currency, new.subtotal, new.total, new.customer_id, new.event_id, new.public_code, new.reserved_until)
      is distinct from
    (old.currency, old.subtotal, old.total, old.customer_id, old.event_id, old.public_code, old.reserved_until) then
    raise exception 'Order snapshot is immutable' using errcode = '23514';
  end if;
  if new.status <> old.status and not (
    (old.status = 'draft' and new.status in ('pending_payment', 'cancelled')) or
    (old.status = 'pending_payment' and new.status in ('paid', 'expired', 'cancelled')) or
    (old.status = 'paid' and new.status = 'refunded')
  ) then raise exception 'Invalid order transition' using errcode = '23514'; end if;
  return new;
end;
$$;
create trigger order_guard before insert or update or delete on public.orders for each row execute function private.guard_order();

create function private.guard_item() returns trigger
language plpgsql set search_path = '' as $$
declare parent_status public.order_status;
begin
  if tg_op = 'UPDATE' and
    (new.id, new.organization_id, new.order_id, new.event_id, new.ticket_type_id, new.currency, new.created_at)
      is distinct from
    (old.id, old.organization_id, old.order_id, old.event_id, old.ticket_type_id, old.currency, old.created_at) then
    raise exception 'Item identity is immutable' using errcode = '23514';
  end if;
  select status into parent_status from public.orders
    where id = case when tg_op = 'DELETE' then old.order_id else new.order_id end for update;
  if parent_status <> 'draft' then raise exception 'Order items are frozen' using errcode = '23514'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger item_guard before insert or update or delete on public.order_items for each row execute function private.guard_item();

-- Deferred checks allow a transaction to insert items and set the order total together.
create function private.check_order_total() returns trigger
language plpgsql set search_path = '' as $$
declare target uuid; expected bigint; actual numeric; item_count bigint; state public.order_status;
begin
  if tg_table_name = 'orders' then target := new.id;
  elsif tg_op = 'DELETE' then target := old.order_id;
  else target := new.order_id; end if;
  select subtotal, status into expected, state from public.orders where id = target;
  select coalesce(sum(subtotal), 0), count(*) into actual, item_count from public.order_items where order_id = target;
  if expected <> actual or (state in ('pending_payment','paid','refunded') and item_count = 0) then
    raise exception 'Order totals must match item snapshots' using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger order_total_check after insert or update on public.orders
  deferrable initially deferred for each row execute function private.check_order_total();
create constraint trigger item_total_check after insert or update or delete on public.order_items
  deferrable initially deferred for each row execute function private.check_order_total();

create function private.reject_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'Append-only history' using errcode = '23514'; end;
$$;
create trigger audit_append_only before update or delete on public.audit_logs for each row execute function private.reject_mutation();
create trigger audit_no_truncate before truncate on public.audit_logs for each statement execute function private.reject_mutation();
create trigger check_in_append_only before update or delete on public.check_ins for each row execute function private.reject_mutation();

-- Freeze money and attribution on payments even for trusted writers.
create function private.guard_payment() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'Payments are historical' using errcode = '23514'; end if;
  if (new.order_id, new.amount, new.currency, new.provider, new.provider_payment_id)
    is distinct from (old.order_id, old.amount, old.currency, old.provider, old.provider_payment_id) then
    raise exception 'Payment snapshot is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger payment_guard before update or delete on public.payments for each row execute function private.guard_payment();
