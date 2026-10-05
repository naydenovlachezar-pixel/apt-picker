import { cors, json, safe, supabaseConfig } from "./_lib.js";

// Данните за widget-а: GET /api/widget?b=bor  или  /api/widget?only=terasi,spirala
// Чете публичния изглед от Supabase и го кешира кратко на CDN-а на Vercel.
const SLUG = /^[a-z0-9-]{2,60}$/;

export default safe(async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
  const sb = supabaseConfig();
  if (!sb.url || !sb.key) return json(res, 503, { ok: false, error: "supabase_not_configured" });

  const url = new URL(req.url, "http://localhost");
  const b = url.searchParams.get("b");
  const only = (url.searchParams.get("only") || "").split(",").map(s => s.trim()).filter(Boolean);
  if ((b && !SLUG.test(b)) || only.some(s => !SLUG.test(s))) return json(res, 400, { ok: false, error: "invalid_slug" });
  if (!b && !only.length) return json(res, 400, { ok: false, error: "missing_building" });

  const headers = { apikey: sb.key, "Content-Type": "application/json" };
  if (sb.key.startsWith("eyJ")) headers.Authorization = `Bearer ${sb.key}`; // стар anon ключ (JWT)

  let r;
  try {
    r = await fetch(`${sb.url}/rest/v1/rpc/get_widget_bundle`, {
      method: "POST",
      headers,
      body: JSON.stringify({ p_building: b || null, p_only: only.length ? only : null })
    });
  } catch (e) {
    console.error("supabase unreachable", sb.host, e);
    return json(res, 502, { ok: false, error: "supabase_unreachable", host: sb.host });
  }
  if (!r.ok) {
    const text = await r.text();
    console.error("supabase rpc failed", r.status, text);
    return json(res, 502, { ok: false, error: "upstream_error", status: r.status, host: sb.host, detail: text.slice(0, 300) });
  }
  const bundle = await r.json();
  if (!bundle || !bundle.buildings || !bundle.buildings.length) return json(res, 404, { ok: false, error: "not_found" });

  res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=60");
  json(res, 200, { ok: true, ...bundle, realtime: { url: sb.url, key: sb.key } });
});
