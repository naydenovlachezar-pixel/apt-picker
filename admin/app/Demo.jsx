"use client";
import { Fragment, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { toSlug } from "./BuildingDialog";

// Кой е отворил демо сайта по личен линк (?ref=...). Само за администратора на платформата.
const DEMO_URL = "https://liniya-demo.vercel.app/?crm=1&ref=";
const EVENTS = { view: "Отвори демото", picker_view: "Стигна до избора на апартамент", inquiry: "Изпрати тестово запитване", crm_open: "Отвори CRM демото" };
const when = d => new Date(d).toLocaleString("bg-BG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const ago = d => {
  const m = Math.round((Date.now() - new Date(d)) / 60000);
  if (m < 1) return "току-що";
  if (m < 60) return `преди ${m} мин`;
  const h = Math.round(m / 60);
  if (h < 24) return `преди ${h} ч`;
  const days = Math.round(h / 24);
  return days === 1 ? "вчера" : `преди ${days} дни`;
};
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

function Log({ ref_, say }) {
  const sb = supabase();
  const [rows, setRows] = useState(null);
  useEffect(() => {
    sb.rpc("demo_visits_log", { p_ref: ref_, p_limit: 100 }).then(({ data, error }) => {
      if (error) { say(error.message, true); setRows([]); return; }
      setRows(data || []);
    });
  }, [ref_]);
  if (!rows) return <p className="muted demo-log">Зареждане…</p>;
  return <ol className="demo-log">
    {rows.map((r, i) => <li key={i}><span className="muted">{when(r.created_at)}</span> {EVENTS[r.event] || r.event}{r.detail ? `: ${r.detail}` : ""}</li>)}
  </ol>;
}

export function DemoVisits({ say }) {
  const sb = supabase();
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);
  const [name, setName] = useState("");
  const [copied, setCopied] = useState(false);

  async function load() {
    const { data, error } = await sb.rpc("demo_visits_summary");
    if (error) { say("Посещенията не се заредиха: " + error.message, true); setRows([]); return; }
    setRows(data || []);
  }
  useEffect(() => { load(); }, []);

  const slug = toSlug(name);
  const link = slug ? DEMO_URL + slug : "";
  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { }
  }

  return <section className="demo-visits">
    <div className="demo-head">
      <div><h2>Посещения на демото</h2>
        <p className="muted">Кой е отворил демо сайта по личния си линк. Общият трафик е във Vercel → liniya-demo → Analytics.</p></div>
      <button className="btn ghost" onClick={() => { setRows(null); setOpen(null); load(); }}>Обнови</button>
    </div>

    <div className="tcard demo-link">
      <div className="tbar">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Име на компанията, например Строй Груп" aria-label="Име на компанията за личния линк" />
        <code>{link || DEMO_URL + "…"}</code>
        <button className="btn ghost" disabled={!link} onClick={copy}>{copied ? "Копирано" : "Копирай линка"}</button>
      </div>
    </div>

    {!rows ? <p className="empty">Зареждане…</p>
      : !rows.length ? <p className="empty">Още никой не е отварял демото по личен линк.</p>
      : <div className="tcard"><div className="tablewrap">
        <table className="team demo-table">
          <thead><tr><th>Компания (ref)</th><th>Последно</th><th className="r">Отваряния</th><th>Стигна до избора</th><th>Тестово запитване</th><th>Първо отваряне</th></tr></thead>
          <tbody>{rows.map(r => <Fragment key={r.ref}>
            <tr className={open === r.ref ? "is-open" : ""} onClick={() => setOpen(open === r.ref ? null : r.ref)}>
              <td><b>{r.ref}</b>{r.referrer && host(r.referrer) && <span className="sub">дошъл от {host(r.referrer)}</span>}</td>
              <td>{ago(r.last_seen)}<span className="sub">{when(r.last_seen)}</span></td>
              <td className="r">{r.views}<span className="sub">{r.sessions} {r.sessions === 1 ? "сесия" : "сесии"}</span></td>
              <td>{r.reached_picker ? <span className="tag-yes">да</span> : <span className="muted">не</span>}</td>
              <td>{r.inquiries ? <><span className="tag-yes">{r.inquiries}</span>{r.last_inquiry && <span className="sub">{r.last_inquiry}</span>}</> : <span className="muted">не</span>}</td>
              <td className="muted">{when(r.first_seen)}</td>
            </tr>
            {open === r.ref && <tr className="log-row"><td colSpan={6}><Log ref_={r.ref} say={say} /></td></tr>}
          </Fragment>)}</tbody>
        </table>
      </div></div>}
  </section>;
}
