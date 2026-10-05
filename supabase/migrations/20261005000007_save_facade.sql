-- Записва фасадата (снимка и размери) и контурите на етажите наведнъж.
-- Изпълнява се с правата на потребителя: RLS пуска само редактори и собственици на организацията.
-- p_facade: { image_url, w, h } или null, ако снимката не се сменя
-- p_floors: [{ "n": 1, "polygon": { "t": [[x,y],...], "b": [[x,y],...] } }, ...]
create or replace function public.save_facade(p_building uuid, p_facade jsonb, p_floors jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_floors int := 0;
  v_ok int;
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

  with src as (
    select (f->>'n')::int as n, f->'polygon' as polygon from jsonb_array_elements(coalesce(p_floors, '[]'::jsonb)) f
  ), upd as (
    update public.floors fl set facade_polygon = s.polygon
    from src s
    where fl.building_id = p_building and fl.number = s.n
      and jsonb_typeof(s.polygon->'t') = 'array' and jsonb_typeof(s.polygon->'b') = 'array'
      and jsonb_array_length(s.polygon->'t') >= 2 and jsonb_array_length(s.polygon->'b') >= 2
    returning fl.id
  )
  select count(*) into v_floors from upd;

  update public.buildings set updated_at = now() where id = p_building;
  return jsonb_build_object('floors', v_floors);
end $$;
revoke all on function public.save_facade(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.save_facade(uuid, jsonb, jsonb) to authenticated;

-- Ограничения за качените файлове: само изображения и PDF, до 20 MB
update storage.buckets
set file_size_limit = 20 * 1024 * 1024,
    allowed_mime_types = array['image/jpeg','image/png','image/webp','image/avif','application/pdf']
where id = 'media';
