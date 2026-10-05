-- Помощни функции за правата
create or replace function public.is_org_member(p_org uuid, p_roles text[] default array['owner','editor','viewer'])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.org_members m
    where m.org_id = p_org and m.user_id = auth.uid() and m.role = any(p_roles)
  );
$$;

create or replace function public.building_org(p_building uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select org_id from public.buildings where id = p_building;
$$;

create or replace function public.is_published_building(p_building uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select published from public.buildings where id = p_building), false);
$$;

alter table public.organizations enable row level security;
alter table public.org_members enable row level security;
alter table public.buildings enable row level security;
alter table public.layouts enable row level security;
alter table public.floors enable row level security;
alter table public.apartments enable row level security;
alter table public.status_history enable row level security;
alter table public.leads enable row level security;
alter table public.events enable row level security;

-- Организации и членове: само собствените
create policy org_select on public.organizations for select to authenticated using (public.is_org_member(id));
create policy org_update on public.organizations for update to authenticated using (public.is_org_member(id, array['owner'])) with check (public.is_org_member(id, array['owner']));
create policy members_select on public.org_members for select to authenticated using (public.is_org_member(org_id));
create policy members_manage on public.org_members for all to authenticated using (public.is_org_member(org_id, array['owner'])) with check (public.is_org_member(org_id, array['owner']));

-- Сгради: публичните се четат от всички, членовете четат и редактират своите
create policy buildings_public_read on public.buildings for select to anon, authenticated using (published);
create policy buildings_member_read on public.buildings for select to authenticated using (public.is_org_member(org_id));
create policy buildings_member_write on public.buildings for insert to authenticated with check (public.is_org_member(org_id, array['owner','editor']));
create policy buildings_member_update on public.buildings for update to authenticated using (public.is_org_member(org_id, array['owner','editor'])) with check (public.is_org_member(org_id, array['owner','editor']));
create policy buildings_member_delete on public.buildings for delete to authenticated using (public.is_org_member(org_id, array['owner']));

-- Разпределения, етажи, апартаменти: същата логика през сградата
create policy layouts_public_read on public.layouts for select to anon, authenticated using (public.is_published_building(building_id));
create policy layouts_member_all on public.layouts for all to authenticated
  using (public.is_org_member(public.building_org(building_id), array['owner','editor']))
  with check (public.is_org_member(public.building_org(building_id), array['owner','editor']));
create policy layouts_member_read on public.layouts for select to authenticated using (public.is_org_member(public.building_org(building_id)));

create policy floors_public_read on public.floors for select to anon, authenticated using (public.is_published_building(building_id));
create policy floors_member_all on public.floors for all to authenticated
  using (public.is_org_member(public.building_org(building_id), array['owner','editor']))
  with check (public.is_org_member(public.building_org(building_id), array['owner','editor']));
create policy floors_member_read on public.floors for select to authenticated using (public.is_org_member(public.building_org(building_id)));

create policy apartments_public_read on public.apartments for select to anon, authenticated using (public.is_published_building(building_id));
create policy apartments_member_all on public.apartments for all to authenticated
  using (public.is_org_member(public.building_org(building_id), array['owner','editor']))
  with check (public.is_org_member(public.building_org(building_id), array['owner','editor']));
create policy apartments_member_read on public.apartments for select to authenticated using (public.is_org_member(public.building_org(building_id)));

-- История, запитвания, събития: само членовете четат. Запис става от сървъра (service_role).
create policy history_member_read on public.status_history for select to authenticated
  using (public.is_org_member(public.building_org((select a.building_id from public.apartments a where a.id = apartment_id))));
create policy leads_member_read on public.leads for select to authenticated using (public.is_org_member(public.building_org(building_id)));
create policy leads_member_update on public.leads for update to authenticated
  using (public.is_org_member(public.building_org(building_id), array['owner','editor']))
  with check (public.is_org_member(public.building_org(building_id), array['owner','editor']));
create policy events_member_read on public.events for select to authenticated using (public.is_org_member(public.building_org(building_id)));

-- Публичният изглед, който widget-ът чете с една заявка.
-- Цените, скрити от строителя, не излизат навън; лични данни няма.
create or replace function public.get_public_building(p_slug text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', b.slug,
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

create or replace function public.list_public_buildings(p_org_slug text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.slug, 'name', b.name, 'short', b.short_name, 'district', b.district,
    'stage', b.stage, 'ready', b.ready_text, 'desc', b.description,
    'image', b.facade->>'image_url',
    'floors', (select count(*) from public.floors f where f.building_id = b.id),
    'total', (select count(*) from public.apartments a where a.building_id = b.id),
    'free', (select count(*) from public.apartments a where a.building_id = b.id and a.status = 'free'),
    'reserved', (select count(*) from public.apartments a where a.building_id = b.id and a.status = 'reserved'),
    'sold', (select count(*) from public.apartments a where a.building_id = b.id and a.status = 'sold'),
    'min_price', (select min(a.price) from public.apartments a where a.building_id = b.id and a.status = 'free' and a.price_visible)
  ) order by b.sort_order, b.name), '[]'::jsonb)
  from public.buildings b join public.organizations o on o.id = b.org_id
  where o.slug = p_org_slug and b.published;
$$;

revoke all on function public.get_public_building(text) from public;
revoke all on function public.list_public_buildings(text) from public;
grant execute on function public.get_public_building(text) to anon, authenticated;
grant execute on function public.list_public_buildings(text) to anon, authenticated;

-- Статусите се обновяват на живо в widget-а
alter publication supabase_realtime add table public.apartments;

-- Хранилище за рендери, разпределения и PDF файлове: публично четене, запис само от членове в папката на организацията
insert into storage.buckets (id, name, public) values ('media', 'media', true) on conflict (id) do nothing;

create policy media_member_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public.is_org_member(((storage.foldername(name))[1])::uuid, array['owner','editor']));
create policy media_member_update on storage.objects for update to authenticated
  using (bucket_id = 'media' and public.is_org_member(((storage.foldername(name))[1])::uuid, array['owner','editor']));
create policy media_member_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and public.is_org_member(((storage.foldername(name))[1])::uuid, array['owner','editor']));
