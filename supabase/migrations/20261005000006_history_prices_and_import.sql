-- Историята пази и цената, и дали се показва
alter table public.status_history
  add column old_price numeric(12,2),
  add column new_price numeric(12,2),
  add column old_price_visible boolean,
  add column new_price_visible boolean;

create or replace function private.log_status_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT'
     or new.status is distinct from old.status
     or new.price is distinct from old.price
     or new.price_visible is distinct from old.price_visible then
    insert into public.status_history
      (apartment_id, old_status, new_status, old_price, new_price, old_price_visible, new_price_visible, source, changed_by)
    values (new.id,
      case when tg_op = 'UPDATE' then old.status end, new.status,
      case when tg_op = 'UPDATE' then old.price end, new.price,
      case when tg_op = 'UPDATE' then old.price_visible end, new.price_visible,
      coalesce(nullif(current_setting('app.status_source', true), ''), 'admin'), auth.uid());
  end if;
  return new;
end $$;

drop trigger apartments_status_log on public.apartments;
create trigger apartments_status_log after insert or update of status, price, price_visible on public.apartments
for each row execute function private.log_status_change();

-- Масова промяна от внасяне. Изпълнява се с правата на потребителя (RLS решава какво може).
create or replace function public.import_apartments(p_building uuid, p_rows jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_updated int := 0;
  v_missing text[];
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'p_rows must be an array'; end if;
  perform set_config('app.status_source', 'import', true);

  select coalesce(array_agg(r->>'code'), '{}') into v_missing
  from jsonb_array_elements(p_rows) r
  where not exists (select 1 from public.apartments a where a.building_id = p_building and a.code = r->>'code');
  if cardinality(v_missing) > 0 then
    raise exception 'Непознати апартаменти: %', array_to_string(v_missing, ', ');
  end if;

  with src as (
    select r->>'code' as code,
      case when r ? 'status' then (r->>'status')::public.apartment_status end as status,
      case when r ? 'price' then nullif(r->>'price', '')::numeric end as price, r ? 'price' as has_price,
      case when r ? 'price_visible' then (r->>'price_visible')::boolean end as price_visible
    from jsonb_array_elements(p_rows) r
  ), upd as (
    update public.apartments a set
      status = coalesce(s.status, a.status),
      price = case when s.has_price then s.price else a.price end,
      price_visible = coalesce(s.price_visible, a.price_visible)
    from src s
    where a.building_id = p_building and a.code = s.code
      and (a.status is distinct from coalesce(s.status, a.status)
        or (s.has_price and a.price is distinct from s.price)
        or a.price_visible is distinct from coalesce(s.price_visible, a.price_visible))
    returning a.id
  )
  select count(*) into v_updated from upd;

  return jsonb_build_object('updated', v_updated, 'rows', jsonb_array_length(p_rows));
end $$;
revoke all on function public.import_apartments(uuid, jsonb) from public, anon;
grant execute on function public.import_apartments(uuid, jsonb) to authenticated;

-- История за панела: с имейла на човека, направил промяната. Само за членове на организацията.
create or replace function public.building_history(p_building uuid, p_limit int default 100)
returns table (changed_at timestamptz, label text, code text, old_status public.apartment_status, new_status public.apartment_status,
               old_price numeric, new_price numeric, old_price_visible boolean, new_price_visible boolean, source text, email text)
language sql stable security definer set search_path = '' as $$
  select h.changed_at, a.label, a.code, h.old_status, h.new_status, h.old_price, h.new_price,
         h.old_price_visible, h.new_price_visible, h.source, u.email::text
  from public.status_history h
  join public.apartments a on a.id = h.apartment_id
  left join auth.users u on u.id = h.changed_by
  where a.building_id = p_building
    and private.is_org_member(private.building_org(p_building))
    and h.source <> 'seed'
  order by h.changed_at desc
  limit least(greatest(p_limit, 1), 500);
$$;
revoke all on function public.building_history(uuid, int) from public, anon;
grant execute on function public.building_history(uuid, int) to authenticated;
