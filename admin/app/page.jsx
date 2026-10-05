"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase, WIDGET_ORIGIN } from "../lib/supabase";
import { readFile, buildImport, downloadCsv, STATUS_OUT } from "../lib/sheet";
import FacadeEditor from "./FacadeEditor";

const STATUS = { free: "Свободен", reserved: "Резервиран", sold: "Продаден" };
const ROOMS = { 1: "Едностаен", 2: "Двустаен", 3: "Тристаен", 4: "Четиристаен" };
const nf = new Intl.NumberFormat("bg-BG");
const m2 = n => Number(n).toLocaleString("bg-BG", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " m²";

export default function Page() {
  const [session, setSession] = useState(undefined);
  useEffect(() => {
    const sb = supabase();
    sb.auth.getSession().then(({ data }) => setSession(data.session || null));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s || null));
    return () => sub.subscription.unsubscribe();
  }, []);
  if (session === undefined) return <div className="login"><p className="muted">Зареждане…</p></div>;
  return session ? <Dashboard session={session} /> : <Login />;
}

function Login() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState("idle");
  const [error, setError] = useState("");
  async function send(e) {
    e.preventDefault();
    setError("");
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setError("Въведете имейл адрес, например ime@firma.bg.");
    setState("sending");
    const { error } = await supabase().auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { emailRedirectTo: window.location.origin }
    });
    if (error) { setState("idle"); setError(error.message.includes("rate") ? "Изпратени са твърде много линкове. Опитайте отново след няколко минути." : "Линкът не беше изпратен: " + error.message); return; }
    setState("sent");
  }
  return (
    <main className="login">
      <div className="login-box">
        <h1>Вход в админ панела</h1>
        <p>Управлявайте наличността и цените на апартаментите си. Промените се виждат на сайта веднага.</p>
        {state === "sent" ? (
          <div className="note">Изпратихме линк за вход на <b>{email}</b>. Отворете го от този браузър. Линкът важи един час.</div>
        ) : (
          <form onSubmit={send} noValidate>
            <div className="field"><label htmlFor="email">Имейл</label>
              <input id="email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required /></div>
            <button className="btn primary" disabled={state === "sending"}>{state === "sending" ? "Изпращане…" : "Изпрати линк за вход"}</button>
            {error && <p className="err" role="alert">{error}</p>}
          </form>
        )}
      </div>
    </main>
  );
}

function Dashboard({ session }) {
  const sb = supabase();
  const [orgs, setOrgs] = useState(null);
  const [orgId, setOrgId] = useState(null);
  const [buildings, setBuildings] = useState([]);
  const [bid, setBid] = useState(null);
  const [apts, setApts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [floor, setFloor] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState({});
  const [flash, setFlash] = useState({});
  const [toast, setToast] = useState(null);
  const [live, setLive] = useState(false);
  const [importing, setImporting] = useState(null);
  const [history, setHistory] = useState(null);
  const [facade, setFacade] = useState(false);
  const fileRef = useRef();
  const toastTimer = useRef();

  const org = orgs && orgs.find(o => o.id === orgId);
  const canEdit = org && org.role !== "viewer";
  const building = buildings.find(b => b.id === bid);

  function say(text, isErr) {
    setToast({ text, isErr }); clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), isErr ? 6000 : 3500);
  }

  useEffect(() => {
    sb.rpc("my_orgs").then(({ data, error }) => {
      if (error) { say("Организациите не се заредиха: " + error.message, true); setOrgs([]); return; }
      setOrgs(data || []); if (data && data.length) setOrgId(data[0].id);
    });
  }, []);

  useEffect(() => {
    if (!orgId) return;
    sb.from("buildings").select("id, slug, name, district, published, sort_order").eq("org_id", orgId).order("sort_order").then(({ data, error }) => {
      if (error) return say("Сградите не се заредиха: " + error.message, true);
      setBuildings(data || []); setBid(b => (data || []).some(x => x.id === b) ? b : (data && data[0] ? data[0].id : null));
    });
  }, [orgId]);

  function loadApts() {
    return sb.from("apartments")
      .select("id, code, label, unit_key, rooms, gross_area, net_area, price, price_visible, status, updated_at, floor:floors(number)")
      .eq("building_id", bid)
      .then(({ data, error }) => {
        if (error) return say("Апартаментите не се заредиха: " + error.message, true);
        setApts((data || []).map(a => ({ ...a, floor: a.floor ? a.floor.number : null })).sort((a, b) => a.floor - b.floor || a.unit_key.localeCompare(b.unit_key)));
      });
  }

  useEffect(() => {
    if (!bid) return;
    setLoading(true); setFloor(""); setQ("");
    sb.from("apartments")
      .select("id, code, label, unit_key, rooms, gross_area, net_area, price, price_visible, status, updated_at, floor:floors(number)")
      .eq("building_id", bid)
      .then(({ data, error }) => {
        setLoading(false);
        if (error) return say("Апартаментите не се заредиха: " + error.message, true);
        setApts((data || []).map(a => ({ ...a, floor: a.floor ? a.floor.number : null })).sort((a, b) => a.floor - b.floor || a.unit_key.localeCompare(b.unit_key)));
      });
  }, [bid]);

  // Промени от други потребители и от HubSpot идват на живо
  useEffect(() => {
    if (!bid) return;
    const ch = sb.channel("admin-" + bid)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "apartments", filter: `building_id=eq.${bid}` }, p => {
        setApts(list => list.map(a => a.id === p.new.id ? { ...a, status: p.new.status, price: p.new.price, price_visible: p.new.price_visible, updated_at: p.new.updated_at } : a));
        mark(p.new.id);
      })
      .subscribe(s => setLive(s === "SUBSCRIBED"));
    return () => { sb.removeChannel(ch); setLive(false); };
  }, [bid]);

  function mark(id) { setFlash(f => ({ ...f, [id]: Date.now() })); setTimeout(() => setFlash(f => { const n = { ...f }; delete n[id]; return n; }), 1500); }

  async function save(a, patch, message) {
    setBusy(b => ({ ...b, [a.id]: true }));
    const prev = apts.find(x => x.id === a.id);
    setApts(list => list.map(x => x.id === a.id ? { ...x, ...patch } : x));
    const { data, error } = await sb.from("apartments").update(patch).eq("id", a.id).select("id, status, price, price_visible, updated_at");
    setBusy(b => { const n = { ...b }; delete n[a.id]; return n; });
    if (error || !data || !data.length) {
      setApts(list => list.map(x => x.id === a.id ? prev : x));
      return say(error ? "Промяната не е записана: " + error.message : "Нямате права да променяте този апартамент.", true);
    }
    mark(a.id); say(message);
  }

  async function onFile(e) {
    const file = e.target.files && e.target.files[0]; e.target.value = "";
    if (!file) return;
    try {
      const res = buildImport(await readFile(file), apts);
      if (res.error) return say(res.error, true);
      setImporting({ file: file.name, ...res, state: "review" });
    } catch (err) { say(err.message || "Файлът не можа да се прочете.", true); }
  }

  async function applyImport() {
    setImporting(im => ({ ...im, state: "saving" }));
    const { data, error } = await sb.rpc("import_apartments", { p_building: bid, p_rows: importing.changes.map(c => c.patch) });
    if (error) { setImporting(im => ({ ...im, state: "review" })); return say("Внасянето не е приложено: " + error.message, true); }
    setImporting(null);
    await loadApts();
    say(data.updated ? `Внесени промени: ${data.updated}. Сайтът е обновен.` : "Нямаше какво да се промени.");
  }

  async function openHistory() {
    setHistory({ loading: true, rows: [] });
    const { data, error } = await sb.rpc("building_history", { p_building: bid, p_limit: 200 });
    if (error) { setHistory(null); return say("Историята не се зареди: " + error.message, true); }
    setHistory({ loading: false, rows: data || [] });
  }

  const floors = useMemo(() => [...new Set(apts.map(a => a.floor))].sort((a, b) => a - b), [apts]);
  const list = apts.filter(a => (!floor || a.floor === +floor) && (!status || a.status === status) && (!q || a.label.toLowerCase().includes(q.toLowerCase()) || a.code.toLowerCase().includes(q.toLowerCase())));
  const count = s => apts.filter(a => a.status === s).length;
  const total = apts.length || 1;

  if (orgs === null) return <div className="login"><p className="muted">Зареждане…</p></div>;
  if (!orgs.length) return (
    <main className="login"><div className="login-box">
      <h1>Нямате достъп до организация</h1>
      <p>Влезли сте като <b>{session.user.email}</b>, но този имейл не е добавен към строител. Помолете собственика на акаунта да ви покани.</p>
      <button className="btn" onClick={() => sb.auth.signOut()}>Изход</button>
    </div></main>
  );

  return (
    <>
      <header className="top">
        <span className="org">{org ? org.name : ""}</span>
        {orgs.length > 1 && <select value={orgId || ""} onChange={e => setOrgId(e.target.value)} aria-label="Организация">{orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
        <span className={"live" + (live ? " on" : "")}><i aria-hidden="true" />{live ? "Промените се синхронизират на живо" : "Свързване…"}</span>
        <span className="spacer" />
        <span className="who">{session.user.email}{org && org.role === "viewer" ? ", само преглед" : ""}</span>
        <button className="btn ghost" onClick={() => sb.auth.signOut()}>Изход</button>
      </header>
      <main className="wrap">
        <div className="tabs" role="tablist" aria-label="Сгради">
          {buildings.map(b => (
            <button key={b.id} className="tab" role="tab" aria-selected={b.id === bid} onClick={() => setBid(b.id)}>
              <b>{b.name}</b><span>{b.district}{b.published ? "" : ", скрита от сайта"}</span>
            </button>
          ))}
        </div>

        {building && <>
          <div className="tally" aria-live="polite">
            <div className="free"><b>{count("free")}</b><span>свободни</span></div>
            <div className="reserved"><b>{count("reserved")}</b><span>резервирани</span></div>
            <div className="sold"><b>{count("sold")}</b><span>продадени</span></div>
            <div><b>{apts.length}</b><span>общо в сградата</span></div>
          </div>
          <div className="bar" aria-hidden="true">
            <i className="free" style={{ width: count("free") / total * 100 + "%" }} />
            <i className="reserved" style={{ width: count("reserved") / total * 100 + "%" }} />
            <i className="sold" style={{ width: count("sold") / total * 100 + "%" }} />
          </div>

          <div className="tools">
            <input type="search" placeholder="Търсене по номер, напр. 5А" value={q} onChange={e => setQ(e.target.value)} aria-label="Търсене по номер" />
            <select value={floor} onChange={e => setFloor(e.target.value)} aria-label="Етаж">
              <option value="">Всички етажи</option>{floors.map(f => <option key={f} value={f}>Етаж {f}</option>)}
            </select>
            <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Статус">
              <option value="">Всички статуси</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <span className="spacer" />
            <button className="btn ghost" onClick={() => setFacade(true)}>Фасада</button>
            <button className="btn ghost" onClick={openHistory}>История</button>
            <button className="btn ghost" onClick={() => downloadCsv(apts, building.name)} disabled={!apts.length}>Изтегли таблицата</button>
            {canEdit && <><button className="btn ghost" onClick={() => fileRef.current.click()}>Внеси от файл</button>
              <input ref={fileRef} type="file" accept=".xlsx,.csv" hidden onChange={onFile} /></>}
            <a className="btn ghost" href={`${WIDGET_ORIGIN}/embed.html?b=${building.slug}`} target="_blank" rel="noopener">Виж на сайта</a>
          </div>

          <div className="tablewrap">
            {loading ? <p className="empty">Зареждане на апартаментите…</p> : !list.length ? <p className="empty">Няма апартаменти с тези филтри.</p> : (
              <table>
                <thead><tr><th>Апартамент</th><th>Етаж</th><th>Тип</th><th className="r">Обща площ</th><th className="r">Цена, €</th><th>Цена на сайта</th><th>Статус</th></tr></thead>
                <tbody>{list.map(a => (
                  <Row key={a.id} a={a} canEdit={canEdit} busy={!!busy[a.id]} flash={!!flash[a.id]} save={save} />
                ))}</tbody>
              </table>
            )}
          </div>
        </>}
      </main>
      {importing && <ImportDialog im={importing} building={building} onCancel={() => setImporting(null)} onApply={applyImport} />}
      {facade && building && <FacadeEditor building={building} orgId={orgId} canEdit={canEdit} onClose={() => setFacade(false)} />}
      {history && <HistoryPanel h={history} building={building} onClose={() => setHistory(null)} />}
      {toast && <div className={"toast" + (toast.isErr ? " err" : "")} role="status">{toast.text}</div>}
    </>
  );
}

function Row({ a, canEdit, busy, flash, save }) {
  const shown = a.price == null ? "" : nf.format(Math.round(a.price));
  const [price, setPrice] = useState(shown);
  useEffect(() => { setPrice(shown); }, [a.price]);
  function commitPrice() {
    const v = price.replace(/[^\d]/g, "");
    const next = v === "" ? null : Number(v);
    if (next === (a.price == null ? null : Math.round(a.price))) return setPrice(shown);
    save(a, { price: next }, next == null ? `Апартамент ${a.label}: цената е изтрита.` : `Апартамент ${a.label}: новата цена е ${nf.format(next)} €.`);
  }
  return (
    <tr className={(busy ? "saving " : "") + (flash ? "flash" : "")}>
      <td className="num">{a.label}</td>
      <td>{a.floor}</td>
      <td>{ROOMS[a.rooms] || a.rooms + " стаи"}</td>
      <td className="r">{m2(a.gross_area)}</td>
      <td className="r">
        <input className="price" inputMode="numeric" aria-label={`Цена на апартамент ${a.label}`} value={price} disabled={!canEdit}
          onChange={e => setPrice(e.target.value)} onBlur={commitPrice} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setPrice(shown); e.currentTarget.blur(); } }} />
      </td>
      <td>
        <label className="chk"><input type="checkbox" checked={a.price_visible} disabled={!canEdit}
          onChange={e => save(a, { price_visible: e.target.checked }, e.target.checked ? `Апартамент ${a.label}: цената се показва на сайта.` : `Апартамент ${a.label}: на сайта пише „по запитване“.`)} />
          {a.price_visible ? "Показва се" : "По запитване"}</label>
      </td>
      <td>
        <div className="seg" role="group" aria-label={`Статус на апартамент ${a.label}`}>
          {Object.entries(STATUS).map(([k, v]) => (
            <button key={k} className={k} aria-pressed={a.status === k} disabled={!canEdit || busy}
              onClick={() => a.status !== k && save(a, { status: k }, `Апартамент ${a.label}: ${v.toLowerCase()}. Сайтът е обновен.`)}>{v}</button>
          ))}
        </div>
      </td>
    </tr>
  );
}

function ImportDialog({ im, building, onCancel, onApply }) {
  const ref = useRef();
  useEffect(() => { ref.current && ref.current.showModal(); }, []);
  const n = im.changes.length;
  return (
    <dialog ref={ref} className="dlg" onCancel={e => { e.preventDefault(); onCancel(); }} aria-labelledby="imp-title">
      <h2 id="imp-title">Внасяне в {building ? building.name : ""}</h2>
      <p className="muted">{im.file}: {n ? `${n} ${n === 1 ? "апартамент ще се промени" : "апартамента ще се променят"}` : "няма промени спрямо сегашните данни"}{im.unchanged ? `, ${im.unchanged} без промяна` : ""}.</p>
      {im.problems.length > 0 && <div className="problems"><b>Пропуснати редове ({im.problems.length})</b><ul>{im.problems.slice(0, 12).map((p, i) => <li key={i}>{p}</li>)}</ul>{im.problems.length > 12 && <p className="muted">и още {im.problems.length - 12}.</p>}</div>}
      {n > 0 && <div className="changes"><table><thead><tr><th>Апартамент</th><th>Етаж</th><th>Промяна</th></tr></thead>
        <tbody>{im.changes.map(c => <tr key={c.patch.code}><td className="num">{c.label}</td><td>{c.floor}</td><td>{c.diff.join(", ")}</td></tr>)}</tbody></table></div>}
      <div className="dlg-actions">
        <button className="btn" onClick={onCancel}>Отказ</button>
        <button className="btn primary" onClick={onApply} disabled={!n || im.state === "saving"}>{im.state === "saving" ? "Прилагане…" : n ? `Приложи ${n} ${n === 1 ? "промяна" : "промени"}` : "Няма промени"}</button>
      </div>
    </dialog>
  );
}

const SOURCE = { admin: "от панела", import: "от файл", hubspot: "от HubSpot", api: "от системата" };
function describe(r) {
  const out = [];
  if (r.old_status !== r.new_status) out.push(`${r.old_status ? STATUS_OUT[r.old_status] : "Нов"} → ${STATUS_OUT[r.new_status]}`);
  if (r.old_price !== r.new_price) out.push(`цена ${r.old_price == null ? "няма" : nf.format(Math.round(r.old_price)) + " €"} → ${r.new_price == null ? "няма" : nf.format(Math.round(r.new_price)) + " €"}`);
  if (r.old_price_visible !== r.new_price_visible && r.old_price_visible != null) out.push(r.new_price_visible ? "цената се показва" : "цена по запитване");
  return out.join(", ") || "без видима промяна";
}
function HistoryPanel({ h, building, onClose }) {
  useEffect(() => { const k = e => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, []);
  return (
    <aside className="drawer" aria-label="История на промените">
      <div className="drawer-head"><h2>История</h2><button className="btn ghost" onClick={onClose}>Затвори</button></div>
      <p className="muted">{building ? building.name : ""}, последните промени на статус и цена.</p>
      {h.loading ? <p className="muted">Зареждане…</p> : !h.rows.length ? <p className="muted">Още няма промени. Всяка смяна от панела, от файл или от HubSpot ще се вижда тук.</p> : (
        <ol className="hist">{h.rows.map((r, i) => (
          <li key={i}>
            <div><b>{r.label}</b> {describe(r)}</div>
            <div className="muted">{new Date(r.changed_at).toLocaleString("bg-BG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}, {SOURCE[r.source] || r.source}{r.email ? `, ${r.email}` : ""}</div>
          </li>))}</ol>
      )}
    </aside>
  );
}
