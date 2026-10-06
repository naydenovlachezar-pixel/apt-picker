"use client";
import { useEffect, useRef, useState } from "react";
import { supabase, WIDGET_ORIGIN } from "../lib/supabase";

// Латиница по официалната българска транслитерация, за адреса в кода за вграждане
const TR = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sht", ъ: "a", ь: "y", ю: "yu", я: "ya" };
export const toSlug = s => String(s || "").toLowerCase().split("").map(c => TR[c] ?? c).join("")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

const STAGES = ["Проект", "В строеж", "Груб строеж", "Акт 15", "Акт 16", "Завършена"];

export default function BuildingDialog({ mode, orgId, building, isOwner, onClose, onDone }) {
  const sb = supabase();
  const editing = mode === "edit";
  const [f, setF] = useState(() => editing
    ? { name: building.name || "", slug: building.slug, district: building.district || "", stage: building.stage || "", ready: building.ready_text || "", desc: building.description || "", published: !!building.published,
        emails: ((building.settings && building.settings.leads && building.settings.leads.emails) || []).join(", ") }
    : { name: "", slug: "", district: "", stage: "Проект", ready: "", desc: "", floors: "6", published: false });
  const [slugTouched, setSlugTouched] = useState(editing);
  const [slugOk, setSlugOk] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [check, setCheck] = useState(null);
  const [delName, setDelName] = useState("");
  const ref = useRef();
  useEffect(() => { ref.current && ref.current.showModal(); }, []);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));

  // Адресът се предлага от името, докато не бъде редактиран ръчно
  useEffect(() => { if (!slugTouched) set("slug", toSlug(f.name)); }, [f.name]);
  useEffect(() => {
    if (editing || !f.slug) { setSlugOk(null); return; }
    const t = setTimeout(async () => { const { data } = await sb.rpc("slug_available", { p_slug: f.slug }); setSlugOk(!!data); }, 350);
    return () => clearTimeout(t);
  }, [f.slug]);

  // Проверка за готовност преди показване на сайта
  useEffect(() => {
    if (!editing) return;
    (async () => {
      const [{ data: b }, { data: fl }, { count }] = await Promise.all([
        sb.from("buildings").select("facade").eq("id", building.id).single(),
        sb.from("floors").select("facade_polygon").eq("building_id", building.id),
        sb.from("apartments").select("id", { count: "exact", head: true }).eq("building_id", building.id)
      ]);
      setCheck({ facade: !!(b && b.facade && b.facade.image_url), floors: (fl || []).length, outlined: (fl || []).filter(x => x.facade_polygon && x.facade_polygon.t).length, apts: count || 0 });
    })();
  }, []);

  async function submit(e) {
    e.preventDefault(); setErr("");
    if (!f.name.trim()) return setErr("Въведете име на сградата.");
    setBusy(true);
    if (editing) {
      const emails = f.emails.split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
      const bad = emails.find(x => !/^\S+@\S+\.\S+$/.test(x));
      if (bad) { setBusy(false); return setErr(`„${bad}“ не изглежда като имейл адрес.`); }
      const settings = { ...(building.settings || {}), leads: { ...((building.settings || {}).leads || {}), emails } };
      const { error } = await sb.from("buildings").update({
        name: f.name.trim(), short_name: f.name.trim(), district: f.district.trim() || null, stage: f.stage.trim() || null,
        ready_text: f.ready.trim() || null, description: f.desc.trim() || null, published: f.published, settings
      }).eq("id", building.id);
      setBusy(false);
      if (error) return setErr("Не е запазено: " + error.message);
      onDone({ id: building.id, message: f.published && !building.published ? "Сградата вече се показва на сайта." : "Данните за сградата са запазени." });
    } else {
      const { data, error } = await sb.rpc("create_building", { p_org: orgId, p_name: f.name, p_slug: f.slug, p_district: f.district, p_stage: f.stage, p_ready: f.ready, p_desc: f.desc, p_floors: parseInt(f.floors, 10) });
      setBusy(false);
      if (error) return setErr(error.message);
      onDone({ id: data.id, created: true, message: "Сградата е създадена и е скрита от сайта. Качете снимка на фасадата и очертайте етажите." });
    }
  }

  async function removeBuilding() {
    setErr(""); setBusy(true);
    const { error } = await sb.rpc("delete_building", { p_building: building.id, p_confirm_name: delName });
    if (error) { setBusy(false); return setErr(error.message); }
    // Снимките и чертежите на сградата в хранилището вече не са нужни
    try {
      const st = sb.storage.from("media"), dir = `${orgId}/${building.id}`;
      const { data: files } = await st.list(dir, { limit: 1000 });
      if (files && files.length) await st.remove(files.map(x => `${dir}/${x.name}`));
    } catch { }
    setBusy(false);
    onDone({ deleted: true, message: `Сградата „${building.name}“ е изтрита.` });
  }

  const code = `<div data-apt-picker data-building="${f.slug}"></div>\n<script src="${WIDGET_ORIGIN}/embed.js" async></script>`;
  async function copy() { try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { } }
  const ready = check && check.facade && check.floors > 0 && check.outlined === check.floors && check.apts > 0;

  return (
    <dialog ref={ref} className="dlg bd" onCancel={e => { e.preventDefault(); onClose(); }} aria-labelledby="bd-title">
      <form onSubmit={submit} noValidate>
        <h2 id="bd-title">{editing ? `Данни за ${building.name}` : "Нова сграда"}</h2>
        <div className="bd-grid">
          <div className="field wide"><label htmlFor="bd-name">Име</label><input id="bd-name" value={f.name} onChange={e => set("name", e.target.value)} placeholder="Резиденция „Лозенец“" autoFocus /></div>
          <div className="field wide"><label htmlFor="bd-slug">Адрес в кода за вграждане</label>
            <input id="bd-slug" value={f.slug} disabled={editing} onChange={e => { setSlugTouched(true); set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")); }} placeholder="rezidentsiya-lozenets" />
            {!editing && f.slug && slugOk !== null && <span className={slugOk ? "ok" : "bad"}>{slugOk ? "Свободен" : "Зает или невалиден. Само малки латински букви, цифри и тире."}</span>}
            {editing && <span className="muted">Адресът не се сменя, за да не спре кодът на вече вградените сайтове.</span>}</div>
          <div className="field"><label htmlFor="bd-district">Квартал или град</label><input id="bd-district" value={f.district} onChange={e => set("district", e.target.value)} placeholder="Лозенец" /></div>
          <div className="field"><label htmlFor="bd-stage">Етап</label><input id="bd-stage" list="bd-stages" value={f.stage} onChange={e => set("stage", e.target.value)} /><datalist id="bd-stages">{STAGES.map(s => <option key={s} value={s} />)}</datalist></div>
          <div className="field"><label htmlFor="bd-ready">Срок</label><input id="bd-ready" value={f.ready} onChange={e => set("ready", e.target.value)} placeholder="Акт 16 през 2028" /></div>
          {!editing && <div className="field"><label htmlFor="bd-floors">Брой етажи</label><input id="bd-floors" inputMode="numeric" value={f.floors} onChange={e => set("floors", e.target.value.replace(/\D/g, ""))} /></div>}
          <div className="field wide"><label htmlFor="bd-desc">Кратко описание</label><textarea id="bd-desc" rows={2} value={f.desc} onChange={e => set("desc", e.target.value)} /></div>
          {editing && <div className="field wide"><label htmlFor="bd-emails">Имейли за нови запитвания</label>
            <input id="bd-emails" value={f.emails} onChange={e => set("emails", e.target.value)} placeholder="sales@firma.bg, ivan@firma.bg" />
            <span className="muted">Разделени със запетая. Ако е празно, имейлът отива до собственика на акаунта.</span></div>}
        </div>

        {editing && <div className="bd-pub">
          <label className="chk"><input type="checkbox" checked={f.published} onChange={e => set("published", e.target.checked)} /> Показвай сградата на сайта</label>
          {check && !ready && <p className="warn">Преди да я покажете: {[!check.facade && "качете снимка на фасадата", check.floors && check.outlined < check.floors && `очертайте етажите (${check.outlined} от ${check.floors})`, !check.apts && "добавете разпределение с апартаменти"].filter(Boolean).join(", ")}.</p>}
          <div className="bd-code"><b>Код за вграждане</b><pre>{code}</pre><button type="button" className="btn ghost" onClick={copy}>{copied ? "Копирано" : "Копирай кода"}</button></div>
        </div>}

        {editing && isOwner && <details className="bd-danger">
          <summary>Изтриване на сградата</summary>
          <p>Изтриват се всички входове, етажи, разпределения, апартаменти, историята и запитванията за тази сграда. Това не може да се върне.</p>
          {building.published
            ? <p className="warn">Сградата се показва на сайта. Първо махнете отметката „Показвай сградата на сайта“ и запазете.</p>
            : <>
              <div className="field"><label htmlFor="bd-del">За потвърждение напишете името: <b>{building.name}</b></label>
                <input id="bd-del" value={delName} onChange={e => setDelName(e.target.value)} autoComplete="off" /></div>
              <button type="button" className="btn danger" onClick={removeBuilding} disabled={busy || delName.trim() !== building.name.trim()}>Изтрий сградата завинаги</button>
            </>}
        </details>}

        {err && <p className="err" role="alert">{err}</p>}
        <div className="dlg-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Отказ</button>
          <button className="btn primary" disabled={busy || (!editing && slugOk === false)}>{busy ? "Запазване…" : editing ? "Запази" : "Създай сградата"}</button>
        </div>
      </form>
    </dialog>
  );
}
