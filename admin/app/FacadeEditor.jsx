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
  const [floors, setFloors] = useState(null);     // [{ n, t, b, linked }]
  const [active, setActive] = useState({ n: 1, edge: "t" });
  const [sel, setSel] = useState(null);           // индекс на избрана точка в активния ръб
  const [zoom, setZoom] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState(null);
  const svgRef = useRef(), fileRef = useRef(), drag = useRef(null);

  function say(text, isErr) { setMsg({ text, isErr }); clearTimeout(say.t); say.t = setTimeout(() => setMsg(null), isErr ? 6000 : 3500); }

  useEffect(() => {
    (async () => {
      const [{ data: b, error: e1 }, { data: fl, error: e2 }] = await Promise.all([
        sb.from("buildings").select("facade").eq("id", building.id).single(),
        sb.from("floors").select("number, facade_polygon").eq("building_id", building.id).order("number")
      ]);
      if (e1 || e2) return say("Фасадата не се зареди: " + (e1 || e2).message, true);
      const f = b.facade || {};
      setImg(f.image_url ? { url: f.image_url, w: f.w, h: f.h } : null);
      const list = (fl || []).map(x => ({ n: x.number, t: (x.facade_polygon && x.facade_polygon.t) || [], b: (x.facade_polygon && x.facade_polygon.b) || [] }));
      list.forEach((x, i) => { x.linked = i > 0 && x.b.length > 0 && same(x.b, list[i - 1].t); if (i > 0 && !x.b.length && !list[i - 1].t.length) x.linked = true; });
      setFloors(list);
      setActive({ n: 1, edge: list[0] && list[0].b.length ? "t" : "b" });
    })();
  }, [building.id]);

  useEffect(() => {
    const warn = e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    addEventListener("beforeunload", warn); return () => removeEventListener("beforeunload", warn);
  }, [dirty]);

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
      if (!floors || !img || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
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
      // Ако пропорциите са същите, мащабираме очертаните контури към новия размер
      if (img && Math.abs(dim.w / dim.h - img.w / img.h) < 0.02) {
        const k = dim.w / img.w, sc = pts => pts.map(([x, y]) => [Math.round(x * k), Math.round(y * k)]);
        setFloors(list => list.map(f => ({ ...f, t: sc(f.t), b: sc(f.b) })));
        say("Новата снимка е качена. Контурите са мащабирани, проверете ги и запазете.");
      } else if (img) say("Новата снимка е с други пропорции. Контурите трябва да се очертаят наново.", true);
      else say("Снимката е качена. Започнете от долния ръб на етаж 1.");
      setImg({ url: data.publicUrl, w: dim.w, h: dim.h, fresh: true }); setDirty(true);
    } catch (err) { say("Снимката не е качена: " + (err.message || err), true); }
    setUploading(false);
  }

  async function save() {
    setSaving(true);
    const payload = floors.map((f, i) => ({ n: f.n, polygon: { t: f.t, b: f.linked && i > 0 ? floors[i - 1].t : f.b } }));
    const { data, error } = await sb.rpc("save_facade", { p_building: building.id, p_facade: img && img.fresh ? { image_url: img.url, w: img.w, h: img.h } : null, p_floors: payload });
    setSaving(false);
    if (error) return say("Не е запазено: " + error.message, true);
    setDirty(false); setImg(i => i && { ...i, fresh: false });
    say(`Запазено: ${data.floors} от ${floors.length} етажа. Презаредете сайта след около минута, за да видите новите контури.`);
    onSaved && onSaved();
  }
  function close() { if (!dirty || confirm("Има незапазени промени. Да се затвори ли редакторът без тях?")) onClose(); }

  const status = f => {
    const i = idx(f.n), b = f.linked && i > 0 ? floors[i - 1].t : f.b;
    return f.t.length >= 2 && b.length >= 2 ? "ok" : f.t.length || b.length ? "part" : "none";
  };
  const done = floors ? floors.filter(f => status(f) === "ok").length : 0;
  const h = img ? Math.max(4, img.w / 220) : 4;

  if (!floors) return <div className="fe"><p className="muted fe-loading">Зареждане на фасадата…</p></div>;
  const cur = floors[idx(active.n)], curI = idx(active.n);
  const pts = edgePoints(active.n, active.edge);

  return (
    <div className="fe" role="dialog" aria-label={`Фасада на ${building.name}`}>
      <header className="fe-top">
        <b>Фасада: {building.name}</b>
        <span className="muted">{done} от {floors.length} етажа очертани</span>
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
                {floors.map((f, i) => {
                  const b = f.linked && i > 0 ? floors[i - 1].t : f.b;
                  if (f.t.length < 2 || b.length < 2) return null;
                  const poly = [...f.t, ...[...b].reverse()].map(p => p.join(",")).join(" ");
                  const lx = (f.t[0][0] + b[0][0]) / 2 + h * 3, ly = (yAt(f.t, lx) + yAt(b, lx)) / 2;
                  return <g key={f.n} className={"fe-floor" + (f.n === active.n ? " on" : "")}>
                    <polygon points={poly} />
                    <text x={lx} y={ly + h * 1.4} style={{ fontSize: h * 4 }}>{f.n}</text>
                  </g>;
                })}
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
          <h3>Етаж {active.n}</h3>
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

          <ol className="fe-floors" aria-label="Етажи">
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
      {msg && <div className={"toast" + (msg.isErr ? " err" : "")} role="status">{msg.text}</div>}
    </div>
  );
}
