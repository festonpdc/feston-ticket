-- Role is looked up from the database, never trusted from editable user metadata.
create function private.has_org_role(target uuid, allowed public.member_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.organization_members m
    where m.organization_id = target and m.user_id = (select auth.uid()) and m.role = any(allowed));
$$;
revoke all on all functions in schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;
grant execute on function private.has_org_role(uuid, public.member_role[]) to authenticated;
grant execute on function private.safe_metadata(jsonb) to authenticated, service_role;

do $$ declare t text; begin
  foreach t in array array['profiles','organizations','organization_members','locations','events','ticket_types','customers','orders','order_items','payments','tickets','check_ins','audit_logs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;
grant usage on schema public to anon, authenticated, service_role;

grant select on public.profiles to authenticated;
grant update (full_name) on public.profiles to authenticated;
create policy profile_self_read on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy profile_self_update on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

grant select on public.organizations to authenticated;
grant update (name, slug) on public.organizations to authenticated;
create policy org_read on public.organizations for select to authenticated
  using (private.has_org_role(id, array['owner','manager','door']::public.member_role[]));
create policy org_owner_update on public.organizations for update to authenticated
  using (private.has_org_role(id, array['owner']::public.member_role[]))
  with check (private.has_org_role(id, array['owner']::public.member_role[]));

grant select, insert, delete on public.organization_members to authenticated;
grant update (role) on public.organization_members to authenticated;
create policy members_read on public.organization_members for select to authenticated
  using (user_id = (select auth.uid()) or private.has_org_role(organization_id, array['owner','manager']::public.member_role[]));
create policy members_owner_insert on public.organization_members for insert to authenticated
  with check (private.has_org_role(organization_id, array['owner']::public.member_role[]));
create policy members_owner_update on public.organization_members for update to authenticated
  using (private.has_org_role(organization_id, array['owner']::public.member_role[]))
  with check (private.has_org_role(organization_id, array['owner']::public.member_role[]));
create policy members_owner_delete on public.organization_members for delete to authenticated
  using (private.has_org_role(organization_id, array['owner']::public.member_role[]));

do $$ declare t text; begin
  foreach t in array array['locations','events','ticket_types','customers'] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('create policy staff_read on public.%I for select to authenticated using (private.has_org_role(organization_id, array[''owner'',''manager'']::public.member_role[]))', t);
    execute format('create policy staff_insert on public.%I for insert to authenticated with check (private.has_org_role(organization_id, array[''owner'',''manager'']::public.member_role[]))', t);
    execute format('create policy staff_update on public.%I for update to authenticated using (private.has_org_role(organization_id, array[''owner'',''manager'']::public.member_role[])) with check (private.has_org_role(organization_id, array[''owner'',''manager'']::public.member_role[]))', t);
    execute format('create policy staff_delete on public.%I for delete to authenticated using (private.has_org_role(organization_id, array[''owner'',''manager'']::public.member_role[]))', t);
  end loop;
  -- Transactional writes require future authenticated server commands. Direct API
  -- clients cannot self-mark orders paid, issue tickets, or fabricate audit events.
  foreach t in array array['orders','order_items','payments','tickets','check_ins','audit_logs'] loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy staff_read on public.%I for select to authenticated using (private.has_org_role(organization_id, array[''owner'',''manager'']::public.member_role[]))', t);
  end loop;
end $$;
revoke update, delete on public.audit_logs from service_role;

-- Organization bootstrap is a trusted administrative operation, outside public API.
-- Avoid orphaning an existing organization by removing/demoting its last owner.
create function private.keep_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner') then
    perform 1 from public.organizations where id = old.organization_id for update;
    if not exists (select 1 from public.organization_members
      where organization_id = old.organization_id and role = 'owner' and user_id <> old.user_id) then
      raise exception 'Organization requires an owner' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.keep_owner() from public, anon, authenticated;
create trigger keep_owner before update or delete on public.organization_members for each row execute function private.keep_owner();
