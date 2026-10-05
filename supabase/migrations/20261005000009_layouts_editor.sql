-- Разпределения с качен чертеж и синхронизация на апартаментите по етажи.
-- Приложена в Supabase като „layouts_editor_and_floor_sync“ и „grant_sync_floor_apartments“.

create or replace function private.sync_floor_apartments(p_floor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  lat text[] := array['A','B','C','D','E','F','G','H'];
  cyr text[] := array['А','Б','В','Г','Д','Е','Ж','З'];
  f record; v_units jsonb; v_multi boolean; v_code_pre text; v_label_pre text;
  v_blocked text; v_del int := 0; v_ins int := 0; v_upd int := 0;
begin
  select fl.id, fl.number, fl.building_id, fl.layout_id, s.key as skey into f
  from public.floors fl join public.sections s on s.id = fl.section_id where fl.id = p_floor;
  if f.id is null then raise exception 'Етажът не съществува'; end if;
  if not private.is_org_member(private.building_org(f.building_id), array['owner','editor']) then
    raise exception 'Нямате права да променяте тази сграда';
  end if;

  select coalesce(l.plan->'units', '{}'::jsonb) into v_units from public.layouts l where l.id = f.layout_id;
  v_units := coalesce(v_units, '{}'::jsonb);
  select count(*) > 1 into v_multi from public.sections where building_id = f.building_id;
  v_code_pre := case when f.skey = 'A' then '' else f.skey || '-' end;
  v_label_pre := case when v_multi then cyr[array_position(lat, f.skey)] || '-' else '' end;

  select string_agg(a.label || ' (' || case a.status when 'reserved' then 'резервиран' else 'продаден' end || ')', ', ' order by a.unit_key)
  into v_blocked
  from public.apartments a
  where a.floor_id = p_floor and a.status <> 'free' and not (v_units ? a.unit_key);
  if v_blocked is not null then
    raise exception 'Етаж % ще загуби апартаменти, които не са свободни: %. Сменете статуса им или ги добавете в разпределението.', f.number, v_blocked;
  end if;

  perform set_config('app.status_source', 'admin', true);

  delete from public.apartments a where a.floor_id = p_floor and not (v_units ? a.unit_key);
  get diagnostics v_del = row_count;

  update public.apartments a set
    label = v_label_pre || f.number || coalesce(nullif(u.value->>'label', ''), u.key),
    rooms = least(greatest(coalesce((u.value->>'rooms')::int, a.rooms), 1), 10),
    net_area = coalesce((u.value->>'net')::numeric, a.net_area),
    gross_area = coalesce((u.value->>'gross')::numeric, a.gross_area),
    outdoor_area = coalesce((u.value->>'outdoor')::numeric, a.outdoor_area),
    exposure = coalesce(nullif(u.value->>'exposure', ''), a.exposure)
  from jsonb_each(v_units) u
  where a.floor_id = p_floor and a.unit_key = u.key
    and (a.label, a.rooms, a.net_area, a.gross_area, a.outdoor_area, a.exposure) is distinct from
        (v_label_pre || f.number || coalesce(nullif(u.value->>'label', ''), u.key),
         least(greatest(coalesce((u.value->>'rooms')::int, a.rooms), 1), 10),
         coalesce((u.value->>'net')::numeric, a.net_area), coalesce((u.value->>'gross')::numeric, a.gross_area),
         coalesce((u.value->>'outdoor')::numeric, a.outdoor_area), coalesce(nullif(u.value->>'exposure', ''), a.exposure));
  get diagnostics v_upd = row_count;

  insert into public.apartments (building_id, floor_id, unit_key, code, label, rooms, net_area, gross_area, outdoor_area, exposure, price, price_visible, status)
  select f.building_id, p_floor, u.key, v_code_pre || f.number || u.key,
         v_label_pre || f.number || coalesce(nullif(u.value->>'label', ''), u.key),
         least(greatest(coalesce((u.value->>'rooms')::int, 1), 1), 10), (u.value->>'net')::numeric,
         coalesce((u.value->>'gross')::numeric, 0), coalesce((u.value->>'outdoor')::numeric, 0), nullif(u.value->>'exposure', ''),
         null, true, 'free'
  from jsonb_each(v_units) u
  where not exists (select 1 from public.apartments a where a.floor_id = p_floor and a.unit_key = u.key);
  get diagnostics v_ins = row_count;

  return jsonb_build_object('added', v_ins, 'updated', v_upd, 'removed', v_del);
end $$;
revoke all on function private.sync_floor_apartments(uuid) from public, anon;
grant execute on function private.sync_floor_apartments(uuid) to authenticated;

create or replace function public.save_layout(p_building uuid, p_key text, p_name text, p_image_url text, p_w int, p_h int, p_units jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_key text := nullif(trim(coalesce(p_key, '')), '');
  v_bad text; v_id uuid; fl record; r jsonb;
  v_add int := 0; v_upd int := 0; v_del int := 0; v_floors int := 0;
begin
  if p_units is null or jsonb_typeof(p_units) <> 'object' then raise exception 'Липсват апартаменти в разпределението'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Дайте име на разпределението'; end if;
  if p_image_url is null or p_w is null or p_h is null or p_w < 1 or p_h < 1 then raise exception 'Качете чертеж на етажа'; end if;

  select string_agg(coalesce(nullif(u.value->>'label', ''), u.key), ', ') into v_bad
  from jsonb_each(p_units) u
  where u.key !~ '^[A-Z0-9]{1,4}$'
     or nullif(u.value->>'label', '') is null
     or coalesce((u.value->>'rooms')::int, 0) not between 1 and 10
     or coalesce((u.value->>'gross')::numeric, 0) <= 0
     or jsonb_typeof(u.value->'pts') <> 'array' or jsonb_array_length(u.value->'pts') < 3;
  if v_bad is not null then raise exception 'Непълни данни за апартамент: %. Нужни са номер, стаи, обща площ и контур с поне 3 точки.', v_bad; end if;

  if v_key is null then
    select 'L' || (coalesce(max(substring(key from '^L(\d+)$')::int), 0) + 1) into v_key
    from public.layouts where building_id = p_building;
  end if;

  insert into public.layouts (building_id, key, name, image_url, plan)
  values (p_building, v_key, trim(p_name), p_image_url, jsonb_build_object('kind', 'image', 'w', p_w, 'h', p_h, 'units', p_units))
  on conflict (building_id, key) do update
    set name = excluded.name, image_url = excluded.image_url, plan = excluded.plan, updated_at = now()
  returning id into v_id;
  if v_id is null then raise exception 'Нямате права да променяте тази сграда'; end if;

  for fl in select id from public.floors where layout_id = v_id loop
    r := private.sync_floor_apartments(fl.id);
    v_add := v_add + (r->>'added')::int; v_upd := v_upd + (r->>'updated')::int; v_del := v_del + (r->>'removed')::int; v_floors := v_floors + 1;
  end loop;

  update public.buildings set updated_at = now() where id = p_building;
  return jsonb_build_object('key', v_key, 'floors', v_floors, 'added', v_add, 'updated', v_upd, 'removed', v_del);
end $$;
revoke all on function public.save_layout(uuid, text, text, text, int, int, jsonb) from public, anon;
grant execute on function public.save_layout(uuid, text, text, text, int, int, jsonb) to authenticated;

create or replace function public.assign_layout(p_building uuid, p_section text, p_floors int[], p_layout text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_lid uuid; fl record; r jsonb; v_add int := 0; v_upd int := 0; v_del int := 0; v_n int := 0;
begin
  select id into v_lid from public.layouts where building_id = p_building and key = p_layout;
  if v_lid is null then raise exception 'Няма такова разпределение в сградата'; end if;

  for fl in
    select f.id from public.floors f join public.sections s on s.id = f.section_id
    where f.building_id = p_building and s.key = p_section and f.number = any (p_floors)
  loop
    update public.floors set layout_id = v_lid where id = fl.id;
    r := private.sync_floor_apartments(fl.id);
    v_add := v_add + (r->>'added')::int; v_upd := v_upd + (r->>'updated')::int; v_del := v_del + (r->>'removed')::int; v_n := v_n + 1;
  end loop;
  if v_n = 0 then raise exception 'Няма такива етажи в този вход'; end if;

  update public.buildings set updated_at = now() where id = p_building;
  return jsonb_build_object('floors', v_n, 'added', v_add, 'updated', v_upd, 'removed', v_del);
end $$;
revoke all on function public.assign_layout(uuid, text, int[], text) from public, anon;
grant execute on function public.assign_layout(uuid, text, int[], text) to authenticated;

create or replace function public.delete_layout(p_building uuid, p_key text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_used int; v_rows int;
begin
  select count(*) into v_used from public.floors f join public.layouts l on l.id = f.layout_id where l.building_id = p_building and l.key = p_key;
  if v_used > 0 then raise exception 'Разпределението се ползва от % етажа. Първо им задайте друго.', v_used; end if;
  delete from public.layouts where building_id = p_building and key = p_key;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then raise exception 'Разпределението не е изтрито: нямате права или не съществува'; end if;
  return jsonb_build_object('deleted', true);
end $$;
revoke all on function public.delete_layout(uuid, text) from public, anon;
grant execute on function public.delete_layout(uuid, text) to authenticated;

create or replace function public.add_section(p_building uuid, p_name text, p_floors int, p_layout text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  lat text[] := array['A','B','C','D','E','F','G','H'];
  cyr text[] := array['А','Б','В','Г','Д','Е','Ж','З'];
  v_key text; v_cyr text; v_sid uuid; v_lid uuid; v_count int; v_fid uuid;
  v_first uuid; v_first_cyr text; v_apts int := 0; r jsonb;
begin
  if p_floors is null or p_floors < 1 or p_floors > 60 then raise exception 'Броят етажи трябва да е между 1 и 60'; end if;
  select l.id into v_lid from public.layouts l where l.building_id = p_building and l.key = p_layout;
  if v_lid is null then raise exception 'Няма такова разпределение в сградата'; end if;

  select count(*) into v_count from public.sections where building_id = p_building;
  if v_count >= 8 then raise exception 'Една сграда може да има най-много 8 входа'; end if;

  select lat[i], cyr[i] into v_key, v_cyr from generate_subscripts(lat, 1) i
  where lat[i] not in (select key from public.sections where building_id = p_building) order by i limit 1;

  insert into public.sections (building_id, key, name, sort_order)
  values (p_building, v_key, coalesce(nullif(trim(p_name), ''), 'Вход ' || v_cyr), v_count)
  returning id into v_sid;

  if v_count = 1 then
    select s.id, cyr[array_position(lat, s.key)] into v_first, v_first_cyr
    from public.sections s where s.building_id = p_building and s.id <> v_sid order by s.sort_order, s.key limit 1;
    perform set_config('app.status_source', 'admin', true);
    update public.apartments a set label = v_first_cyr || '-' || a.label
    from public.floors f where f.id = a.floor_id and f.section_id = v_first and a.label !~ '^[А-З]-';
  end if;

  for n in 1..p_floors loop
    insert into public.floors (building_id, section_id, number, layout_id) values (p_building, v_sid, n, v_lid) returning id into v_fid;
    r := private.sync_floor_apartments(v_fid);
    v_apts := v_apts + (r->>'added')::int;
  end loop;

  update public.buildings set updated_at = now() where id = p_building;
  return jsonb_build_object('id', v_sid, 'key', v_key, 'name', coalesce(nullif(trim(p_name), ''), 'Вход ' || v_cyr), 'floors', p_floors, 'apartments', v_apts);
end $$;
