-- Покани за екипа и за нови строители, собственик на платформата, регистрация само с покана.
-- Приложена в Supabase като „invites_and_platform_admin“.
-- След прилагане: Supabase → Authentication → Hooks → Before User Created → Postgres → public.hook_before_user_created
create table if not exists private.platform_admins (user_id uuid primary key references auth.users(id) on delete cascade, created_at timestamptz not null default now());
insert into private.platform_admins (user_id) select id from auth.users where lower(email) = 'naydenovlachezar@gmail.com' on conflict do nothing;

create or replace function private.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.platform_admins where user_id = auth.uid());
$$;
grant execute on function private.is_platform_admin() to authenticated;

create or replace function public.am_platform_admin() returns boolean
language sql stable security invoker set search_path = '' as $$ select private.is_platform_admin(); $$;
grant execute on function public.am_platform_admin() to authenticated;

create or replace function public.hook_before_user_created(event jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(coalesce(event->'user'->>'email', ''));
begin
  if v_email <> '' and exists (select 1 from public.org_invites where email = v_email and accepted_at is null) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object('http_code', 403,
    'message', 'Този имейл няма покана за панела. Помолете собственика на акаунта да ви покани.'));
end $$;
revoke all on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;

create or replace function private.invite(p_org uuid, p_email text, p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(trim(coalesce(p_email, ''))); v_user uuid;
begin
  if v_email !~ '^\S+@\S+\.\S+$' then raise exception 'Въведете имейл адрес, например ivan@firma.bg'; end if;
  if p_role not in ('owner','editor','viewer') then raise exception 'Непозната роля'; end if;
  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is not null then
    insert into public.org_members (org_id, user_id, role) values (p_org, v_user, p_role)
    on conflict (org_id, user_id) do update set role = excluded.role;
    insert into public.org_invites (org_id, email, role, invited_by, accepted_at) values (p_org, v_email, p_role, auth.uid(), now())
    on conflict (org_id, email) do update set role = excluded.role, accepted_at = now();
    return jsonb_build_object('status', 'added', 'email', v_email);
  end if;
  insert into public.org_invites (org_id, email, role, invited_by) values (p_org, v_email, p_role, auth.uid())
  on conflict (org_id, email) do update set role = excluded.role, invited_by = excluded.invited_by, accepted_at = null, created_at = now();
  return jsonb_build_object('status', 'invited', 'email', v_email);
end $$;
revoke all on function private.invite(uuid, text, text) from public, anon, authenticated;

create or replace function public.invite_member(p_org uuid, p_email text, p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not (private.is_org_member(p_org, array['owner']) or private.is_platform_admin()) then raise exception 'Само собственикът на акаунта може да кани хора'; end if;
  return private.invite(p_org, p_email, p_role);
end $$;
grant execute on function public.invite_member(uuid, text, text) to authenticated;

create or replace function public.org_team(p_org uuid)
returns table(kind text, user_id uuid, email text, role text, since timestamptz, is_me boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (private.is_org_member(p_org) or private.is_platform_admin()) then raise exception 'Нямате достъп'; end if;
  return query
    select 'member', m.user_id, u.email::text, m.role, m.created_at, m.user_id = auth.uid()
    from public.org_members m join auth.users u on u.id = m.user_id where m.org_id = p_org
    union all
    select 'invite', null, i.email, i.role, i.created_at, false
    from public.org_invites i where i.org_id = p_org and i.accepted_at is null
    order by 1, 4, 3;
end $$;
grant execute on function public.org_team(uuid) to authenticated;

create or replace function public.set_member_role(p_org uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (private.is_org_member(p_org, array['owner']) or private.is_platform_admin()) then raise exception 'Само собственикът може да сменя роли'; end if;
  if p_role not in ('owner','editor','viewer') then raise exception 'Непозната роля'; end if;
  if p_role <> 'owner' and (select count(*) from public.org_members where org_id = p_org and role = 'owner' and user_id <> p_user) = 0 then
    raise exception 'Акаунтът трябва да има поне един собственик';
  end if;
  update public.org_members set role = p_role where org_id = p_org and user_id = p_user;
end $$;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated;

create or replace function public.remove_member(p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (private.is_org_member(p_org, array['owner']) or private.is_platform_admin()) then raise exception 'Само собственикът може да маха хора'; end if;
  if (select count(*) from public.org_members where org_id = p_org and role = 'owner' and user_id <> p_user) = 0 then
    raise exception 'Акаунтът трябва да има поне един собственик';
  end if;
  delete from public.org_members where org_id = p_org and user_id = p_user;
end $$;
grant execute on function public.remove_member(uuid, uuid) to authenticated;

create or replace function public.revoke_invite(p_org uuid, p_email text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (private.is_org_member(p_org, array['owner']) or private.is_platform_admin()) then raise exception 'Само собственикът може да отменя покани'; end if;
  delete from public.org_invites where org_id = p_org and email = lower(p_email) and accepted_at is null;
end $$;
grant execute on function public.revoke_invite(uuid, text) to authenticated;

create or replace function public.admin_orgs()
returns table(id uuid, name text, slug text, created_at timestamptz, buildings int, published int, owners text, pending text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then raise exception 'Нямате достъп'; end if;
  return query
    select o.id, o.name, o.slug, o.created_at,
      (select count(*)::int from public.buildings b where b.org_id = o.id),
      (select count(*)::int from public.buildings b where b.org_id = o.id and b.published),
      (select string_agg(u.email::text, ', ') from public.org_members m join auth.users u on u.id = m.user_id where m.org_id = o.id and m.role = 'owner'),
      (select string_agg(i.email, ', ') from public.org_invites i where i.org_id = o.id and i.accepted_at is null and i.role = 'owner')
    from public.organizations o order by o.created_at desc;
end $$;
grant execute on function public.admin_orgs() to authenticated;

create or replace function public.admin_create_org(p_name text, p_slug text, p_owner_email text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_slug text := lower(trim(coalesce(p_slug, ''))); r jsonb;
begin
  if not private.is_platform_admin() then raise exception 'Нямате достъп'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Въведете името на строителя'; end if;
  if v_slug !~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$' then raise exception 'Краткото име може да съдържа само малки латински букви, цифри и тире'; end if;
  if exists (select 1 from public.organizations where slug = v_slug) then raise exception 'Строител с кратко име „%“ вече има', v_slug; end if;
  insert into public.organizations (slug, name) values (v_slug, trim(p_name)) returning id into v_id;
  r := private.invite(v_id, p_owner_email, 'owner');
  return jsonb_build_object('id', v_id, 'slug', v_slug, 'owner', r);
end $$;
grant execute on function public.admin_create_org(text, text, text) to authenticated;
