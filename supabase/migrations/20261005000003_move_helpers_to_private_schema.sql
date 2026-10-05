create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated, service_role;

-- Политиките и тригерите сочат функциите по идентификатор, затова продължават да работят след преместването.
alter function public.is_org_member(uuid, text[]) set schema private;
alter function public.building_org(uuid) set schema private;
alter function public.is_published_building(uuid) set schema private;
alter function public.log_status_change() set schema private;
alter function public.touch_updated_at() set schema private;

revoke all on function private.is_org_member(uuid, text[]) from public;
revoke all on function private.building_org(uuid) from public;
revoke all on function private.is_published_building(uuid) from public;
revoke all on function private.log_status_change() from public, anon, authenticated;
revoke all on function private.touch_updated_at() from public, anon, authenticated;

grant execute on function private.is_org_member(uuid, text[]) to anon, authenticated;
grant execute on function private.building_org(uuid) to anon, authenticated;
grant execute on function private.is_published_building(uuid) to anon, authenticated;

-- Публичните функции за widget-а остават, но само за четене на публикувани данни
revoke execute on function public.get_public_building(text) from public;
revoke execute on function public.list_public_buildings(text) from public;
grant execute on function public.get_public_building(text) to anon, authenticated;
grant execute on function public.list_public_buildings(text) to anon, authenticated;
