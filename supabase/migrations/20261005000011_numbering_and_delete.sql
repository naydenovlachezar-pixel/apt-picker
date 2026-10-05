-- Номерация „както е въведена“ или „етаж + номер“, ръчни номера и изтриване на апартамент само от един етаж.
-- Приложена в Supabase като „numbering_and_per_floor_delete“.
alter table public.apartments add column label_locked boolean not null default false;
alter table public.floors add column excluded_units text[] not null default '{}';

create or replace function private.sync_floor_apartments(p_floor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  lat text[] := array['A','B','C','D','E','F','G','H'];
  cyr text[] := array['А','Б','В','Г','Д','Е','Ж','З'];
  f record; v_plan jsonb; v_units jsonb; v_mode text; v_multi boolean; v_code_pre text; v_label_pre text;
  v_blocked text; v_del int := 0; v_ins int := 0; v_upd int := 0;
begin
  select fl.id, fl.number, fl.building_id, fl.layout_id, fl.excluded_units, s.key as skey into f
  from public.floors fl join public.sections s on s.id = fl.section_id where fl.id = p_floor;
  if f.id is null then raise exception 'Етажът не съществува'; end if;
  if not private.is_org_member(private.building_org(f.building_id), array['owner','editor']) then
    raise exception 'Нямате права да променяте тази сграда';
  end if;

  select l.plan into v_plan from public.layouts l where l.id = f.layout_id;
  v_mode := coalesce(v_plan->>'numbering', case when v_plan->>'kind' = 'image' then 'as_is' else 'floor' end);
  select coalesce(jsonb_object_agg(u.key, u.value), '{}'::jsonb) into v_units
  from jsonb_each(coalesce(v_plan->'units', '{}'::jsonb)) u where not (u.key = any (f.excluded_units));

  select count(*) > 1 into v_multi from public.sections where building_id = f.building_id;
  v_code_pre := case when f.skey = 'A' then '' else f.skey || '-' end;
  v_label_pre := case when v_mode = 'floor' then (case when v_multi then cyr[array_position(lat, f.skey)] || '-' else '' end) || f.number else '' end;

  select string_agg(a.label || ' (' || case a.status when 'reserved' then 'резервиран' else 'продаден' end || ')', ', ' order by a.unit_key)
  into v_blocked from public.apartments a
  where a.floor_id = p_floor and a.status <> 'free' and not (v_units ? a.unit_key);
  if v_blocked is not null then
    raise exception 'Етаж % ще загуби апартаменти, които не са свободни: %. Сменете статуса им или ги добавете в разпределението.', f.number, v_blocked;
  end if;

  perform set_config('app.status_source', 'admin', true);

  delete from public.apartments a where a.floor_id = p_floor and not (v_units ? a.unit_key);
  get diagnostics v_del = row_count;

  update public.apartments a set
    label = case when a.label_locked then a.label else v_label_pre || coalesce(nullif(u.value->>'label', ''), u.key) end,
    rooms = least(greatest(coalesce((u.value->>'rooms')::int, a.rooms), 1), 10),
    net_area = coalesce((u.value->>'net')::numeric, a.net_area),
    gross_area = coalesce((u.value->>'gross')::numeric, a.gross_area),
    outdoor_area = coalesce((u.value->>'outdoor')::numeric, a.outdoor_area),
    exposure = coalesce(nullif(u.value->>'exposure', ''), a.exposure)
  from jsonb_each(v_units) u
  where a.floor_id = p_floor and a.unit_key = u.key
    and (a.label, a.rooms, a.net_area, a.gross_area, a.outdoor_area, a.exposure) is distinct from
        (case when a.label_locked then a.label else v_label_pre || coalesce(nullif(u.value->>'label', ''), u.key) end,
         least(greatest(coalesce((u.value->>'rooms')::int, a.rooms), 1), 10),
         coalesce((u.value->>'net')::numeric, a.net_area), coalesce((u.value->>'gross')::numeric, a.gross_area),
         coalesce((u.value->>'outdoor')::numeric, a.outdoor_area), coalesce(nullif(u.value->>'exposure', ''), a.exposure));
  get diagnostics v_upd = row_count;

  insert into public.apartments (building_id, floor_id, unit_key, code, label, rooms, net_area, gross_area, outdoor_area, exposure, price, price_visible, status)
  select f.building_id, p_floor, u.key, v_code_pre || f.number || u.key,
         v_label_pre || coalesce(nullif(u.value->>'label', ''), u.key),
         least(greatest(coalesce((u.value->>'rooms')::int, 1), 1), 10), (u.value->>'net')::numeric,
         coalesce((u.value->>'gross')::numeric, 0), coalesce((u.value->>'outdoor')::numeric, 0), nullif(u.value->>'exposure', ''),
         null, true, 'free'
  from jsonb_each(v_units) u
  where not exists (select 1 from public.apartments a where a.floor_id = p_floor and a.unit_key = u.key);
  get diagnostics v_ins = row_count;

  return jsonb_build_object('added', v_ins, 'updated', v_upd, 'removed', v_del);
end $$;

drop function public.save_layout(uuid, text, text, text, int, int, jsonb);
create function public.save_layout(p_building uuid, p_key text, p_name text, p_image_url text, p_w int, p_h int, p_units jsonb, p_numbering text default 'as_is')
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_key text := nullif(trim(coalesce(p_key, '')), '');
  v_mode text := case when p_numbering = 'floor' then 'floor' else 'as_is' end;
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
    select 'L' || (coalesce(max(substring(key from '^L(\d+)$')::int), 0) + 1) into v_key from public.layouts where building_id = p_building;
  end if;

  insert into public.layouts (building_id, key, name, image_url, plan)
  values (p_building, v_key, trim(p_name), p_image_url, jsonb_build_object('kind', 'image', 'w', p_w, 'h', p_h, 'numbering', v_mode, 'units', p_units))
  on conflict (building_id, key) do update set name = excluded.name, image_url = excluded.image_url, plan = excluded.plan, updated_at = now()
  returning id into v_id;
  if v_id is null then raise exception 'Нямате права да променяте тази сграда'; end if;

  for fl in select id from public.floors where layout_id = v_id loop
    r := private.sync_floor_apartments(fl.id);
    v_add := v_add + (r->>'added')::int; v_upd := v_upd + (r->>'updated')::int; v_del := v_del + (r->>'removed')::int; v_floors := v_floors + 1;
  end loop;

  update public.buildings set updated_at = now() where id = p_building;
  return jsonb_build_object('key', v_key, 'floors', v_floors, 'added', v_add, 'updated', v_upd, 'removed', v_del);
end $$;
revoke all on function public.save_layout(uuid, text, text, text, int, int, jsonb, text) from public, anon;
grant execute on function public.save_layout(uuid, text, text, text, int, int, jsonb, text) to authenticated;

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
    update public.floors set excluded_units = case when layout_id is distinct from v_lid then '{}' else excluded_units end, layout_id = v_lid where id = fl.id;
    r := private.sync_floor_apartments(fl.id);
    v_add := v_add + (r->>'added')::int; v_upd := v_upd + (r->>'updated')::int; v_del := v_del + (r->>'removed')::int; v_n := v_n + 1;
  end loop;
  if v_n = 0 then raise exception 'Няма такива етажи в този вход'; end if;

  update public.buildings set updated_at = now() where id = p_building;
  return jsonb_build_object('floors', v_n, 'added', v_add, 'updated', v_upd, 'removed', v_del);
end $$;

create or replace function public.delete_apartment(p_apartment uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare a record; v_rows int;
begin
  select id, floor_id, unit_key, label, status, building_id into a from public.apartments where id = p_apartment;
  if a.id is null then raise exception 'Апартаментът не съществува или нямате достъп до него'; end if;
  if a.status <> 'free' then raise exception 'Апартамент % е %. Изтриват се само свободни апартаменти.', a.label, case a.status when 'reserved' then 'резервиран' else 'продаден' end; end if;

  update public.floors set excluded_units = array_append(excluded_units, a.unit_key)
  where id = a.floor_id and not (a.unit_key = any (excluded_units));
  delete from public.apartments where id = a.id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then raise exception 'Нямате права да изтриете този апартамент'; end if;

  update public.buildings set updated_at = now() where id = a.building_id;
  return jsonb_build_object('deleted', a.label);
end $$;
revoke all on function public.delete_apartment(uuid) from public, anon;
grant execute on function public.delete_apartment(uuid) to authenticated;

update public.layouts set plan = plan || '{"numbering":"as_is"}'::jsonb where plan->>'kind' = 'image' and not (plan ? 'numbering');
update public.apartments a set label = coalesce(nullif(l.plan->'units'->a.unit_key->>'label', ''), a.unit_key)
from public.floors f join public.layouts l on l.id = f.layout_id
where f.id = a.floor_id and l.plan->>'kind' = 'image' and not a.label_locked;
