-- Нова сграда от панела и брой етажи на вход. Приложена в Supabase като „create_building_and_floor_count“.
create unique index if not exists buildings_slug_unique on public.buildings (slug);

create or replace function private.slug_taken(p_slug text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.buildings where slug = p_slug);
$$;
revoke all on function private.slug_taken(text) from public, anon;
grant execute on function private.slug_taken(text) to authenticated;

create or replace function public.slug_available(p_slug text) returns boolean
language sql stable security invoker set search_path = '' as $$
  select p_slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$' and not private.slug_taken(p_slug);
$$;
revoke all on function public.slug_available(text) from public, anon;
grant execute on function public.slug_available(text) to authenticated;

create or replace function public.create_building(p_org uuid, p_name text, p_slug text, p_district text, p_stage text, p_ready text, p_desc text, p_floors int)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_id uuid; v_sec uuid; v_slug text := lower(trim(coalesce(p_slug, '')));
begin
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Въведете име на сградата'; end if;
  if v_slug !~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$' then
    raise exception 'Адресът може да съдържа само малки латински букви, цифри и тире, например rezidentsiya-lozenets';
  end if;
  if private.slug_taken(v_slug) then raise exception 'Адресът „%“ вече се ползва. Изберете друг.', v_slug; end if;
  if p_floors is null or p_floors < 1 or p_floors > 60 then raise exception 'Броят етажи трябва да е между 1 и 60'; end if;

  insert into public.buildings (org_id, slug, name, short_name, district, stage, ready_text, description, published, sort_order)
  values (p_org, v_slug, trim(p_name), trim(p_name), nullif(trim(coalesce(p_district, '')), ''), nullif(trim(coalesce(p_stage, '')), ''),
          nullif(trim(coalesce(p_ready, '')), ''), nullif(trim(coalesce(p_desc, '')), ''), false,
          coalesce((select max(sort_order) + 1 from public.buildings where org_id = p_org), 0))
  returning id into v_id;

  select id into v_sec from public.sections where building_id = v_id and key = 'A';
  insert into public.floors (building_id, section_id, number) select v_id, v_sec, n from generate_series(1, p_floors) n;

  return jsonb_build_object('id', v_id, 'slug', v_slug);
end $$;
revoke all on function public.create_building(uuid, text, text, text, text, text, text, int) from public, anon;
grant execute on function public.create_building(uuid, text, text, text, text, text, text, int) to authenticated;

create or replace function public.set_section_floors(p_building uuid, p_section text, p_count int)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_sec uuid; v_have int; v_top int; v_layout uuid; v_fid uuid; v_blocked text; v_added int := 0; v_removed int := 0;
begin
  if p_count is null or p_count < 1 or p_count > 60 then raise exception 'Броят етажи трябва да е между 1 и 60'; end if;
  select id into v_sec from public.sections where building_id = p_building and key = p_section;
  if v_sec is null then raise exception 'Няма такъв вход'; end if;
  select count(*), coalesce(max(number), 0) into v_have, v_top from public.floors where section_id = v_sec;

  if p_count > v_have then
    select layout_id into v_layout from public.floors where section_id = v_sec order by number desc limit 1;
    for n in (v_top + 1)..(v_top + p_count - v_have) loop
      insert into public.floors (building_id, section_id, number, layout_id) values (p_building, v_sec, n, v_layout) returning id into v_fid;
      if v_layout is not null then perform private.sync_floor_apartments(v_fid); end if;
      v_added := v_added + 1;
    end loop;
  elsif p_count < v_have then
    select string_agg(a.label, ', ' order by f.number, a.unit_key) into v_blocked
    from public.floors f join public.apartments a on a.floor_id = f.id
    where f.section_id = v_sec and a.status <> 'free'
      and f.id in (select id from public.floors where section_id = v_sec order by number desc limit v_have - p_count);
    if v_blocked is not null then
      raise exception 'Най-горните етажи имат резервирани или продадени апартаменти: %. Те не могат да се премахнат.', v_blocked;
    end if;
    delete from public.floors where id in (select id from public.floors where section_id = v_sec order by number desc limit v_have - p_count);
    get diagnostics v_removed = row_count;
    if v_removed = 0 then raise exception 'Нямате права да променяте тази сграда'; end if;
  end if;

  update public.buildings set updated_at = now() where id = p_building;
  return jsonb_build_object('floors', p_count, 'added', v_added, 'removed', v_removed);
end $$;
revoke all on function public.set_section_floors(uuid, text, int) from public, anon;
grant execute on function public.set_section_floors(uuid, text, int) to authenticated;
