import { createHash } from "node:crypto";
import { cors, json, readBody } from "./_lib.js";

// Приема запитване от widget-а: POST /api/inquiry
// 1. проверява формата, скритото поле и Cloudflare Turnstile (ако е настроен)
// 2. записва запитването в Supabase чрез public.submit_lead (там са ограничението за спам и получателите)
// 3. изпраща имейл до търговеца чрез Resend (ако е настроен)
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const PUBLIC_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.LEADS_FROM_EMAIL || "Избор на апартамент <onboarding@resend.dev>";
const ADMIN_URL = process.env.ADMIN_URL || "https://apt-picker.vercel.app";
const SALT = process.env.IP_HASH_SALT || "apt-picker";

const MESSAGES = {
  consent_required: "Отбележете съгласието, за да изпратите запитването.",
  missing_name: "Въведете име.",
  invalid_phone: "Въведете телефон, например 0888 123 456.",
  invalid_email: "Имейлът изглежда непълен.",
  unknown_building: "Сградата вече не приема запитвания.",
  rate_limited: "Изпратихте няколко запитвания за кратко време. Опитайте отново след малко или се обадете на телефона на строителя.",
  captcha_failed: "Проверката срещу спам не мина. Презаредете страницата и опитайте отново."
};

const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return true; // още не е настроен
  if (!token) return false;
  const body = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
  if (ip) body.set("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const d = await r.json();
    return !!d.success;
  } catch { return false; }
}

function emailHtml(lead, info) {
  const a = info.apartment || {};
  const where = [a.section, a.floor != null ? `етаж ${a.floor}` : null].filter(Boolean).join(", ");
  const row = (k, v) => v ? `<tr><td style="padding:6px 12px 6px 0;color:#5B686D;vertical-align:top">${k}</td><td style="padding:6px 0;font-weight:600">${v}</td></tr>` : "";
  return `<!doctype html><html lang="bg"><body style="margin:0;background:#EDEEEA;font-family:Arial,Helvetica,sans-serif;color:#1E2B30">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EDEEEA;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#F8F8F5;border:1px solid #CDD1CA">
<tr><td style="padding:22px 24px 8px"><div style="font-size:13px;color:#9C6A12;font-weight:700;letter-spacing:.04em">НОВО ЗАПИТВАНЕ</div>
<h1 style="font-size:24px;line-height:1.2;margin:6px 0 4px">${a.label ? `Апартамент ${esc(a.label)}` : "Запитване"}, ${esc(info.building)}</h1>
<div style="color:#5B686D;font-size:15px">${esc(where)}</div></td></tr>
<tr><td style="padding:8px 24px 4px"><table role="presentation" cellpadding="0" cellspacing="0" style="font-size:15px">
${row("Име", esc(lead.name))}
${row("Телефон", `<a href="tel:${esc(lead.phone.replace(/[^\d+]/g, ""))}" style="color:#1E2B30">${esc(lead.phone)}</a>`)}
${row("Имейл", lead.email ? `<a href="mailto:${esc(lead.email)}" style="color:#1E2B30">${esc(lead.email)}</a>` : "")}
${row("Съобщение", lead.message ? esc(lead.message).replace(/\n/g, "<br>") : "")}
${row("Страница", lead.page_uri ? `<a href="${esc(lead.page_uri)}" style="color:#5B686D">${esc(lead.page_uri.slice(0, 80))}</a>` : "")}
</table></td></tr>
<tr><td style="padding:16px 24px 24px"><a href="${esc(ADMIN_URL)}/?view=leads" style="display:inline-block;background:#1E2B30;color:#EDEEEA;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:2px">Отвори в панела</a></td></tr>
</table><div style="font-size:12px;color:#5B686D;margin-top:12px">Изпратено от интерактивния избор на апартамент за ${esc(info.org)}</div></td></tr></table></body></html>`;
}

async function sendEmail(lead, info) {
  const to = Array.isArray(info.recipients) ? info.recipients.filter(Boolean) : [];
  if (!RESEND_KEY || !to.length) return { sent: false, reason: RESEND_KEY ? "no_recipients" : "not_configured" };
  const a = info.apartment || {};
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM, to, reply_to: lead.email || undefined,
      subject: `Ново запитване: ${a.label ? `ап. ${a.label}, ` : ""}${info.building}`,
      html: emailHtml(lead, info),
      text: `Ново запитване за ${a.label ? `апартамент ${a.label} в ` : ""}${info.building}\n\nИме: ${lead.name}\nТелефон: ${lead.phone}\n${lead.email ? `Имейл: ${lead.email}\n` : ""}${lead.message ? `\n${lead.message}\n` : ""}\nПанел: ${ADMIN_URL}/?view=leads`
    })
  });
  if (!r.ok) { console.error("resend failed", r.status, await r.text()); return { sent: false, reason: "provider_error" }; }
  return { sent: true };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });
  if (!SUPABASE_URL || !PUBLIC_KEY) return json(res, 503, { ok: false, error: "supabase_not_configured" });

  const body = await readBody(req);
  if (!body) return json(res, 400, { ok: false, error: "invalid_json" });
  // Скрито поле срещу ботове: хората не го попълват. Отговаряме „успешно“, за да не подскажем на бота.
  if (body.website) return json(res, 200, { ok: true });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
  if (!(await verifyTurnstile(body.turnstile, ip))) return json(res, 400, { ok: false, error: "captcha_failed", message: MESSAGES.captcha_failed });

  const lead = {
    building: String(body.building || "").slice(0, 60),
    apartment: String(body.apartment || "").slice(0, 40),
    name: String(body.name || "").trim().slice(0, 200),
    phone: String(body.phone || "").trim().slice(0, 40),
    email: body.email ? String(body.email).trim().slice(0, 200) : null,
    message: body.message ? String(body.message).slice(0, 2000) : null,
    page_uri: body.page_uri ? String(body.page_uri).slice(0, 500) : null,
    placement: body.placement ? String(body.placement).slice(0, 40) : null
  };
  const day = new Date().toISOString().slice(0, 10);
  const ipHash = ip ? createHash("sha256").update(`${SALT}:${day}:${ip}`).digest("hex").slice(0, 32) : null;

  const headers = { apikey: PUBLIC_KEY, "Content-Type": "application/json" };
  if (PUBLIC_KEY.startsWith("eyJ")) headers.Authorization = `Bearer ${PUBLIC_KEY}`;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/submit_lead`, {
    method: "POST", headers,
    body: JSON.stringify({
      p_building: lead.building, p_apartment: lead.apartment, p_name: lead.name, p_phone: lead.phone, p_email: lead.email,
      p_message: lead.message, p_consent: body.consent === true, p_consent_text: body.consent_text ? String(body.consent_text).slice(0, 500) : null,
      p_page_uri: lead.page_uri, p_placement: lead.placement, p_ip_hash: ipHash,
      p_user_agent: String(req.headers["user-agent"] || "").slice(0, 300), p_utm: body.utm && typeof body.utm === "object" ? body.utm : null
    })
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const code = data && data.message && MESSAGES[data.message] ? data.message : "server_error";
    if (code === "server_error") console.error("submit_lead failed", r.status, JSON.stringify(data));
    return json(res, code === "rate_limited" ? 429 : code === "server_error" ? 502 : 422, { ok: false, error: code, message: MESSAGES[code] || "Запитването не беше изпратено. Опитайте отново след малко." });
  }

  const delivery = data.duplicate ? { sent: false, reason: "duplicate" } : await sendEmail(lead, data).catch(e => { console.error(e); return { sent: false, reason: "error" }; });
  json(res, 200, { ok: true, lead_id: data.id, emailed: delivery.sent });
}
