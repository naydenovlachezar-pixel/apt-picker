-- Публичният изглед на сграда вече връща и вътрешния й id (нужен за абонамента за промени на живо)
create or replace function public.get_public_building(p_slug text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', b.slug,
    'uuid', b.id,
    'name', b.name,
    'short', b.short_name,
    'district', b.district,
    'stage', b.stage,
    'ready', b.ready_text,
    'desc', b.description,
    'facade', b.facade,
    'settings', b.settings - 'leads',
    'updated_at', b.updated_at,
    'layouts', coalesce((
      select jsonb_object_agg(l.key, l.plan || jsonb_build_object('image_url', l.image_url))
      from public.layouts l where l.building_id = b.id), '{}'::jsonb),
    'floors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'n', f.number, 'label', f.label,
        'layout', (select l.key from public.layouts l where l.id = f.layout_id),
        'polygon', f.facade_polygon) order by f.number)
      from public.floors f where f.building_id = b.id), '[]'::jsonb),
    'apartments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.code, 'label', a.label, 'floor', f.number, 'unit', a.unit_key,
        'rooms', a.rooms, 'net', a.net_area, 'gross', a.gross_area,
        'outdoor', a.outdoor_area, 'outdoor_kind', a.outdoor_kind, 'exposure', a.exposure,
        'price', case when a.price_visible and a.status <> 'sold' then a.price end,
        'currency', a.currency, 'status', a.status, 'pdf_url', a.pdf_url
      ) order by f.number, a.unit_key)
      from public.apartments a join public.floors f on f.id = a.floor_id
      where a.building_id = b.id), '[]'::jsonb)
  )
  from public.buildings b
  where b.slug = p_slug and b.published;
$$;

-- Всичко, от което widget-ът има нужда, с една заявка:
-- сградите на същия строител (или само изброените в p_only), подредени както в админа.
create or replace function public.get_widget_bundle(p_building text default null, p_only text[] default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  with anchor as (
    select b.org_id
    from public.buildings b
    where b.published and b.slug = coalesce(p_building, p_only[1])
  )
  select jsonb_build_object(
    'org', o.slug,
    'buildings', coalesce((
      select jsonb_agg(public.get_public_building(b2.slug) order by b2.sort_order, b2.name)
      from public.buildings b2
      where b2.org_id = o.id and b2.published
        and (p_only is null or cardinality(p_only) = 0 or b2.slug = any(p_only))
    ), '[]'::jsonb)
  )
  from anchor a join public.organizations o on o.id = a.org_id;
$$;

revoke all on function public.get_widget_bundle(text, text[]) from public;
grant execute on function public.get_widget_bundle(text, text[]) to anon, authenticated;
