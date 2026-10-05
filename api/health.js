import { cors, json, safe, supabaseConfig } from "./_lib.js";

// Проверка, че API-то работи: GET /api/health
// Показва и към кой Supabase проект сочат ключовете (само адреса, без тайни).
export default safe(async (req, res) => {
  if (cors(req, res)) return;
  const sb = supabaseConfig();
  json(res, 200, {
    ok: true,
    service: "apt-picker-api",
    time: new Date().toISOString(),
    node: process.version,
    supabase: { configured: Boolean(sb.url && sb.key), host: sb.host, key_type: sb.key ? (sb.key.startsWith("eyJ") ? "legacy_anon" : sb.key.slice(0, 15)) : null },
    hubspot: Boolean(process.env.HUBSPOT_PRIVATE_APP_TOKEN)
  });
});
