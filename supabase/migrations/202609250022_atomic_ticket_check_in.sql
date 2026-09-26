create function public.check_in_ticket(
  p_organization_id uuid,
  p_event_id uuid,
  p_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  token_hash text;
  ticket_row public.tickets%rowtype;
  order_status public.order_status;
  existing_at timestamptz;
  accepted_at timestamptz := clock_timestamp();
  check_in_id uuid;
begin
  if actor is null or p_organization_id is null or p_event_id is null then
    return jsonb_build_object('result','unauthorized');
  end if;
  if not private.has_org_role(p_organization_id,array['owner','manager','door']::public.member_role[]) then
    return jsonb_build_object('result','unauthorized');
  end if;
  if p_token is null or length(p_token) not between 20 and 300 or p_token !~ '^fst1_[A-Za-z0-9_-]+$' then
    return jsonb_build_object('result','invalid');
  end if;

  token_hash := encode(sha256(convert_to(p_token,'UTF8')),'hex');
  select * into ticket_row
  from public.tickets
  where secure_token_hash=token_hash
  for update;

  if not found then return jsonb_build_object('result','invalid'); end if;
  if ticket_row.organization_id<>p_organization_id or ticket_row.event_id<>p_event_id then
    return jsonb_build_object('result','wrong_event');
  end if;

  select checked_in_at into existing_at from public.check_ins where ticket_id=ticket_row.id;
  if found then
    return jsonb_build_object('result','already_checked_in','checked_in_at',existing_at);
  end if;
  if ticket_row.status<>'valid' then
    return jsonb_build_object('result','unavailable');
  end if;
  select status into order_status from public.orders
  where id=ticket_row.order_id and organization_id=p_organization_id and event_id=p_event_id;
  if order_status is distinct from 'paid'::public.order_status then
    return jsonb_build_object('result','unavailable');
  end if;

  insert into public.check_ins(organization_id,event_id,ticket_id,checked_in_by,checked_in_at,metadata)
  values(p_organization_id,p_event_id,ticket_row.id,actor,accepted_at,'{"source":"scanner"}'::jsonb)
  returning id into check_in_id;
  update public.tickets set status='redeemed',redeemed_at=accepted_at where id=ticket_row.id;
  insert into public.audit_logs(organization_id,actor_user_id,event_type,entity_type,entity_id,metadata)
  values(p_organization_id,actor,'ticket_redeemed','check_in',check_in_id,'{"source":"scanner"}'::jsonb);

  return jsonb_build_object('result','accepted','checked_in_at',accepted_at);
end;
$$;

revoke all on function public.check_in_ticket(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.check_in_ticket(uuid,uuid,text) to authenticated;
