-- Запитвания: статуси, бележки, снимка на апартамента към момента на запитването, защита от спам.
-- Приложена в Supabase като „leads_inbox“.
alter table public.leads
  add column notes text,
  add column snapshot jsonb not null default '{}'::jsonb,
  add column ip_hash text,
  add column user_agent text,
  add column handled_by uuid references auth.users(id) on delete set null,
  add column updated_at timestamptz not null default now();
alter table public.leads drop constraint if exists leads_stage_check;
update public.leads set stage = 'new' where stage not in ('new','contacted','viewing','closed','spam');
alter table public.leads add constraint leads_stage_check check (stage in ('new','contacted','viewing','closed','spam'));
create index if not exists leads_building_created_idx on public.leads (building_id, created_at desc);
create index if not exists leads_ip_recent_idx on public.leads (ip_hash, created_at desc);

create or replace function private.touch_lead() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); new.handled_by := coalesce(auth.uid(), new.handled_by); return new; end $$;
drop trigger if exists leads_touch on public.leads;
create trigger leads_touch before update on public.leads for each row execute function private.touch_lead();

drop policy if exists leads_owner_delete on public.leads;
create policy leads_owner_delete on public.leads for delete to authenticated
  using (private.is_org_member(private.building_org(building_id), array['owner']));

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'leads') then
    alter publication supabase_realtime add table public.leads;
  end if;
end $$;

-- Единственият вход за запитвания от сайта. Извиква се от /api/inquiry с публичния ключ.
-- Проверява данните, ограничава до 5 запитвания на 10 минути от един адрес, пропуска повторно натискане
-- и връща кой трябва да получи имейл.
create or replace function public.submit_lead(
  p_building text, p_apartment text, p_name text, p_phone text, p_email text, p_message text,
  p_consent boolean, p_consent_text text, p_page_uri text, p_placement text,
  p_ip_hash text, p_user_agent text, p_utm jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  b record; a record; v_id uuid; v_recent int; v_dupe uuid; v_emails jsonb; v_snapshot jsonb;
begin
  if coalesce(p_consent, false) is not true then raise exception 'consent_required'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'missing_name'; end if;
  if coalesce(p_phone, '') !~ '^[+\d][\d\s()-]{6,}$' then raise exception 'invalid_phone'; end if;
  if nullif(trim(coalesce(p_email, '')), '') is not null and p_email !~ '^\S+@\S+\.\S+$' then raise exception 'invalid_email'; end if;

  select bb.id, bb.name, bb.slug, bb.org_id, bb.settings, o.name as org_name into b
  from public.buildings bb join public.organizations o on o.id = bb.org_id
  where bb.slug = p_building and bb.published;
  if b.id is null then raise exception 'unknown_building'; end if;

  if p_ip_hash is not null then
    select count(*) into v_recent from public.leads where ip_hash = p_ip_hash and created_at > now() - interval '10 minutes';
    if v_recent >= 5 then raise exception 'rate_limited'; end if;
  end if;

  select ap.id, ap.label, ap.code, ap.rooms, ap.gross_area, ap.status, f.number as floor, s.name as section_name,
         (select count(*) > 1 from public.sections where building_id = b.id) as multi
  into a
  from public.apartments ap join public.floors f on f.id = ap.floor_id join public.sections s on s.id = f.section_id
  where ap.building_id = b.id and ap.code = p_apartment;

  select id into v_dupe from public.leads
  where building_id = b.id and apartment_id is not distinct from a.id and phone = trim(p_phone) and created_at > now() - interval '2 minutes'
  order by created_at desc limit 1;

  v_snapshot := case when a.id is null then '{}'::jsonb else jsonb_build_object(
    'label', a.label, 'code', a.code, 'floor', a.floor, 'section', case when a.multi then a.section_name end,
    'rooms', a.rooms, 'gross', a.gross_area, 'status', a.status) end;

  if v_dupe is null then
    insert into public.leads (building_id, apartment_id, name, phone, email, message, consent, consent_text, page_uri, placement, utm, stage, snapshot, ip_hash, user_agent)
    values (b.id, a.id, left(trim(p_name), 200), left(trim(p_phone), 40), nullif(left(trim(coalesce(p_email, '')), 200), ''),
            nullif(left(trim(coalesce(p_message, '')), 2000), ''), true, left(p_consent_text, 500), left(p_page_uri, 500),
            left(p_placement, 40), p_utm, 'new', v_snapshot, p_ip_hash, left(p_user_agent, 300))
    returning id into v_id;
  else
    v_id := v_dupe;
  end if;

  v_emails := b.settings->'leads'->'emails';
  if v_emails is null or jsonb_typeof(v_emails) <> 'array' or jsonb_array_length(v_emails) = 0 then
    select coalesce(jsonb_agg(u.email), '[]'::jsonb) into v_emails
    from public.org_members m join auth.users u on u.id = m.user_id where m.org_id = b.org_id and m.role = 'owner';
  end if;

  return jsonb_build_object('id', v_id, 'duplicate', v_dupe is not null, 'building', b.name, 'org', b.org_name,
    'apartment', v_snapshot, 'recipients', v_emails);
end $$;
revoke all on function public.submit_lead(text, text, text, text, text, text, boolean, text, text, text, text, text, jsonb) from public;
grant execute on function public.submit_lead(text, text, text, text, text, text, boolean, text, text, text, text, text, jsonb) to anon, authenticated;

create or replace function public.new_leads_count() returns int
language sql stable security invoker set search_path = '' as $$
  select count(*)::int from public.leads where stage = 'new';
$$;
grant execute on function public.new_leads_count() to authenticated;
