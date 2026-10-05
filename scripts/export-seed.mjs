// Генерира supabase/seed.sql от демо данните в widget/embed.html.
// Употреба: node scripts/export-seed.mjs  →  после пуснете seed.sql в Supabase SQL Editor.
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../widget/embed.html", import.meta.url), "utf8");
const js = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
const part = js.slice(js.indexOf("const BUILDINGS = ["), js.indexOf("/* ============ Вграждане"))
  .replace("(function injectPhotos(){", "(function injectPhotos(){ return;");
const gen = js.slice(js.indexOf("function mulberry32"), js.indexOf("const APTS = buildData();"));

const ctx = { out: null };
vm.runInNewContext(part + "\n" + gen + `
const APTS = buildData();
out = BUILDINGS.map((b, i) => {
  const layouts = {};
  for (const [k, L] of Object.entries(b.layouts)) {
    const units = {};
    for (const [uk, u] of Object.entries(L.units)) {
      units[uk] = { label: u.label, poly: u.poly, tag: u.tag, walls: u.walls, rl: u.rl, rooms: u.rooms, net: u.net, gross: u.gross, exposure: u.exposure };
    }
    layouts[k] = { viewBox: [0, 0, 1000, 560], units, extras: L.extras, balconies: L.balconies };
  }
  return {
    slug: b.id, name: b.name, short: b.short, district: b.district, stage: b.stage, ready: b.ready, desc: b.desc, sort: i,
    facade: { image_url: PHOTO_SRC[b.id], w: PHOTO[b.id].w, h: PHOTO[b.id].h },
    settings: b.gardenFloor ? { garden_floor: b.gardenFloor } : {},
    layouts,
    floors: Array.from({ length: b.geo.floors }, (_, k) => [k + 1, b.floorLayout(k + 1), PHOTO[b.id].floors[k + 1]]),
    apts: APTS.filter(x => x.b === b.id).map(x => [x.floor, x.unit, x.price, x.base[0], x.terrace, x.garden ? 1 : 0])
  };
});`, ctx);

const data = JSON.stringify(ctx.out);
const sql = `-- Демо данни: организация „Линия Девелопмънт (демо)“ и шест сгради.
-- Генерирано от scripts/export-seed.mjs. Пускайте само върху празна база.
do $$
declare
  d jsonb := $seed$${data}$seed$::jsonb;
  v_org uuid; b jsonb; v_bid uuid;
begin
  perform set_config('app.status_source', 'seed', true);
  insert into public.organizations (slug, name) values ('liniya-demo', 'Линия Девелопмънт (демо)')
    on conflict (slug) do update set name = excluded.name returning id into v_org;

  for b in select * from jsonb_array_elements(d) loop
    insert into public.buildings (org_id, slug, name, short_name, district, stage, ready_text, description, published, facade, settings, sort_order)
    values (v_org, b->>'slug', b->>'name', b->>'short', b->>'district', b->>'stage', b->>'ready', b->>'desc', true, b->'facade', b->'settings', (b->>'sort')::int)
    returning id into v_bid;

    insert into public.layouts (building_id, key, plan)
    select v_bid, x.k, x.v from jsonb_each(b->'layouts') as x(k, v);

    insert into public.floors (building_id, number, layout_id, facade_polygon)
    select v_bid, (e->>0)::int, l.id, e->2
    from jsonb_array_elements(b->'floors') e
    join public.layouts l on l.building_id = v_bid and l.key = e->>1;

    insert into public.apartments (building_id, floor_id, unit_key, code, label, rooms, net_area, gross_area, outdoor_area, outdoor_kind, exposure, price, status)
    select v_bid, fl.id, a->>1, (a->>0) || (a->>1), (a->>0) || (u.spec->>'label'),
           (u.spec->>'rooms')::int, (u.spec->>'net')::numeric, (u.spec->>'gross')::numeric, (a->>4)::numeric,
           case when (a->>5) = '1' then 'garden' else 'terrace' end, u.spec->>'exposure', (a->>2)::numeric,
           (case a->>3 when 'f' then 'free' when 'r' then 'reserved' else 'sold' end)::public.apartment_status
    from jsonb_array_elements(b->'apts') a
    join public.floors fl on fl.building_id = v_bid and fl.number = (a->>0)::int
    join public.layouts l on l.id = fl.layout_id
    cross join lateral (select l.plan->'units'->(a->>1) as spec) u;
  end loop;
end $$;
`;
writeFileSync(new URL("../supabase/seed.sql", import.meta.url), sql);
console.log("supabase/seed.sql:", ctx.out.map(b => `${b.slug} ${b.apts.length}`).join(", "));
