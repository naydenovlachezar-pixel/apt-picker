import { cors, json } from "./_lib.js";

// Данните за widget-а: GET /api/widget?b=bor  или  /api/widget?only=terasi,spirala
// Чете публичния изглед от Supabase и го кешира кратко на CDN-а на Vercel.
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const PUBLIC_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const SLUG = /^[a-z0-9-]{2,60}$/;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
  if (!SUPABASE_URL || !PUBLIC_KEY) return json(res, 503, { ok: false, error: "supabase_not_configured" });

  const url = new URL(req.url, "http://x");
  const b = url.searchParams.get("b");
  const only = (url.searchParams.get("only") || "").split(",").map(s => s.trim()).filter(Boolean);
  if ((b && !SLUG.test(b)) || only.some(s => !SLUG.test(s))) return json(res, 400, { ok: false, error: "invalid_slug" });
  if (!b && !only.length) return json(res, 400, { ok: false, error: "missing_building" });

  const headers = { apikey: PUBLIC_KEY, "Content-Type": "application/json" };
  if (PUBLIC_KEY.startsWith("eyJ")) headers.Authorization = `Bearer ${PUBLIC_KEY}`; // стар anon ключ (JWT)

  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_widget_bundle`, {
    method: "POST",
    headers,
    body: JSON.stringify({ p_building: b || null, p_only: only.length ? only : null })
  });
  if (!r.ok) {
    console.error("supabase rpc failed", r.status, await r.text());
    return json(res, 502, { ok: false, error: "upstream_error" });
  }
  const bundle = await r.json();
  if (!bundle || !bundle.buildings || !bundle.buildings.length) return json(res, 404, { ok: false, error: "not_found" });

  res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=60");
  json(res, 200, { ok: true, ...bundle, realtime: { url: SUPABASE_URL, key: PUBLIC_KEY } });
}
