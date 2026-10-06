-- Изтриване на сграда: само собственик, само скрита от сайта, с потвърждение чрез името.
-- Входове, етажи, разпределения, апартаменти, история и запитвания се изтриват заедно с нея.
create or replace function public.delete_building(p_building uuid, p_confirm_name text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare b record; v_rows int;
begin
  select id, org_id, name, slug, published into b from public.buildings where id = p_building;
  if b.id is null then raise exception 'Сградата не съществува или нямате достъп до нея'; end if;
  if not private.is_org_member(b.org_id, array['owner']) then raise exception 'Само собственикът на акаунта може да изтрие сграда'; end if;
  if b.published then raise exception 'Сградата се показва на сайта. Първо я скрийте от „Данни и код“, после я изтрийте.'; end if;
  if trim(coalesce(p_confirm_name, '')) <> trim(b.name) then raise exception 'Името не съвпада. Напишете го точно: %', b.name; end if;

  delete from public.buildings where id = b.id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then raise exception 'Сградата не е изтрита: нямате права'; end if;
  return jsonb_build_object('deleted', b.name, 'org_id', b.org_id, 'id', b.id);
end $$;
revoke all on function public.delete_building(uuid, text) from public, anon;
grant execute on function public.delete_building(uuid, text) to authenticated;
