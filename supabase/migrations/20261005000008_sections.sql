-- Входове (секции) на сградата: сграда → входове → етажи → апартаменти
-- Пълният текст на миграцията е приложен в Supabase като „sections_entrances“.
create table public.sections (
  id uuid primary key default gen_random_uuid(),
  building_id uuid not null references public.buildings(id) on delete cascade,
  key text not null check (key ~ '^[A-H]$'),
  name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (building_id, key)
);
create index sections_building_idx on public.sections(building_id);
alter table public.sections enable row level security;
create policy sections_public_read on public.sections for select to anon, authenticated using (private.is_published_building(building_id));
create policy sections_member_read on public.sections for select to authenticated using (private.is_org_member(private.building_org(building_id)));
create policy sections_member_all on public.sections for all to authenticated
  using (private.is_org_member(private.building_org(building_id), array['owner','editor']))
  with check (private.is_org_member(private.building_org(building_id), array['owner','editor']));

insert into public.sections (building_id, key, name, sort_order)
select id, 'A', 'Вход А', 0 from public.buildings;

alter table public.floors add column section_id uuid references public.sections(id) on delete cascade;
update public.floors f set section_id = s.id from public.sections s where s.building_id = f.building_id and s.key = 'A';
alter table public.floors alter column section_id set not null;
alter table public.floors drop constraint floors_building_id_number_key;
alter table public.floors add constraint floors_section_number_key unique (section_id, number);
create index floors_section_idx on public.floors(section_id);

create or replace function private.on_building_created() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.sections (building_id, key, name, sort_order) values (new.id, 'A', 'Вход А', 0) on conflict do nothing;
  return new;
end $$;
revoke all on function private.on_building_created() from public, anon, authenticated;
create trigger buildings_default_section after insert on public.buildings for each row execute function private.on_building_created();

create or replace function public.get_public_building(p_slug text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', b.slug, 'uuid', b.id, 'name', b.name, 'short', b.short_name, 'district', b.district,
    'stage', b.stage, 'ready', b.ready_text, 'desc', b.description, 'facade', b.facade,
    'settings', b.settings - 'leads', 'updated_at', b.updated_at,
    'sections', coalesce((
      select jsonb_agg(jsonb_build_object('key', s.key, 'name', s.name) order by s.sort_order, s.key)
      from public.sections s where s.building_id = b.id), '[]'::jsonb),
    'layouts', coalesce((
      select jsonb_object_agg(l.key, l.plan || jsonb_build_object('image_url', l.image_url))
      from public.layouts l where l.building_id = b.id), '{}'::jsonb),
    'floors', coalesce((
      select jsonb_agg(jsonb_build_object(
        's', s.key, 'n', f.number, 'label', f.label,
        'layout', (select l.key from public.layouts l where l.id = f.layout_id),
        'polygon', f.facade_polygon) order by s.sort_order, s.key, f.number)
      from public.floors f join public.sections s on s.id = f.section_id where f.building_id = b.id), '[]'::jsonb),
    'apartments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.code, 'label', a.label, 'section', s.key, 'floor', f.number, 'unit', a.unit_key,
        'rooms', a.rooms, 'net', a.net_area, 'gross', a.gross_area,
        'outdoor', a.outdoor_area, 'outdoor_kind', a.outdoor_kind, 'exposure', a.exposure,
        'price', case when a.price_visible and a.status <> 'sold' then a.price end,
        'currency', a.currency, 'status', a.status, 'pdf_url', a.pdf_url
      ) order by s.sort_order, s.key, f.number, a.unit_key)
      from public.apartments a join public.floors f on f.id = a.floor_id join public.sections s on s.id = f.section_id
      where a.building_id = b.id), '[]'::jsonb)
  )
  from public.buildings b
  where b.slug = p_slug and b.published;
$$;

create or replace function public.save_facade(p_building uuid, p_facade jsonb, p_floors jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_floors int := 0;
  v_ok int;
  v_first text;
begin
  if p_facade is not null then
    if not (p_facade ? 'image_url' and p_facade ? 'w' and p_facade ? 'h') then
      raise exception 'Фасадата трябва да има image_url, w и h';
    end if;
    update public.buildings set facade = jsonb_build_object('image_url', p_facade->>'image_url', 'w', (p_facade->>'w')::int, 'h', (p_facade->>'h')::int)
    where id = p_building;
    get diagnostics v_ok = row_count;
    if v_ok = 0 then raise exception 'Нямате права да променяте тази сграда'; end if;
  end if;

  select key into v_first from public.sections where building_id = p_building order by sort_order, key limit 1;

  with src as (
    select coalesce(f->>'s', v_first) as s, (f->>'n')::int as n, f->'polygon' as polygon
    from jsonb_array_elements(coalesce(p_floors, '[]'::jsonb)) f
  ), upd as (
    update public.floors fl set facade_polygon = src.polygon
    from src join public.sections s on s.building_id = p_building and s.key = src.s
    where fl.section_id = s.id and fl.number = src.n
      and jsonb_typeof(src.polygon->'t') = 'array' and jsonb_typeof(src.polygon->'b') = 'array'
      and jsonb_array_length(src.polygon->'t') >= 2 and jsonb_array_length(src.polygon->'b') >= 2
    returning fl.id
  )
  select count(*) into v_floors from upd;

  update public.buildings set updated_at = now() where id = p_building;
  return jsonb_build_object('floors', v_floors);
end $$;

create or replace function public.add_section(p_building uuid, p_name text, p_floors int, p_layout text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  lat text[] := array['A','B','C','D','E','F','G','H'];
  cyr text[] := array['А','Б','В','Г','Д','Е','Ж','З'];
  v_key text; v_cyr text; v_sid uuid; v_lid uuid; v_plan jsonb; v_count int; v_fid uuid;
  v_first uuid; v_first_cyr text; v_apts int := 0; v_rows int;
begin
  if p_floors is null or p_floors < 1 or p_floors > 60 then raise exception 'Броят етажи трябва да е между 1 и 60'; end if;
  select l.id, l.plan into v_lid, v_plan from public.layouts l where l.building_id = p_building and l.key = p_layout;
  if v_lid is null then raise exception 'Няма такова разпределение в сградата'; end if;

  select count(*) into v_count from public.sections where building_id = p_building;
  if v_count >= 8 then raise exception 'Една сграда може да има най-много 8 входа'; end if;

  select lat[i], cyr[i] into v_key, v_cyr
  from generate_subscripts(lat, 1) i
  where lat[i] not in (select key from public.sections where building_id = p_building)
  order by i limit 1;

  insert into public.sections (building_id, key, name, sort_order)
  values (p_building, v_key, coalesce(nullif(trim(p_name), ''), 'Вход ' || v_cyr), v_count)
  returning id into v_sid;

  perform set_config('app.status_source', 'admin', true);
  for n in 1..p_floors loop
    insert into public.floors (building_id, section_id, number, layout_id) values (p_building, v_sid, n, v_lid) returning id into v_fid;
    insert into public.apartments (building_id, floor_id, unit_key, code, label, rooms, net_area, gross_area, exposure, price, price_visible, status)
    select p_building, v_fid, u.key, v_key || '-' || n || u.key, v_cyr || '-' || n || coalesce(u.value->>'label', u.key),
           least(greatest(coalesce((u.value->>'rooms')::int, 1), 1), 10), (u.value->>'net')::numeric, coalesce((u.value->>'gross')::numeric, 0),
           u.value->>'exposure', null, true, 'free'
    from jsonb_each(v_plan->'units') u;
    get diagnostics v_rows = row_count;
    v_apts := v_apts + v_rows;
  end loop;

  if v_count = 1 then
    select s.id, cyr[array_position(lat, s.key)] into v_first, v_first_cyr
    from public.sections s where s.building_id = p_building and s.id <> v_sid order by s.sort_order, s.key limit 1;
    update public.apartments a set label = v_first_cyr || '-' || a.label
    from public.floors f where f.id = a.floor_id and f.section_id = v_first and a.label !~ '^[А-З]-';
  end if;

  update public.buildings set updated_at = now() where id = p_building;
  return jsonb_build_object('id', v_sid, 'key', v_key, 'name', coalesce(nullif(trim(p_name), ''), 'Вход ' || v_cyr), 'floors', p_floors, 'apartments', v_apts);
end $$;
revoke all on function public.add_section(uuid, text, int, text) from public, anon;
grant execute on function public.add_section(uuid, text, int, text) to authenticated;

create or replace function public.delete_section(p_section uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_building uuid; v_left int; v_rows int;
begin
  select building_id into v_building from public.sections where id = p_section;
  if v_building is null then raise exception 'Входът не съществува или нямате достъп до него'; end if;
  select count(*) into v_left from public.sections where building_id = v_building;
  if v_left <= 1 then raise exception 'Сградата трябва да има поне един вход'; end if;
  delete from public.sections where id = p_section;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then raise exception 'Нямате права да изтриете този вход'; end if;
  update public.buildings set updated_at = now() where id = v_building;
  return jsonb_build_object('deleted', true);
end $$;
revoke all on function public.delete_section(uuid) from public, anon;
grant execute on function public.delete_section(uuid) to authenticated;
