"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const CYR = "АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЮЯ";
const LAT = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ROOMS = { 1: "Едностаен", 2: "Двустаен", 3: "Тристаен", 4: "Четиристаен", 5: "Петстаен" };
const num = v => parseFloat(String(v == null ? "" : v).replace(",", "."));
const nf1 = n => num(n).toLocaleString("bg-BG", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
function centroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length], c = x1 * y2 - x2 * y1; a += c; cx += (x1 + x2) * c; cy += (y1 + y2) * c; }
  if (Math.abs(a) < 1e-6) return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  return [cx / (3 * a), cy / (3 * a)];
}
const blank = () => ({ key: null, name: "", img: null, units: {}, kind: "image", numbering: "as_is" });

export default function LayoutEditor({ building, orgId, canEdit, onClose, onSaved }) {
  const sb = supabase();
  const [layouts, setLayouts] = useState(null);   // [{ id, key, name, image_url, plan }]
  const [sections, setSections] = useState([]);
  const [floors, setFloors] = useState([]);       // [{ number, section_id, layout_id }]
  const [cur, setCur] = useState(blank());        // разпределението, което се редактира
  const [sel, setSel] = useState(null);           // ключ на избрания апартамент
  const [drawing, setDrawing] = useState(null);   // точки на контура, който се чертае
  const [vsel, setVsel] = useState(null);         // избран връх на избрания апартамент
  const [assign, setAssign] = useState({});       // { ключ на вход: Set(номера) }
  const [zoom, setZoom] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const svgRef = useRef(), fileRef = useRef(), drag = useRef(null);

  function say(text, isErr) { setMsg({ text, isErr }); clearTimeout(say.t); say.t = setTimeout(() => setMsg(null), isErr ? 7000 : 4000); }

  async function load(focusKey) {
    const [{ data: ls, error: e1 }, { data: ss, error: e2 }, { data: fl, error: e3 }] = await Promise.all([
      sb.from("layouts").select("id, key, name, image_url, plan").eq("building_id", building.id).order("created_at"),
      sb.from("sections").select("id, key, name, sort_order").eq("building_id", building.id).order("sort_order").order("key"),
      sb.from("floors").select("number, section_id, layout_id").eq("building_id", building.id).order("number")
    ]);
    const err = e1 || e2 || e3;
    if (err) return say("Разпределенията не се заредиха: " + err.message, true);
    setLayouts(ls); setSections(ss); setFloors(fl); setAssign({});
    const pick = ls.find(l => l.key === focusKey) || ls.find(l => l.plan && l.plan.kind === "image") || null;
    open(pick);
  }
  useEffect(() => { load(); }, [building.id]);

  function open(l) {
    setSel(null); setDrawing(null); setVsel(null); setDirty(false); setAssign({});
    if (!l) return setCur(blank());
    const p = l.plan || {};
    setCur({ key: l.key, name: l.name || "", kind: p.kind === "image" ? "image" : "legacy", numbering: p.numbering === "floor" ? "floor" : "as_is",
      img: l.image_url && p.w ? { url: l.image_url, w: p.w, h: p.h } : null,
      units: JSON.parse(JSON.stringify(p.units || {})) });
  }
  function confirmLeave() { return !dirty || confirm("Има незапазени промени в разпределението. Да се изоставят ли?"); }

  const legacy = cur.kind === "legacy";
  const editable = canEdit && !legacy;
  const units = cur.units;
  const unitKeys = Object.keys(units);
  const layoutIdByKey = useMemo(() => Object.fromEntries((layouts || []).map(l => [l.key, l.id])), [layouts]);
  const layoutById = useMemo(() => Object.fromEntries((layouts || []).map(l => [l.id, l])), [layouts]);
  const curId = cur.key ? layoutIdByKey[cur.key] : null;
  const usedBy = floors.filter(f => curId && f.layout_id === curId).length;

  function patchUnit(k, patch) { setCur(c => ({ ...c, units: { ...c.units, [k]: { ...c.units[k], ...patch } } })); setDirty(true); }
  function nextKey() {
    for (const ch of LAT) if (!units[ch]) return ch;
    for (let i = 1; i < 100; i++) for (const ch of LAT) if (!units[ch + i]) return ch + i;
  }
  function nextLabel() {
    const used = new Set(Object.values(units).map(u => u.label));
    for (const ch of CYR) if (!used.has(ch)) return ch;
    return String(unitKeys.length + 1);
  }

  function toImage(evt) {
    const svg = svgRef.current, p = svg.createSVGPoint();
    p.x = evt.clientX; p.y = evt.clientY;
    const r = p.matrixTransform(svg.getScreenCTM().inverse());
    return [Math.round(clamp(r.x, 0, cur.img.w)), Math.round(clamp(r.y, 0, cur.img.h))];
  }
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < (cur.img ? cur.img.w / 90 : 10);

  function finishDrawing(pts) {
    if (pts.length < 3) return say("Контурът трябва да има поне 3 точки.", true);
    const k = drawing.key;
    if (units[k]) patchUnit(k, { pts });
    else { setCur(c => ({ ...c, units: { ...c.units, [k]: { label: nextLabel(), rooms: 2, gross: "", net: "", outdoor: "", exposure: "", pts } } })); setDirty(true); }
    setDrawing(null); setSel(k); setVsel(null);
  }
  function onCanvasDown(e) {
    if (!editable || e.button !== 0 || !cur.img) return;
    if (drawing) {
      const pt = toImage(e);
      if (drawing.pts.length >= 3 && near(pt, drawing.pts[0])) return finishDrawing(drawing.pts);
      setDrawing(d => ({ ...d, pts: [...d.pts, pt] }));
      return;
    }
    const k = e.target.dataset && e.target.dataset.unit;
    if (k) { setSel(k); setVsel(null); return; }
    if (!e.target.dataset.vertex) { setSel(null); setVsel(null); }
  }
  function onVertexDown(e, i) {
    if (!editable) return;
    e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId);
    setVsel(i); drag.current = { i };
  }
  function onMove(e) {
    if (!drag.current || !sel) return;
    const pt = toImage(e), i = drag.current.i;
    patchUnit(sel, { pts: units[sel].pts.map((q, j) => j === i ? pt : q) });
  }
  function onUp() { drag.current = null; }

  useEffect(() => {
    const k = e => {
      if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
      if (drawing) {
        if (e.key === "Escape") { setDrawing(null); return; }
        if (e.key === "Enter") { e.preventDefault(); finishDrawing(drawing.pts); return; }
        if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); setDrawing(d => ({ ...d, pts: d.pts.slice(0, -1) })); return; }
      }
      if (!editable || !sel || vsel == null) return;
      const pts = units[sel].pts;
      if ((e.key === "Delete" || e.key === "Backspace") && pts.length > 3) { e.preventDefault(); patchUnit(sel, { pts: pts.filter((_, j) => j !== vsel) }); setVsel(null); }
      const d = e.shiftKey ? 10 : 1, mv = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[e.key];
      if (mv) { e.preventDefault(); patchUnit(sel, { pts: pts.map((q, j) => j === vsel ? [clamp(q[0] + mv[0], 0, cur.img.w), clamp(q[1] + mv[1], 0, cur.img.h)] : q) }); }
    };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  });

  async function onUpload(e) {
    const file = e.target.files && e.target.files[0]; e.target.value = "";
    if (!file) return;
    if (!/^image\/(jpeg|png|webp|avif)$/.test(file.type)) return say("Качете чертежа като JPG, PNG или WebP. Ако е PDF, запазете страницата като PNG.", true);
    if (file.size > 20 * 1024 * 1024) return say("Файлът е над 20 MB. Намалете го и опитайте отново.", true);
    setBusy(true);
    try {
      const u0 = URL.createObjectURL(file);
      const dim = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight }); im.onerror = rej; im.src = u0; });
      URL.revokeObjectURL(u0);
      const ext = file.name.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
      const path = `${orgId}/${building.id}/plan-${Date.now()}.${ext}`;
      const { error } = await sb.storage.from("media").upload(path, file, { contentType: file.type, cacheControl: "31536000", upsert: false });
      if (error) throw error;
      const { data } = sb.storage.from("media").getPublicUrl(path);
      const old = cur.img;
      if (old && Math.abs(dim.w / dim.h - old.w / old.h) < 0.02) {
        const k = dim.w / old.w;
        setCur(c => ({ ...c, img: { url: data.publicUrl, w: dim.w, h: dim.h }, units: Object.fromEntries(Object.entries(c.units).map(([key, u]) => [key, { ...u, pts: (u.pts || []).map(([x, y]) => [Math.round(x * k), Math.round(y * k)]) }])) }));
        say("Чертежът е сменен, контурите са мащабирани. Проверете ги и запазете.");
      } else {
        setCur(c => ({ ...c, img: { url: data.publicUrl, w: dim.w, h: dim.h } }));
        say(old ? "Новият чертеж е с други пропорции. Начертайте контурите наново." : "Чертежът е качен. Натиснете „Нов апартамент“ и щракнете по ъглите му.", !!old);
      }
      setDirty(true);
    } catch (err) { say("Чертежът не е качен: " + (err.message || err), true); }
    setBusy(false);
  }

  async function save() {
    if (!cur.name.trim()) return say("Дайте име на разпределението, например „Тип А, етажи 1–5“.", true);
    if (!cur.img) return say("Качете чертеж на етажа.", true);
    if (!unitKeys.length) return say("Добавете поне един апартамент.", true);
    const clean = {};
    for (const [k, u] of Object.entries(units)) {
      const gross = num(u.gross);
      if (!u.label || !gross || !u.pts || u.pts.length < 3) { setSel(k); return say(`Апартамент ${u.label || k}: попълнете номер и обща площ и начертайте контура.`, true); }
      clean[k] = { label: String(u.label).trim(), rooms: Number(u.rooms) || 1, gross,
        net: num(u.net) || null, outdoor: num(u.outdoor) || 0,
        exposure: (u.exposure || "").trim(), pts: u.pts };
    }
    setBusy(true);
    const { data, error } = await sb.rpc("save_layout", { p_building: building.id, p_key: cur.key, p_name: cur.name.trim(), p_image_url: cur.img.url, p_w: cur.img.w, p_h: cur.img.h, p_units: clean, p_numbering: cur.numbering });
    setBusy(false);
    if (error) return say("Не е запазено: " + error.message, true);
    setDirty(false);
    await load(data.key);
    onSaved && onSaved();
    say(data.floors ? `Запазено. ${data.floors} ${data.floors === 1 ? "етаж е обновен" : "етажа са обновени"}: ${changes(data)}.` : "Разпределението е запазено. Изберете етажите, които го ползват, и натиснете „Приложи“.");
  }
  const changes = d => [d.added && `${d.added} нови`, d.removed && `${d.removed} премахнати`, d.updated && `${d.updated} с нови данни`].filter(Boolean).join(", ") || "без промени в апартаментите";

  async function applyAssign() {
    if (!cur.key) return say("Първо запазете разпределението.", true);
    if (dirty) return say("Първо запазете промените по разпределението.", true);
    const jobs = Object.entries(assign).filter(([, set]) => set.size);
    if (!jobs.length) return say("Изберете поне един етаж.", true);
    const n = jobs.reduce((t, [, set]) => t + set.size, 0);
    if (!confirm(`${n} ${n === 1 ? "етаж ще получи" : "етажа ще получат"} разпределение „${cur.name}“ с ${unitKeys.length} апартамента. Свободните апартаменти, които липсват в него, ще бъдат премахнати. Продължаване?`)) return;
    setBusy(true);
    const tot = { added: 0, removed: 0, updated: 0 };
    for (const [secKey, set] of jobs) {
      const { data, error } = await sb.rpc("assign_layout", { p_building: building.id, p_section: secKey, p_floors: [...set], p_layout: cur.key });
      if (error) { setBusy(false); await load(cur.key); onSaved && onSaved(); return say("Не е приложено: " + error.message, true); }
      tot.added += data.added; tot.removed += data.removed; tot.updated += data.updated;
    }
    setBusy(false);
    await load(cur.key);
    onSaved && onSaved();
    say(`Приложено на ${n} ${n === 1 ? "етаж" : "етажа"}: ${changes(tot)}.`);
  }
  function toggleFloor(secKey, n) {
    setAssign(a => { const s = new Set(a[secKey] || []); s.has(n) ? s.delete(n) : s.add(n); return { ...a, [secKey]: s }; });
  }

  async function removeLayout() {
    if (!cur.key) return open(null);
    if (!confirm(`Да се изтрие ли разпределение „${cur.name}“?`)) return;
    const { error } = await sb.rpc("delete_layout", { p_building: building.id, p_key: cur.key });
    if (error) return say(error.message, true);
    await load(); say("Разпределението е изтрито.");
  }
  function removeUnit(k) {
    if (!confirm(`Да се премахне ли апартамент ${units[k].label} от разпределението? На етажите той ще изчезне при запазване, ако е свободен.`)) return;
    setCur(c => { const u = { ...c.units }; delete u[k]; return { ...c, units: u }; });
    setSel(null); setVsel(null); setDirty(true);
  }
  function close() { if (confirmLeave()) onClose(); }

  if (!layouts) return <div className="fe"><p className="muted fe-loading">Зареждане на разпределенията…</p></div>;
  const h = cur.img ? Math.max(4, cur.img.w / 220) : 4;
  const su = sel ? units[sel] : null;

  return (
    <div className="fe" role="dialog" aria-label={`Разпределения на ${building.name}`}>
      <header className="fe-top">
        <b>Разпределения: {building.name}</b>
        <select aria-label="Разпределение" value={cur.key || ""} onChange={e => { if (!confirmLeave()) return; open(layouts.find(l => l.key === e.target.value) || null); }}>
          {!cur.key && <option value="">Ново разпределение</option>}
          {layouts.map(l => <option key={l.key} value={l.key}>{l.name || l.key}{l.plan && l.plan.kind === "image" ? "" : " (демо)"}</option>)}
        </select>
        {canEdit && <button className="btn ghost" onClick={() => { if (confirmLeave()) open(null); }}>Ново</button>}
        <span className="spacer" />
        <label className="muted">Мащаб <select value={zoom} onChange={e => setZoom(+e.target.value)}>{[1, 1.5, 2, 3].map(z => <option key={z} value={z}>{z * 100}%</option>)}</select></label>
        {editable && <><button className="btn ghost" onClick={() => fileRef.current.click()} disabled={busy}>{cur.img ? "Смени чертежа" : "Качи чертеж"}</button>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/avif" hidden onChange={onUpload} /></>}
        {editable && <button className="btn primary" onClick={save} disabled={!dirty || busy}>{busy ? "Запазване…" : dirty ? "Запази" : "Запазено"}</button>}
        <button className="btn ghost" onClick={close}>Затвори</button>
      </header>

      <div className="fe-body">
        <div className="fe-canvas">
          {legacy ? (
            <div className="fe-empty"><p>„{cur.name || cur.key}“ е демо разпределение, начертано ръчно, и не се редактира тук.<br />Можете да го задавате на етажи или да създадете ново с качен чертеж.</p>
              {canEdit && <button className="btn primary" onClick={() => open(null)}>Ново разпределение</button>}</div>
          ) : !cur.img ? (
            <div className="fe-empty"><p>Качете чертежа на етажа: архитектурен план като JPG, PNG или WebP.</p>{editable && <button className="btn primary" onClick={() => fileRef.current.click()} disabled={busy}>Качи чертеж</button>}</div>
          ) : (
            <div className="fe-stage" style={{ width: `min(${zoom * 100}%, calc((100vh - 110px) * ${(cur.img.w / cur.img.h).toFixed(4)} * ${zoom}))`, aspectRatio: `${cur.img.w} / ${cur.img.h}`, backgroundImage: `url("${cur.img.url}")` }}>
              <svg ref={svgRef} viewBox={`0 0 ${cur.img.w} ${cur.img.h}`} onPointerDown={onCanvasDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} className={drawing ? "drawing" : ""}>
                {unitKeys.map(k => {
                  const u = units[k]; if (!u.pts || u.pts.length < 3) return null;
                  const [cx, cy] = centroid(u.pts);
                  return <g key={k} className={"le-unit" + (k === sel ? " on" : "")}>
                    <polygon points={u.pts.map(p => p.join(",")).join(" ")} data-unit={k} style={{ strokeWidth: h / 2 }} />
                    <text x={cx} y={cy} style={{ fontSize: h * 5 }}>{u.label}</text>
                    <text x={cx} y={cy + h * 4.5} className="sub" style={{ fontSize: h * 2.6 }}>{num(u.gross) ? `${nf1(u.gross)} m²` : "без площ"}</text>
                  </g>;
                })}
                {su && su.pts && editable && !drawing && su.pts.map((p, i) => <circle key={i} data-vertex="1" className={"fe-handle" + (vsel === i ? " sel" : "")} cx={p[0]} cy={p[1]} r={vsel === i ? h * 1.6 : h * 1.2} style={{ strokeWidth: h / 2.5 }}
                  onPointerDown={e => onVertexDown(e, i)} onDoubleClick={() => su.pts.length > 3 && (patchUnit(sel, { pts: su.pts.filter((_, j) => j !== i) }), setVsel(null))} />)}
                {drawing && <>
                  {drawing.pts.length > 1 && <polyline className="le-draw" points={drawing.pts.map(p => p.join(",")).join(" ")} style={{ strokeWidth: h / 1.4 }} />}
                  {drawing.pts.map((p, i) => <circle key={i} className={"fe-handle" + (i === 0 && drawing.pts.length >= 3 ? " sel" : "")} cx={p[0]} cy={p[1]} r={i === 0 ? h * 1.6 : h * 1.1} style={{ strokeWidth: h / 2.5, pointerEvents: "none" }} />)}
                </>}
              </svg>
            </div>
          )}
        </div>

        <aside className="fe-side">
          {!legacy && <div className="field"><label htmlFor="le-name">Име на разпределението</label>
            <input id="le-name" value={cur.name} placeholder="Например: Тип А, етажи 1–5" disabled={!editable} onChange={e => { setCur(c => ({ ...c, name: e.target.value })); setDirty(true); }} /></div>}

          {!legacy && <div className="field"><label htmlFor="le-num">Номерация на апартаментите</label>
            <select id="le-num" value={cur.numbering} disabled={!editable} onChange={e => { setCur(c => ({ ...c, numbering: e.target.value })); setDirty(true); }}>
              <option value="as_is">Точно както е въведен номерът (Р22)</option>
              <option value="floor">Етаж + номер (1А, 2А, 3А…)</option>
            </select>
            {cur.numbering === "as_is" && usedBy > 1 && <span className="le-warn">Разпределението е на {usedBy} етажа, затова номерата ще се повтарят. Изберете „Етаж + номер“ или сменете номерата в таблицата.</span>}
          </div>}

          {drawing ? (
            <div className="note">Щракнете по ъглите на апартамента. Затворете контура с щракане върху първата точка или с Enter. Backspace маха последната точка, Esc отказва.
              <div className="le-row"><button className="btn primary" onClick={() => finishDrawing(drawing.pts)} disabled={drawing.pts.length < 3}>Готово</button><button className="btn ghost" onClick={() => setDrawing(null)}>Отказ</button></div></div>
          ) : editable && cur.img && <button className="btn" onClick={() => { setSel(null); setDrawing({ key: nextKey(), pts: [] }); }}>Нов апартамент</button>}

          <div className="le-list">
            <b>Апартаменти на етажа ({unitKeys.length})</b>
            {!unitKeys.length && <p className="muted">Още няма. Начертайте първия върху чертежа.</p>}
            <ul>{unitKeys.map(k => { const u = units[k], ok = u.pts && u.pts.length >= 3 && num(u.gross) > 0 && u.label;
              return <li key={k}><button aria-current={k === sel} onClick={() => { setSel(k); setVsel(null); setDrawing(null); }}>
                <span><b>{u.label || "?"}</b> {ROOMS[u.rooms] || (u.rooms ? u.rooms + " стаи" : "")}{num(u.gross) ? `, ${nf1(u.gross)} m²` : ""}</span><i className={"fe-st " + (ok ? "ok" : "part")}>{ok ? "готов" : "непълен"}</i></button></li>; })}</ul>
          </div>

          {su && !drawing && <div className="le-form">
            <h3>Апартамент {su.label}</h3>
            <div className="le-grid">
              <div className="field"><label htmlFor="u-label">Номер</label><input id="u-label" value={su.label} disabled={!editable} onChange={e => patchUnit(sel, { label: e.target.value.slice(0, 12) })} /></div>
              <div className="field"><label htmlFor="u-rooms">Стаи</label><select id="u-rooms" value={su.rooms} disabled={!editable} onChange={e => patchUnit(sel, { rooms: +e.target.value })}>{[1, 2, 3, 4, 5, 6].map(r => <option key={r} value={r}>{r}</option>)}</select></div>
              <div className="field"><label htmlFor="u-gross">Обща площ, m²</label><input id="u-gross" inputMode="decimal" value={su.gross} disabled={!editable} onChange={e => patchUnit(sel, { gross: e.target.value })} /></div>
              <div className="field"><label htmlFor="u-net">Чиста площ, m²</label><input id="u-net" inputMode="decimal" value={su.net || ""} disabled={!editable} onChange={e => patchUnit(sel, { net: e.target.value })} /></div>
              <div className="field"><label htmlFor="u-out">Тераса, m²</label><input id="u-out" inputMode="decimal" value={su.outdoor || ""} disabled={!editable} onChange={e => patchUnit(sel, { outdoor: e.target.value })} /></div>
              <div className="field"><label htmlFor="u-exp">Изложение</label><input id="u-exp" value={su.exposure || ""} placeholder="юг, запад" disabled={!editable} onChange={e => patchUnit(sel, { exposure: e.target.value })} /></div>
            </div>
            {editable && <div className="le-row">
              <button className="linkbtn" onClick={() => setDrawing({ key: sel, pts: [] })}>Начертай контура наново</button>
              <button className="linkbtn danger" onClick={() => removeUnit(sel)}>Премахни апартамента</button></div>}
            {editable && <p className="muted fe-keys">Влачете ъглите, за да коригирате контура. Избран ъгъл се мести със стрелките, а Delete го изтрива.</p>}
          </div>}

          {cur.key && <div className="le-assign">
            <b>Етажи с това разпределение</b>
            <p className="muted">Сега: {usedBy ? `${usedBy} ${usedBy === 1 ? "етаж" : "етажа"}` : "нито един етаж"}. Изберете етажи и натиснете „Приложи“.</p>
            {sections.map(s => {
              const fl = floors.filter(f => f.section_id === s.id);
              return <div key={s.id} className="le-sec">{sections.length > 1 && <span className="muted">{s.name}</span>}
                <div className="le-floors">{fl.map(f => {
                  const mine = f.layout_id === curId, picked = assign[s.key] && assign[s.key].has(f.number), other = layoutById[f.layout_id];
                  return <button key={f.number} className={(mine ? "mine " : "") + (picked ? "picked" : "")} aria-pressed={!!picked} disabled={!canEdit || mine}
                    title={mine ? "Вече ползва това разпределение" : other ? `Сега: ${other.name || other.key}` : "Без разпределение"} onClick={() => toggleFloor(s.key, f.number)}>{f.number}</button>;
                })}</div></div>;
            })}
            {canEdit && <button className="btn" onClick={applyAssign} disabled={busy || dirty}>Приложи към избраните етажи</button>}
          </div>}

          {canEdit && <button className="linkbtn danger" onClick={removeLayout}>{cur.key ? "Изтрий разпределението" : "Откажи новото разпределение"}</button>}
        </aside>
      </div>
      {msg && <div className={"toast" + (msg.isErr ? " err" : "")} role="status">{msg.text}</div>}
    </div>
  );
}
