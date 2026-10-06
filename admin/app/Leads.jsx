"use client";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

export const STAGES = { new: "Ново", contacted: "Свързахме се", viewing: "Оглед", closed: "Приключено", spam: "Спам" };
const FIELDS = "id, building_id, apartment_id, name, phone, email, message, page_uri, placement, stage, notes, snapshot, created_at, updated_at";
const when = d => {
  const t = new Date(d), now = new Date(), mins = Math.round((now - t) / 60000);
  if (mins < 1) return "току-що";
  if (mins < 60) return `преди ${mins} мин`;
  if (t.toDateString() === now.toDateString()) return `днес, ${t.toLocaleTimeString("bg-BG", { hour: "2-digit", minute: "2-digit" })}`;
  return t.toLocaleString("bg-BG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};
const aptText = l => { const s = l.snapshot || {}; return s.label ? `${s.label}${s.section ? `, ${s.section}` : ""}${s.floor != null ? `, ет. ${s.floor}` : ""}` : "без апартамент"; };

export default function Leads({ buildings, canEdit, isOwner, onOpenApt, onCount, say }) {
  const sb = supabase();
  const [rows, setRows] = useState(null);
  const [bf, setBf] = useState("");
  const [sf, setSf] = useState("open");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);
  const ids = useMemo(() => buildings.map(b => b.id), [buildings]);
  const bName = id => (buildings.find(b => b.id === id) || {}).name || "";

  useEffect(() => {
    if (!ids.length) { setRows([]); return; }
    sb.from("leads").select(FIELDS).in("building_id", ids).order("created_at", { ascending: false }).limit(1000).then(({ data, error }) => {
      if (error) { say("Запитванията не се заредиха: " + error.message, true); setRows([]); return; }
      setRows(data || []);
    });
    const ch = sb.channel("leads-inbox")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "leads", filter: `building_id=in.(${ids.join(",")})` }, p => {
        setRows(r => r && !r.some(x => x.id === p.new.id) ? [p.new, ...r] : r);
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "leads", filter: `building_id=in.(${ids.join(",")})` }, p => {
        setRows(r => r && r.map(x => x.id === p.new.id ? { ...x, ...p.new } : x));
      })
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [ids.join(",")]);

  useEffect(() => { if (rows) onCount(rows.filter(r => r.stage === "new").length); }, [rows]);

  async function update(l, patch, msg) {
    const prev = rows.find(x => x.id === l.id);
    setRows(r => r.map(x => x.id === l.id ? { ...x, ...patch } : x));
    if (open && open.id === l.id) setOpen(o => ({ ...o, ...patch }));
    const { error } = await sb.from("leads").update(patch).eq("id", l.id);
    if (error) { setRows(r => r.map(x => x.id === l.id ? prev : x)); return say("Не е запазено: " + error.message, true); }
    if (msg) say(msg);
  }
  async function remove(l) {
    if (!confirm(`Да се изтрие ли запитването от ${l.name}? Това не може да се върне.`)) return;
    const { error } = await sb.from("leads").delete().eq("id", l.id);
    if (error) return say("Не е изтрито: " + error.message, true);
    setRows(r => r.filter(x => x.id !== l.id)); setOpen(null); say("Запитването е изтрито.");
  }

  const list = (rows || []).filter(l => (!bf || l.building_id === bf)
    && (sf === "all" ? l.stage !== "spam" : sf === "open" ? !["closed", "spam"].includes(l.stage) : l.stage === sf)
    && (!q || [l.name, l.phone, l.email, (l.snapshot || {}).label].some(v => v && String(v).toLowerCase().includes(q.toLowerCase()))));

  function exportCsv() {
    const esc = v => { const s = String(v == null ? "" : v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [["Дата", "Сграда", "Апартамент", "Име", "Телефон", "Имейл", "Съобщение", "Статус", "Бележка", "Страница"]];
    for (const l of list) lines.push([new Date(l.created_at).toLocaleString("bg-BG"), bName(l.building_id), aptText(l), l.name, l.phone, l.email, l.message, STAGES[l.stage], l.notes, l.page_uri]);
    const url = URL.createObjectURL(new Blob(["\uFEFF" + lines.map(r => r.map(esc).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `zapitvania-${new Date().toISOString().slice(0, 10)}.csv`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (!rows) return <p className="empty">Зареждане на запитванията…</p>;
  const counts = Object.fromEntries(Object.keys(STAGES).map(k => [k, rows.filter(r => r.stage === k).length]));

  return (
    <>
      <section className="bhead"><div className="bh-title"><h1>Запитвания</h1>
        <p><span>{counts.new ? `${counts.new} ${counts.new === 1 ? "ново" : "нови"}` : "Няма нови"}</span><span>{rows.length} общо</span></p></div>
        <div className="bh-actions"><div className="btn-group"><button onClick={exportCsv} disabled={!list.length}>Изтегли в Excel</button></div></div>
      </section>

      <div className="tcard">
        <div className="tbar" role="search" aria-label="Филтри на запитванията">
          <input type="search" placeholder="Търсене по име, телефон или апартамент" value={q} onChange={e => setQ(e.target.value)} aria-label="Търсене" />
          {buildings.length > 1 && <select value={bf} onChange={e => setBf(e.target.value)} aria-label="Сграда">
            <option value="">Всички сгради</option>{buildings.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}
          <select value={sf} onChange={e => setSf(e.target.value)} aria-label="Статус">
            <option value="open">Отворени</option><option value="all">Всички без спам</option>
            {Object.entries(STAGES).map(([k, v]) => <option key={k} value={k}>{v} ({counts[k]})</option>)}
          </select>
          <span className="spacer" /><span className="tcount">{list.length} {list.length === 1 ? "запитване" : "запитвания"}</span>
        </div>
        <div className="tablewrap">
          {!rows.length ? <div className="empty"><b>Още няма запитвания.</b><br />Когато купувач изпрати запитване от сайта, то ще се появи тук веднага, а търговецът ще получи имейл.</div>
            : !list.length ? <p className="empty">Няма запитвания с тези филтри.</p> : (
            <table className="leads">
              <thead><tr><th>Получено</th><th>Купувач</th><th>Апартамент</th><th>Съобщение</th><th>Статус</th></tr></thead>
              <tbody>{list.map(l => (
                <tr key={l.id} className={(l.stage === "new" ? "is-new " : "") + (open && open.id === l.id ? "is-open" : "")} onClick={() => setOpen(l)}>
                  <td>{l.stage === "new" && <i className="newdot" aria-label="ново" />}{when(l.created_at)}</td>
                  <td><b>{l.name}</b><span className="sub"><a href={`tel:${l.phone.replace(/[^\d+]/g, "")}`} onClick={e => e.stopPropagation()}>{l.phone}</a>{l.email ? `, ${l.email}` : ""}</span></td>
                  <td><b>{(l.snapshot || {}).label || "–"}</b><span className="sub">{bName(l.building_id)}</span></td>
                  <td className="msg">{l.message ? <div className="clamp">{l.message}</div> : <span className="muted">–</span>}</td>
                  <td onClick={e => e.stopPropagation()}>
                    <select className={"stage " + l.stage} value={l.stage} disabled={!canEdit} aria-label={`Статус на запитването от ${l.name}`}
                      onChange={e => update(l, { stage: e.target.value }, `Запитването от ${l.name}: ${STAGES[e.target.value].toLowerCase()}.`)}>
                      {Object.entries(STAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select></td>
                </tr>))}</tbody>
            </table>)}
        </div>
      </div>

      {open && <LeadDrawer l={open} building={bName(open.building_id)} canEdit={canEdit} isOwner={isOwner} onClose={() => setOpen(null)}
        onStage={k => update(open, { stage: k }, `Запитването от ${open.name}: ${STAGES[k].toLowerCase()}.`)}
        onNotes={n => update(open, { notes: n || null }, "Бележката е запазена.")} onRemove={() => remove(open)}
        onApt={() => onOpenApt(open.building_id, (open.snapshot || {}).label)} />}
    </>
  );
}

function LeadDrawer({ l, building, canEdit, isOwner, onClose, onStage, onNotes, onRemove, onApt }) {
  const [notes, setNotes] = useState(l.notes || "");
  useEffect(() => { setNotes(l.notes || ""); }, [l.id]);
  useEffect(() => { const k = e => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, []);
  const s = l.snapshot || {};
  return (
    <aside className="drawer lead-drawer" aria-label={`Запитване от ${l.name}`}>
      <div className="drawer-head"><h2>{l.name}</h2><button className="btn ghost" onClick={onClose}>Затвори</button></div>
      <p className="muted">{new Date(l.created_at).toLocaleString("bg-BG", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}</p>
      <div className="ld-contact">
        <a className="btn primary" href={`tel:${l.phone.replace(/[^\d+]/g, "")}`}>Обади се: {l.phone}</a>
        {l.email && <a className="btn" href={`mailto:${l.email}?subject=${encodeURIComponent(`Апартамент ${s.label || ""}, ${building}`)}`}>Имейл</a>}
      </div>
      <dl className="ld-facts">
        <div><dt>Сграда</dt><dd>{building}</dd></div>
        <div><dt>Апартамент</dt><dd>{s.label ? <>{s.label}{s.section ? `, ${s.section}` : ""}{s.floor != null ? `, етаж ${s.floor}` : ""}{s.gross ? `, ${Number(s.gross).toLocaleString("bg-BG")} m²` : ""}</> : "не е посочен"}</dd></div>
        {l.email && <div><dt>Имейл</dt><dd>{l.email}</dd></div>}
        {l.page_uri && <div><dt>Страница</dt><dd><a href={l.page_uri} target="_blank" rel="noopener">{l.page_uri.replace(/^https?:\/\//, "").slice(0, 60)}</a></dd></div>}
      </dl>
      {l.message && <blockquote className="ld-msg">{l.message}</blockquote>}
      <div className="field"><label>Статус</label>
        <div className="ld-stages" role="group" aria-label="Статус">{Object.entries(STAGES).map(([k, v]) =>
          <button key={k} aria-pressed={l.stage === k} disabled={!canEdit} onClick={() => l.stage !== k && onStage(k)}>{v}</button>)}</div></div>
      <div className="field"><label htmlFor="ld-notes">Бележка за екипа</label>
        <textarea id="ld-notes" rows={4} value={notes} disabled={!canEdit} placeholder="Например: оглед в четвъртък от 17:00" onChange={e => setNotes(e.target.value)}
          onBlur={() => notes !== (l.notes || "") && onNotes(notes)} /></div>
      <div className="le-row">
        {s.label && <button className="btn ghost" onClick={onApt}>Към апартамента в таблицата</button>}
        {isOwner && <button className="linkbtn danger" onClick={onRemove}>Изтрий запитването</button>}
      </div>
    </aside>
  );
}
