// Записва текущите публикувани сгради на един строител като supabase/seed.sql,
// за да може базата да се пресъздаде на чисто (нов проект, тестов клон).
//
// Употреба:
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/export-seed.mjs bor
//   (или BUNDLE_FILE=bundle.json node scripts/export-seed.mjs, за работа без мрежа)
import { readFileSync, writeFileSync } from "node:fs";

const anchor = process.argv[2] || "bor";
let bundle;
if (process.env.BUNDLE_FILE) {
  bundle = JSON.parse(readFileSync(process.env.BUNDLE_FILE, "utf8"));
} else {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Задайте SUPABASE_URL и SUPABASE_ANON_KEY");
  const headers = { apikey: key, "Content-Type": "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  const r = await fetch(`${url}/rest/v1/rpc/get_widget_bundle`, { method: "POST", headers, body: JSON.stringify({ p_building: anchor }) });
  if (!r.ok) throw new Error(`Supabase: ${r.status} ${await r.text()}`);
  bundle = await r.json();
}
if (!bundle || !bundle.buildings) throw new Error("Няма данни за " + anchor);

const statusCode = { free: "f", reserved: "r", sold: "s" };
const data = bundle.buildings.map((b, i) => {
  const layouts = {};
  for (const [k, L] of Object.entries(b.layouts)) { const { image_url, ...plan } = L; layouts[k] = plan; }
  return {
    slug: b.id, name: b.name, short: b.short, district: b.district, stage: b.stage, ready: b.ready, desc: b.desc, sort: i,
    facade: b.facade, settings: b.settings || {}, layouts,
    floors: b.floors.map(f => [f.n, f.layout, f.polygon]),
    // Цените на продадените не са публични, затова в seed-а остават празни.
    apts: b.apartments.map(a => [a.floor, a.unit, a.price, statusCode[a.status], Number(a.outdoor) || 0, a.outdoor_kind === "garden" ? 1 : 0])
  };
});

const sql = `-- Демо данни за организация „${bundle.org}“. Генерирано от scripts/export-seed.mjs.
-- Пускайте само върху празна база, след миграциите.
do $$
declare
  d jsonb := $seed$${JSON.stringify(data)}$seed$::jsonb;
  v_org uuid; b jsonb; v_bid uuid;
begin
  perform set_config('app.status_source', 'seed', true);
  insert into public.organizations (slug, name) values ('${bundle.org}', 'Линия Девелопмънт (демо)')
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
           case when (a->>5) = '1' then 'garden' else 'terrace' end, u.spec->>'exposure', nullif(a->>2, '')::numeric,
           (case a->>3 when 'f' then 'free' when 'r' then 'reserved' else 'sold' end)::public.apartment_status
    from jsonb_array_elements(b->'apts') a
    join public.floors fl on fl.building_id = v_bid and fl.number = (a->>0)::int
    join public.layouts l on l.id = fl.layout_id
    cross join lateral (select l.plan->'units'->(a->>1) as spec) u;
  end loop;
end $$;
`;
writeFileSync(new URL("../supabase/seed.sql", import.meta.url), sql);
console.log("supabase/seed.sql:", data.map(b => `${b.slug} ${b.apts.length}`).join(", "));
