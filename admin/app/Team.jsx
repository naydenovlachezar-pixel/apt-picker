"use client";
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { toSlug } from "./BuildingDialog";
import "./team.css";

export const ROLES = { owner: "Собственик", editor: "Редактор", viewer: "Само преглед" };
const ROLE_HINT = {
  owner: "всичко, включително покани, изтриване на сгради и запитвания",
  editor: "сгради, цени, статуси и запитвания",
  viewer: "само преглед, без промени"
};
const fmt = d => new Date(d).toLocaleDateString("bg-BG", { day: "numeric", month: "short", year: "numeric" });

function InviteNote({ who, onClose }) {
  const link = typeof window !== "undefined" ? window.location.origin : "";
  const [copied, setCopied] = useState(false);
  const text = `Здравейте, поканих ви в панела за избор на апартамент. Влезте на ${link} с имейла ${who.email}. Ще получите линк за вход по имейл.`;
  return <div className="note invite-note">
    <b>{who.status === "added" ? `${who.email} вече има достъп.` : `Поканата за ${who.email} е готова.`}</b>
    <p>Изпратете на човека линка към панела. Той влиза с този имейл и получава линк за вход в пощата си.</p>
    <div className="le-row"><code>{link}</code>
      <button type="button" className="btn ghost" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { } }}>{copied ? "Копирано" : "Копирай съобщение с линка"}</button>
      <button type="button" className="linkbtn" onClick={onClose}>Скрий</button></div>
  </div>;
}

export function Team({ org, say }) {
  const sb = supabase();
  const isOwner = org.role === "owner";
  const [rows, setRows] = useState(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  async function load() {
    const { data, error } = await sb.rpc("org_team", { p_org: org.id });
    if (error) { say("Екипът не се зареди: " + error.message, true); setRows([]); return; }
    setRows(data || []);
  }
  useEffect(() => { setRows(null); setDone(null); load(); }, [org.id]);

  async function invite(e) {
    e.preventDefault();
    setBusy(true);
    const { data, error } = await sb.rpc("invite_member", { p_org: org.id, p_email: email, p_role: role });
    setBusy(false);
    if (error) return say(error.message, true);
    setDone(data); setEmail(""); load();
  }
  async function call(fn, args, msg) {
    const { error } = await sb.rpc(fn, args);
    if (error) return say(error.message, true);
    say(msg); load();
  }

  if (!rows) return <p className="empty">Зареждане на екипа…</p>;
  const members = rows.filter(r => r.kind === "member"), pending = rows.filter(r => r.kind === "invite");
  return <>
    <section className="bhead"><div className="bh-title"><h1>Екип</h1><p><span>{org.name}</span><span>{members.length} {members.length === 1 ? "човек" : "души"} с достъп</span></p></div></section>

    {isOwner && <form className="tcard invite-form" onSubmit={invite}>
      <div className="tbar">
        <input type="email" placeholder="Имейл, например maria@firma.bg" value={email} onChange={e => setEmail(e.target.value)} aria-label="Имейл на човека" required />
        <select value={role} onChange={e => setRole(e.target.value)} aria-label="Роля">{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <button className="btn primary" disabled={busy || !email.trim()}>{busy ? "Каня…" : "Покани"}</button>
        <span className="muted role-hint">{ROLES[role]}: {ROLE_HINT[role]}.</span>
      </div>
    </form>}
    {done && <InviteNote who={done} onClose={() => setDone(null)} />}

    <div className="tcard">
      <div className="tablewrap">
        <table className="team">
          <thead><tr><th>Имейл</th><th>Роля</th><th>От</th>{isOwner && <th><span className="vh">Действия</span></th>}</tr></thead>
          <tbody>
            {members.map(m => <tr key={m.user_id}>
              <td><b>{m.email}</b>{m.is_me && <span className="tag-me">вие</span>}</td>
              <td>{isOwner && !m.is_me
                ? <select value={m.role} aria-label={`Роля на ${m.email}`} onChange={e => call("set_member_role", { p_org: org.id, p_user: m.user_id, p_role: e.target.value }, `${m.email}: ${ROLES[e.target.value].toLowerCase()}.`)}>
                    {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                : ROLES[m.role]}</td>
              <td className="muted">{fmt(m.since)}</td>
              {isOwner && <td className="r">{!m.is_me && <button className="del-btn" onClick={() => confirm(`Да се махне ли достъпът на ${m.email}?`) && call("remove_member", { p_org: org.id, p_user: m.user_id }, `${m.email} вече няма достъп.`)}>Махни достъпа</button>}</td>}
            </tr>)}
            {pending.map(p => <tr key={p.email} className="pending">
              <td><b>{p.email}</b><span className="tag-pending">поканен, още не е влизал</span></td>
              <td>{ROLES[p.role]}</td>
              <td className="muted">{fmt(p.since)}</td>
              {isOwner && <td className="r"><button className="del-btn" onClick={() => call("revoke_invite", { p_org: org.id, p_email: p.email }, `Поканата за ${p.email} е отменена.`)}>Отмени поканата</button></td>}
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>
    {!isOwner && <p className="muted team-foot">Само собственикът на акаунта може да кани и маха хора.</p>}
  </>;
}

export function Developers({ say, onOpenOrg }) {
  const sb = supabase();
  const [rows, setRows] = useState(null);
  const [f, setF] = useState({ name: "", slug: "", email: "" });
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  async function load() {
    const { data, error } = await sb.rpc("admin_orgs");
    if (error) { say(error.message, true); setRows([]); return; }
    setRows(data || []);
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { if (!slugTouched) setF(x => ({ ...x, slug: toSlug(x.name) })); }, [f.name]);

  async function create(e) {
    e.preventDefault();
    setBusy(true);
    const { data, error } = await sb.rpc("admin_create_org", { p_name: f.name, p_slug: f.slug, p_owner_email: f.email });
    setBusy(false);
    if (error) return say(error.message, true);
    say(`Строителят „${f.name.trim()}“ е създаден.`);
    setDone(data.owner); setF({ name: "", slug: "", email: "" }); setSlugTouched(false); load();
  }

  if (!rows) return <p className="empty">Зареждане на строителите…</p>;
  return <>
    <section className="bhead"><div className="bh-title"><h1>Строители</h1><p><span>Само за собственика на платформата</span><span>{rows.length} общо</span></p></div></section>

    <form className="tcard dev-form" onSubmit={create}>
      <div className="dev-grid">
        <div className="field"><label htmlFor="dv-name">Име на строителя</label><input id="dv-name" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="Строй Груп ООД" required /></div>
        <div className="field"><label htmlFor="dv-slug">Кратко име</label><input id="dv-slug" value={f.slug} onChange={e => { setSlugTouched(true); setF({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") }); }} placeholder="stroy-grup" required /></div>
        <div className="field"><label htmlFor="dv-email">Имейл на собственика</label><input id="dv-email" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} placeholder="ivan@stroygrup.bg" required /></div>
        <button className="btn primary" disabled={busy}>{busy ? "Създаване…" : "Създай и покани"}</button>
      </div>
      <p className="muted">Собственикът влиза в празен панел и сам създава сградите си. Колеги кани от „Екип“.</p>
    </form>
    {done && <InviteNote who={done} onClose={() => setDone(null)} />}

    <div className="tcard">
      <div className="tablewrap">
        <table className="team">
          <thead><tr><th>Строител</th><th>Собственик</th><th className="r">Сгради</th><th>Създаден</th><th><span className="vh">Действия</span></th></tr></thead>
          <tbody>{rows.map(o => <tr key={o.id}>
            <td><b>{o.name}</b><span className="sub">{o.slug}</span></td>
            <td>{o.owners || <span className="tag-pending">{o.pending ? `${o.pending}, още не е влизал` : "няма собственик"}</span>}</td>
            <td className="r">{o.buildings}{o.buildings ? <span className="muted">, {o.published} на сайта</span> : ""}</td>
            <td className="muted">{fmt(o.created_at)}</td>
            <td className="r"><button className="linkbtn" onClick={() => onOpenOrg(o)}>Екип</button></td>
          </tr>)}</tbody>
        </table>
      </div>
    </div>
  </>;
}
