// Общи помощни функции за API функциите. Файлове, започващи с „_“, не стават отделни endpoint-и.
// Ползваме само стандартното Node API (statusCode, setHeader, end), за да не зависим от помощниците на Vercel.
export function cors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return true; }
  return false;
}

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return null; } }
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return raw ? JSON.parse(raw) : {}; } catch { return null; }
}

// Обвива handler-а: всяка неочаквана грешка се логва и връща JSON вместо срив на функцията.
export function safe(handler) {
  return async (req, res) => {
    try { await handler(req, res); }
    catch (e) {
      console.error("api error", e);
      if (!res.headersSent) json(res, 500, { ok: false, error: "internal_error", detail: String(e && e.message || e).slice(0, 300) });
    }
  };
}

export function supabaseConfig() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key =
    process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  let host = null;
  try { host = url ? new URL(url).host : null; } catch { host = "invalid"; }
  return { url: url.replace(/\/+$/, ""), key, host };
}
