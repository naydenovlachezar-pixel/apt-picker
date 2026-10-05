"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase, WIDGET_ORIGIN } from "../lib/supabase";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const yAt = (line, x) => {
  if (!line || !line.length) return null;
  if (x <= line[0][0]) return line[0][1];
  for (let i = 1; i < line.length; i++) {
    const [x1, y1] = line[i - 1], [x2, y2] = line[i];
    if (x <= x2) return x2 === x1 ? y2 : y1 + (y2 - y1) * (x - x1) / (x2 - x1);
  }
  return line[line.length - 1][1];
};
const sortX = pts => [...pts].sort((a, b) => a[0] - b[0]);

export default function FacadeEditor({ building, orgId, canEdit, onClose, onSaved }) {
  const sb = supabase();
  const [img, setImg] = useState(null);           // { url, w, h }
  const [sections, setSections] = useState(null); // [{ id, key, name }]
  const [layouts, setLayouts] = useState([]);
  const [all, setAll] = useState(null);           // { [ключ на вход]: [{ n, t, b, linked }] }
  const [sec, setSec] = useState(null);           // активен вход
  const [active, setActive] = useState({ n: 1, edge: "t" });
  const [adding, setAdding] = useState(null);     // { name, floors, layout, busy }
  const [sel, setSel] = useState(null);           // индекс на избрана точка в активния ръб
  const [zoom, setZoom] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState(null);
  const svgRef = useRef(), fileRef = useRef(), drag = useRef(null);

  function say(text, isErr) { setMsg({ text, isErr }); clearTimeout(say.t); say.t = setTimeout(() => setMsg(null), isErr ? 6000 : 3500); }

  async function load(focusKey) {
    const [{ data: b, error: e1 }, { data: ss, error: e2 }, { data: fl, error: e3 }, { data: ls }] = await Promise.all([
      sb.from("buildings").select("facade").eq("id", building.id).single(),
      sb.from("sections").select("id, key, name, sort_order").eq("building_id", building.id).order("sort_order").order("key"),
      sb.from("floors").select("number, section_id, facade_polygon").eq("building_id", building.id).order("number"),
      sb.from("layouts").select("key, name").eq("building_id", building.id).order("key")
    ]);
    const err = e1 || e2 || e3;
    if (err) return say("Фасадата не се зареди: " + err.message, true);
    const f = b.facade || {};
    setImg(i => i && i.fresh ? i : (f.image_url ? { url: f.image_url, w: f.w, h: f.h } : null));
    const byId = Object.fromEntries(ss.map(x => [x.id, x.key])), next = {};
    for (const x of ss) next[x.key] = [];
    for (const x of fl || []) next[byId[x.section_id]].push({ n: x.number, t: (x.facade_polygon && x.facade_polygon.t) || [], b: (x.facade_polygon && x.facade_polygon.b) || [] });
    for (const list of Object.values(next)) list.forEach((x, i) => { x.linked = i > 0 && (x.b.length ? same(x.b, list[i - 1].t) : !list[i - 1].t.length); });
    setSections(ss); setLayouts(ls || []); setAll(next);
    const k = focusKey && next[focusKey] ? focusKey : ss[0].key, first = next[k][0];
    setSec(k); setActive({ n: first ? first.n : 1, edge: first && first.b.length ? "t" : "b" }); setSel(null);
  }
  useEffect(() => { load(); }, [building.id]);

  useEffect(() => {
    const warn = e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    addEventListener("beforeunload", warn); return () => removeEventListener("beforeunload", warn);
  }, [dirty]);

  const floors = all && sec ? all[sec] || [] : null;
  const setFloors = fn => setAll(a => ({ ...a, [sec]: typeof fn === "function" ? fn(a[sec]) : fn }));
  const idx = n => floors.findIndex(f => f.n === n);
  // Общият ръб: долният ръб на свързан етаж е горният ръб на етажа под него
  function target(n, edge) {
    const i = idx(n);
    if (edge === "b" && floors[i].linked && i > 0) return { i: i - 1, edge: "t" };
    return { i, edge };
  }
  function edgePoints(n, edge) { const t = target(n, edge); return floors[t.i][t.edge]; }
  function setEdge(n, edge, fn) {
    const t = target(n, edge);
    setFloors(list => list.map((f, j) => j === t.i ? { ...f, [t.edge]: fn(f[t.edge]) } : f));
    setDirty(true);
  }

  function toImage(evt) {
    const svg = svgRef.current, p = svg.createSVGPoint();
    p.x = evt.clientX; p.y = evt.clientY;
    const r = p.matrixTransform(svg.getScreenCTM().inverse());
    return [Math.round(clamp(r.x, 0, img.w)), Math.round(clamp(r.y, 0, img.h))];
  }

  function onCanvasDown(e) {
    if (!canEdit || e.button !== 0 || e.target.dataset.handle) return;
    const pt = toImage(e);
    let insertedAt = 0;
    setEdge(active.n, active.edge, pts => { const next = sortX([...pts, pt]); insertedAt = next.findIndex(q => q === pt); return next; });
    setTimeout(() => setSel(insertedAt), 0);
  }
  function onHandleDown(e, i) {
    if (!canEdit) return;
    e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId);
    setSel(i); drag.current = { i };
  }
  function onMove(e) {
    if (!drag.current) return;
    const pt = toImage(e), di = drag.current.i;
    setEdge(active.n, active.edge, pts => pts.map((q, j) => j === di ? pt : q));
  }
  function onUp() {
    if (!drag.current) return;
    // След влачене пазим реда отляво надясно
    const di = drag.current.i; drag.current = null;
    setEdge(active.n, active.edge, pts => { const moved = pts[di]; const s = sortX(pts); setSel(s.indexOf(moved)); return s; });
  }

  useEffect(() => {
    const k = e => {
      if (!floors || !img || adding || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
      if (e.key === "Escape") { setSel(null); return; }
      if (sel == null || !canEdit) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); setEdge(active.n, active.edge, pts => pts.filter((_, j) => j !== sel)); setSel(null); }
      const d = e.shiftKey ? 10 : 1, mv = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[e.key];
      if (mv) { e.preventDefault(); setEdge(active.n, active.edge, pts => pts.map((q, j) => j === sel ? [clamp(q[0] + mv[0], 0, img.w), clamp(q[1] + mv[1], 0, img.h)] : q)); }
    };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  });

  function selectFloor(n, edge) { setActive({ n, edge: edge || active.edge }); setSel(null); }
  function toggleLinked(on) {
    const i = idx(active.n);
    setFloors(list => list.map((f, j) => j === i ? { ...f, linked: on, b: on ? f.b : (f.b.length ? f.b : [...list[i - 1].t]) } : f));
    setDirty(true); setSel(null);
  }
  // Предлага контур на етажа от формата на етажа под него: същата височина нагоре
  function suggestFromBelow() {
    const i = idx(active.n); if (i < 1) return;
    const below = floors[i - 1];
    const bt = below.t, bb = below.linked && i > 1 ? floors[i - 2].t : below.b;
    if (bt.length < 2 || bb.length < 2) return say(`Първо очертайте етаж ${below.n} с двата му ръба.`, true);
    const top = bt.map(([x, y]) => [x, Math.max(0, Math.round(y - (yAt(bb, x) - y)))]);
    setFloors(list => list.map((f, j) => j === i ? { ...f, t: top, linked: true } : f));
    setActive({ n: active.n, edge: "t" }); setDirty(true); setSel(null);
    say(`Етаж ${active.n} е предложен от етаж ${below.n}. Преместете точките, ако плочата се различава.`);
  }

  async function onUpload(e) {
    const file = e.target.files && e.target.files[0]; e.target.value = "";
    if (!file) return;
    if (!/^image\/(jpeg|png|webp|avif)$/.test(file.type)) return say("Качете снимка в JPG, PNG, WebP или AVIF.", true);
    if (file.size > 20 * 1024 * 1024) return say("Снимката е над 20 MB. Намалете я и опитайте отново.", true);
    setUploading(true);
    try {
      const url0 = URL.createObjectURL(file);
      const dim = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight }); im.onerror = rej; im.src = url0; });
      URL.revokeObjectURL(url0);
      const ext = file.name.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
      const path = `${orgId}/${building.id}/facade-${Date.now()}.${ext}`;
      const { error } = await sb.storage.from("media").upload(path, file, { contentType: file.type, cacheControl: "31536000", upsert: false });
      if (error) throw error;
      const { data } = sb.storage.from("media").getPublicUrl(path);
      // Ако пропорциите са същите, мащабираме контурите на всички входове към новия размер
      if (img && Math.abs(dim.w / dim.h - img.w / img.h) < 0.02) {
        const k = dim.w / img.w, sc = pts => pts.map(([x, y]) => [Math.round(x * k), Math.round(y * k)]);
        setAll(a => Object.fromEntries(Object.entries(a).map(([key, list]) => [key, list.map(f => ({ ...f, t: sc(f.t), b: sc(f.b) }))])));
        say("Новата снимка е качена. Контурите са мащабирани, проверете ги и запазете.");
      } else if (img) say("Новата снимка е с други пропорции. Контурите трябва да се очертаят наново.", true);
      else say("Снимката е качена. Започнете от долния ръб на етаж 1.");
      setImg({ url: data.publicUrl, w: dim.w, h: dim.h, fresh: true }); setDirty(true);
    } catch (err) { say("Снимката не е качена: " + (err.message || err), true); }
    setUploading(false);
  }

  async function save() {
    setSaving(true);
    const payload = [];
    for (const [k, list] of Object.entries(all)) list.forEach((f, i) => payload.push({ s: k, n: f.n, polygon: { t: f.t, b: f.linked && i > 0 ? list[i - 1].t : f.b } }));
    const { data, error } = await sb.rpc("save_facade", { p_building: building.id, p_facade: img && img.fresh ? { image_url: img.url, w: img.w, h: img.h } : null, p_floors: payload });
    setSaving(false);
    if (error) return say("Не е запазено: " + error.message, true);
    setDirty(false); setImg(i => i && { ...i, fresh: false });
    say(`Запазено: ${data.floors} от ${payload.length} етажа. Презаредете сайта след около минута, за да видите новите контури.`);
    onSaved && onSaved();
  }
  function switchSection(k) {
    const first = all[k][0];
    setSec(k); setActive({ n: first ? first.n : 1, edge: first && first.t.length ? "t" : "b" }); setSel(null);
  }
  async function addSection() {
    const n = parseInt(adding.floors, 10);
    if (!(n >= 1 && n <= 60)) return say("Въведете брой етажи от 1 до 60.", true);
    setAdding(a => ({ ...a, busy: true }));
    const { data, error } = await sb.rpc("add_section", { p_building: building.id, p_name: adding.name, p_floors: n, p_layout: adding.layout });
    if (error) { setAdding(a => ({ ...a, busy: false })); return say("Входът не е добавен: " + error.message, true); }
    setAdding(null);
    await load(data.key);
    onSaved && onSaved();
    say(`${data.name} е добавен: ${data.floors} етажа и ${data.apartments} апартамента. Очертайте етажите му и запазете.`);
  }
  async function renameSection() {
    const cur = sections.find(x => x.key === sec);
    const name = prompt("Ново име на входа", cur.name);
    if (!name || !name.trim() || name.trim() === cur.name) return;
    const { error } = await sb.from("sections").update({ name: name.trim() }).eq("id", cur.id);
    if (error) return say("Името не е сменено: " + error.message, true);
    setSections(list => list.map(x => x.id === cur.id ? { ...x, name: name.trim() } : x));
    onSaved && onSaved();
    say("Името на входа е сменено.");
  }
  async function deleteSection() {
    const cur = sections.find(x => x.key === sec);
    if (!confirm(`Да се изтрие ли „${cur.name}“ заедно с ${all[sec].length} етажа и всичките му апартаменти? Това не може да се върне.`)) return;
    const { error } = await sb.rpc("delete_section", { p_section: cur.id });
    if (error) return say("Входът не е изтрит: " + error.message, true);
    await load();
    onSaved && onSaved();
    say(`„${cur.name}“ е изтрит.`);
  }
  async function setFloorCount(n) {
    if (dirty) return say("Първо запазете промените по контурите.", true);
    if (n < 1) return;
    if (n < floors.length && !confirm(`Да се премахнат ли най-горните ${floors.length - n} ${floors.length - n === 1 ? "етаж" : "етажа"} с апартаментите им?`)) return;
    const { data, error } = await sb.rpc("set_section_floors", { p_building: building.id, p_section: sec, p_count: n });
    if (error) return say(error.message, true);
    await load(sec); onSaved && onSaved();
    say(data.added ? `Добавени етажи: ${data.added}. Очертайте ги и запазете.` : `Премахнати етажи: ${data.removed}.`);
  }

  function close() { if (!dirty || confirm("Има незапазени промени. Да се затвори ли редакторът без тях?")) onClose(); }

  const status = f => {
    const i = idx(f.n), b = f.linked && i > 0 ? floors[i - 1].t : f.b;
    return f.t.length >= 2 && b.length >= 2 ? "ok" : f.t.length || b.length ? "part" : "none";
  };
  const statusIn = (list, f) => { const i = list.indexOf(f), b = f.linked && i > 0 ? list[i - 1].t : f.b; return f.t.length >= 2 && b.length >= 2 ? "ok" : f.t.length || b.length ? "part" : "none"; };
  const totals = all ? Object.values(all).reduce((t, list) => ({ done: t.done + list.filter(f => statusIn(list, f) === "ok").length, n: t.n + list.length }), { done: 0, n: 0 }) : { done: 0, n: 0 };
  const h = img ? Math.max(4, img.w / 220) : 4;

  if (!floors) return <div className="fe"><p className="muted fe-loading">Зареждане на фасадата…</p></div>;
  const multi = sections.length > 1, secName = k => (sections.find(x => x.key === k) || {}).name || "";
  const cur = floors[idx(active.n)], curI = idx(active.n);
  const pts = curI >= 0 ? edgePoints(active.n, active.edge) : [];

  return (
    <div className="fe" role="dialog" aria-label={`Фасада на ${building.name}`}>
      <header className="fe-top">
        <b>Фасада: {building.name}</b>
        <span className="muted">{totals.done} от {totals.n} етажа очертани</span>
        <span className="spacer" />
        <label className="muted">Мащаб <select value={zoom} onChange={e => setZoom(+e.target.value)}>{[1, 1.5, 2, 3].map(z => <option key={z} value={z}>{z * 100}%</option>)}</select></label>
        {canEdit && <><button className="btn ghost" onClick={() => fileRef.current.click()} disabled={uploading}>{uploading ? "Качване…" : img ? "Смени снимката" : "Качи снимка"}</button>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/avif" hidden onChange={onUpload} /></>}
        <a className="btn ghost" href={`${WIDGET_ORIGIN}/embed.html?b=${building.slug}`} target="_blank" rel="noopener">Виж на сайта</a>
        {canEdit && <button className="btn primary" onClick={save} disabled={!dirty || saving}>{saving ? "Запазване…" : dirty ? "Запази" : "Запазено"}</button>}
        <button className="btn ghost" onClick={close}>Затвори</button>
      </header>

      <div className="fe-body">
        <div className="fe-canvas">
          {!img ? (
            <div className="fe-empty"><p>Тази сграда още няма визуализация.</p>{canEdit && <button className="btn primary" onClick={() => fileRef.current.click()}>Качи снимка на фасадата</button>}</div>
          ) : (
            <div className="fe-stage" style={{ width: `min(${zoom * 100}%, calc((100vh - 110px) * ${(img.w / img.h).toFixed(4)} * ${zoom}))`, aspectRatio: `${img.w} / ${img.h}`, backgroundImage: `url("${img.url}")` }}>
              <svg ref={svgRef} viewBox={`0 0 ${img.w} ${img.h}`} onPointerDown={onCanvasDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
                {[...Object.keys(all).filter(k => k !== sec), sec].map(k => all[k].map((f, i, list) => {
                  const b = f.linked && i > 0 ? list[i - 1].t : f.b;
                  if (f.t.length < 2 || b.length < 2) return null;
                  const poly = [...f.t, ...[...b].reverse()].map(p => p.join(",")).join(" ");
                  const lx = (f.t[0][0] + b[0][0]) / 2 + h * 3, ly = (yAt(f.t, lx) + yAt(b, lx)) / 2;
                  return <g key={k + f.n} className={"fe-floor" + (k !== sec ? " other" : f.n === active.n ? " on" : "")}>
                    <polygon points={poly} />
                    <text x={lx} y={ly + h * 1.4} style={{ fontSize: h * 4 }}>{multi ? `${(secName(k).split(" ").pop() || k)}${f.n}` : f.n}</text>
                  </g>;
                }))}
                {curI >= 0 && (() => {
                  const other = active.edge === "t" ? edgePoints(active.n, "b") : cur.t;
                  return <>
                    {other.length > 1 && <polyline className="fe-other" points={other.map(p => p.join(",")).join(" ")} style={{ strokeWidth: h / 1.6 }} />}
                    {pts.length > 1 && <polyline className="fe-edge" points={pts.map(p => p.join(",")).join(" ")} style={{ strokeWidth: h / 1.1 }} />}
                    {pts.map((p, i) => <circle key={i} data-handle="1" className={"fe-handle" + (sel === i ? " sel" : "")} cx={p[0]} cy={p[1]} r={sel === i ? h * 1.6 : h * 1.25}
                      style={{ strokeWidth: h / 2.5 }} onPointerDown={e => onHandleDown(e, i)} onDoubleClick={() => canEdit && (setEdge(active.n, active.edge, q => q.filter((_, j) => j !== i)), setSel(null))} />)}
                  </>;
                })()}
              </svg>
            </div>
          )}
        </div>

        <aside className="fe-side">
          <div className="fe-secs">
            <div className="fe-secs-head"><b>Входове</b>
              {canEdit && <button className="linkbtn" onClick={() => dirty ? say("Първо запазете промените по контурите, после добавете вход.", true) : setAdding({ name: "", floors: String(floors.length || 5), layout: layouts[0] ? layouts[0].key : "", busy: false })}>Добави вход</button>}
            </div>
            <div className="fe-sec-list" role="tablist" aria-label="Входове">
              {sections.map(x => <button key={x.key} role="tab" aria-selected={x.key === sec} onClick={() => switchSection(x.key)}>{x.name}</button>)}
            </div>
            {canEdit && <div className="fe-sec-tools"><button className="linkbtn" onClick={renameSection}>Преименувай</button>
              {multi && <button className="linkbtn danger" onClick={() => dirty ? say("Първо запазете или отменете промените по контурите.", true) : deleteSection()}>Изтрий входа</button>}</div>}
          </div>
          {curI >= 0 && <>
          <h3>{multi ? `${secName(sec)}, етаж ${active.n}` : `Етаж ${active.n}`}</h3>
          <div className="seg fe-edges" role="group" aria-label="Ръб">
            <button aria-pressed={active.edge === "t"} onClick={() => { setActive({ ...active, edge: "t" }); setSel(null); }}>Горен ръб</button>
            <button aria-pressed={active.edge === "b"} onClick={() => { setActive({ ...active, edge: "b" }); setSel(null); }}>Долен ръб</button>
          </div>
          <p className="muted fe-hint">
            {active.edge === "b" && cur.linked && curI > 0
              ? `Долният ръб е общ с горния ръб на етаж ${floors[curI - 1].n}. Промените тук местят и него.`
              : `Щракнете по ${active.edge === "t" ? "горния" : "долния"} ръб на плочата отляво надясно. ${pts.length ? `${pts.length} ${pts.length === 1 ? "точка" : "точки"}.` : "Още няма точки."}`}
          </p>
          {curI > 0 && canEdit && <label className="chk fe-link"><input type="checkbox" checked={!!cur.linked} onChange={e => toggleLinked(e.target.checked)} />Долният ръб е общ с етаж {floors[curI - 1].n}</label>}
          {canEdit && <div className="fe-actions">
            {curI > 0 && <button className="btn ghost" onClick={suggestFromBelow}>Предложи от етажа отдолу</button>}
            <button className="btn ghost" onClick={() => { setEdge(active.n, active.edge, () => []); setSel(null); }} disabled={!pts.length}>Изчисти ръба</button>
          </div>}
          </>}

          {canEdit && <div className="fe-count"><span>{multi ? `${secName(sec)}, етажи` : "Етажи"}:</span>
            <button type="button" aria-label="Премахни най-горния етаж" onClick={() => setFloorCount(floors.length - 1)} disabled={floors.length <= 1}>−</button>
            <b>{floors.length}</b>
            <button type="button" aria-label="Добави етаж отгоре" onClick={() => setFloorCount(floors.length + 1)}>+</button></div>}
          <ol className="fe-floors" aria-label="Етажи">
            {!floors.length && <li className="muted">В този вход няма етажи.</li>}
            {[...floors].reverse().map(f => {
              const s = status(f);
              return <li key={f.n}><button aria-current={f.n === active.n} onClick={() => selectFloor(f.n)}>
                <span>Етаж {f.n}</span><i className={"fe-st " + s}>{s === "ok" ? "очертан" : s === "part" ? "непълен" : "няма контур"}</i>
              </button></li>;
            })}
          </ol>
          <p className="muted fe-keys">Влачете точка, за да я преместите. Стрелките я местят с 1 px, със Shift с 10 px. Delete или двоен клик я изтрива.</p>
        </aside>
      </div>
      {adding && <div className="fe-modal" role="dialog" aria-labelledby="add-sec-title" onKeyDown={e => e.key === "Escape" && !adding.busy && setAdding(null)}>
        <div className="fe-modal-box">
          <h2 id="add-sec-title">Нов вход</h2>
          <p className="muted">Етажите и апартаментите се създават по избраното разпределение. Апартаментите са свободни, с цена по запитване. После очертайте етажите върху снимката.</p>
          <div className="field"><label htmlFor="sec-name">Име</label><input id="sec-name" placeholder={`Вход ${"АБВГДЕЖЗ"[sections.length] || ""}`} value={adding.name} onChange={e => setAdding({ ...adding, name: e.target.value })} autoFocus /></div>
          <div className="field"><label htmlFor="sec-floors">Брой етажи</label><input id="sec-floors" inputMode="numeric" value={adding.floors} onChange={e => setAdding({ ...adding, floors: e.target.value.replace(/\D/g, "") })} /></div>
          <div className="field"><label htmlFor="sec-layout">Типово разпределение</label>
            <select id="sec-layout" value={adding.layout} onChange={e => setAdding({ ...adding, layout: e.target.value })}>
              {layouts.map(l => <option key={l.key} value={l.key}>{l.name || LAYOUT_NAMES[l.key] || l.key}</option>)}
            </select></div>
          <div className="dlg-actions"><button className="btn" onClick={() => setAdding(null)} disabled={adding.busy}>Отказ</button>
            <button className="btn primary" onClick={addSection} disabled={adding.busy || !adding.layout}>{adding.busy ? "Създаване…" : "Създай входа"}</button></div>
        </div>
      </div>}
      {msg && <div className={"toast" + (msg.isErr ? " err" : "")} role="status">{msg.text}</div>}
    </div>
  );
}

const LAYOUT_NAMES = { typical: "Типов етаж", penthouse: "Пентхаус" };
