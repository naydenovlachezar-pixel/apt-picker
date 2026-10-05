-- Покани: имейл → организация и роля. При първия вход с този имейл потребителят автоматично става член.
create table public.org_invites (
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text not null check (email = lower(email)),
  role text not null default 'editor' check (role in ('owner','editor','viewer')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (org_id, email)
);
alter table public.org_invites enable row level security;
create policy invites_owner_all on public.org_invites for all to authenticated
  using (private.is_org_member(org_id, array['owner']))
  with check (private.is_org_member(org_id, array['owner']));

create or replace function private.accept_invites(p_user uuid, p_email text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.org_members (org_id, user_id, role)
  select i.org_id, p_user, i.role from public.org_invites i
  where i.email = lower(p_email) and i.accepted_at is null
  on conflict (org_id, user_id) do update set role = excluded.role;
  update public.org_invites set accepted_at = now()
  where email = lower(p_email) and accepted_at is null;
end $$;

create or replace function private.on_auth_user_created() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email is not null then perform private.accept_invites(new.id, new.email); end if;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function private.on_auth_user_created();

revoke all on function private.accept_invites(uuid, text) from public, anon, authenticated;
revoke all on function private.on_auth_user_created() from public, anon, authenticated;

-- Данни за панела: организациите на текущия потребител с ролята му
create or replace function public.my_orgs()
returns table (id uuid, slug text, name text, role text)
language sql stable security definer set search_path = '' as $$
  select o.id, o.slug, o.name, m.role
  from public.org_members m join public.organizations o on o.id = m.org_id
  where m.user_id = auth.uid()
  order by o.name;
$$;
revoke all on function public.my_orgs() from public, anon;
grant execute on function public.my_orgs() to authenticated;

-- Поканата за собственика на демо организацията
insert into public.org_invites (org_id, email, role)
select id, 'naydenovlachezar@gmail.com', 'owner' from public.organizations where slug = 'liniya-demo'
on conflict do nothing;

select private.accept_invites(u.id, u.email) from auth.users u where lower(u.email) = 'naydenovlachezar@gmail.com';
