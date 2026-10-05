import { cors, json, readBody, safe } from "./_lib.js";

// Приема запитване от widget-а: POST /api/inquiry
// Етап 1: валидира и логва. Етап 6: записва в Supabase и препраща към HubSpot, имейл или webhook.
const REQUIRED = ["building_id", "apartment_id", "name", "phone"];

export default safe(async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });

  const body = await readBody(req);
  if (!body) return json(res, 400, { ok: false, error: "invalid_json" });

  // Скрито поле срещу ботове: хората не го попълват.
  if (body.website) return json(res, 200, { ok: true });

  const missing = REQUIRED.filter(k => !String(body[k] || "").trim());
  if (missing.length) return json(res, 422, { ok: false, error: "missing_fields", fields: missing });
  if (!/^[+\d][\d\s-]{6,}$/.test(String(body.phone))) return json(res, 422, { ok: false, error: "invalid_phone" });
  if (body.email && !/^\S+@\S+\.\S+$/.test(String(body.email))) return json(res, 422, { ok: false, error: "invalid_email" });
  if (body.consent !== true) return json(res, 422, { ok: false, error: "consent_required" });

  const lead = {
    building_id: String(body.building_id),
    apartment_id: String(body.apartment_id),
    name: String(body.name).slice(0, 200),
    phone: String(body.phone).slice(0, 40),
    email: body.email ? String(body.email).slice(0, 200) : null,
    message: body.message ? String(body.message).slice(0, 2000) : null,
    page_uri: body.page_uri ? String(body.page_uri).slice(0, 500) : null,
    placement: body.placement ? String(body.placement).slice(0, 40) : null,
    received_at: new Date().toISOString()
  };

  console.log("inquiry", JSON.stringify({ ...lead, phone: "***", email: lead.email ? "***" : null }));
  json(res, 200, { ok: true, stored: false, lead_id: null });
});
