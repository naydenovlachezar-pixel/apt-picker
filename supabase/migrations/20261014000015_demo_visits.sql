-- Проследяване на демо сайта с лични линкове (?ref=...). Само за кампанията, не за клиентите.
-- (приложено в Supabase на 14.10.2026 като demo_visits_tracking, demo_visits_admin_views, demo_visits_revoke_direct)
create table if not exists public.demo_visits (
  id bigint generated always as identity primary key,
  ref text not null,
  event text not null,
  detail text,
  session_id text,
  page text,
  referrer text,
  created_at timestamptz not null default now()
);
create index if not exists demo_visits_ref_idx on public.demo_visits (ref, created_at desc);
alter table public.demo_visits enable row level security;
revoke all on table public.demo_visits from anon, authenticated;

create or replace function public.track_demo_visit(
  p_ref text, p_event text, p_detail text default null, p_session text default null,
  p_page text default null, p_referrer text default null
) returns void
language plpgsql security definer set search_path = public
as $$
declare r text := lower(left(trim(coalesce(p_ref,'')), 40));
begin
  if r !~ '^[a-z0-9_-]{1,40}$' then return; end if;
  if p_event not in ('view','crm_open','picker_view','inquiry','scroll_picker') then return; end if;
  if p_session is not null and (select count(*) from demo_visits where session_id = left(p_session,64)) >= 60 then return; end if;
  insert into demo_visits(ref, event, detail, session_id, page, referrer)
  values (r, p_event, left(p_detail,200), left(p_session,64), left(p_page,300), left(p_referrer,300));
end $$;
revoke all on function public.track_demo_visit(text,text,text,text,text,text) from public;
grant execute on function public.track_demo_visit(text,text,text,text,text,text) to anon, authenticated;

create or replace function public.demo_visits_summary()
returns table(ref text, first_seen timestamptz, last_seen timestamptz, views int, sessions int, reached_picker boolean, inquiries int, last_inquiry text, referrer text)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_platform_admin() then raise exception 'Нямате достъп'; end if;
  return query
  select v.ref, min(v.created_at), max(v.created_at),
    count(*) filter (where v.event = 'view')::int,
    count(distinct v.session_id)::int,
    bool_or(v.event = 'picker_view'),
    count(*) filter (where v.event = 'inquiry')::int,
    (array_agg(v.detail order by v.created_at desc) filter (where v.event = 'inquiry'))[1],
    (array_agg(v.referrer order by v.created_at) filter (where v.referrer is not null and v.referrer <> ''))[1]
  from public.demo_visits v group by v.ref order by max(v.created_at) desc;
end $$;

create or replace function public.demo_visits_log(p_ref text, p_limit int default 100)
returns table(event text, detail text, session_id text, created_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_platform_admin() then raise exception 'Нямате достъп'; end if;
  return query
  select v.event, v.detail, v.session_id, v.created_at from public.demo_visits v
  where v.ref = lower(p_ref) order by v.created_at desc limit least(greatest(coalesce(p_limit,100),1),500);
end $$;

revoke all on function public.demo_visits_summary() from public, anon;
revoke all on function public.demo_visits_log(text,int) from public, anon;
grant execute on function public.demo_visits_summary() to authenticated;
grant execute on function public.demo_visits_log(text,int) to authenticated;
