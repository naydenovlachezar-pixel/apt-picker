// Внасяне и изнасяне на таблицата с апартаменти (CSV и Excel).

const STATUS_IN = {
  free: "free", f: "free", "свободен": "free", "свободна": "free", "своб": "free", "св": "free",
  reserved: "reserved", r: "reserved", "резервиран": "reserved", "резервирана": "reserved", "резерв": "reserved", "рез": "reserved",
  sold: "sold", s: "sold", "продаден": "sold", "продадена": "sold", "прод": "sold"
};
export const STATUS_OUT = { free: "Свободен", reserved: "Резервиран", sold: "Продаден" };

const HEADERS = {
  code: ["апартамент", "ап", "ап.", "номер", "код", "code", "apartment", "№"],
  status: ["статус", "status", "наличност"],
  price: ["цена", "цена, €", "цена €", "цена (€)", "цена eur", "price"],
  visible: ["цена на сайта", "показвай цена", "показва се", "видима цена", "price_visible", "visible"]
};

const norm = s => String(s == null ? "" : s).replace(/^\uFEFF/, "").trim().toLowerCase().replace(/\s+/g, " ");
// Букви, които изглеждат еднакво на кирилица и латиница: 1А и 1A са един и същ апартамент.
const LAT = { "а": "a", "б": "b", "в": "c", "г": "d", "д": "e", "е": "f", "п": "p" };
const key = s => norm(s).replace(/[\s.\-]/g, "");

function parseCsv(text) {
  text = text.replace(/^\uFEFF/, "");
  const first = text.split(/\r?\n/)[0] || "";
  const delim = [";", ",", "\t"].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ""));
}

export async function readFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx")) {
    const { readSheet } = await import("read-excel-file/universal");
    return (await readSheet(await file.arrayBuffer())).map(r => r.map(v => v == null ? "" : v));
  }
  if (name.endsWith(".csv") || name.endsWith(".txt")) return parseCsv(await file.text());
  throw new Error("Поддържат се файлове .xlsx и .csv. Ако таблицата е в .xls, запазете я като .xlsx.");
}

function parsePrice(v) {
  if (v === "" || v == null) return { empty: true };
  if (typeof v === "number") return { value: Math.round(v) };
  const s = String(v).replace(/[€\s\u00a0\u202f]/g, "").replace(/(eur|лв|bgn)/gi, "");
  if (s === "" || /^(-|по запитване)$/i.test(s)) return { empty: true };
  // 145.000 / 145,000 / 145000,00
  const digits = s.replace(/[.,](\d{2})$/, "").replace(/[.,]/g, "");
  if (!/^\d+$/.test(digits)) return { error: true };
  return { value: Number(digits) };
}

function parseVisible(v) {
  const s = norm(v);
  if (s === "") return undefined;
  if (["да", "yes", "true", "1", "показва се", "показвай", "x", "✓"].includes(s)) return true;
  if (["не", "no", "false", "0", "по запитване", "скрита", "скрий"].includes(s)) return false;
  return null;
}

// Сравнява файла с текущите апартаменти и връща само реалните промени.
export function buildImport(rows, apts) {
  if (!rows.length) return { error: "Файлът е празен." };
  const head = rows[0].map(norm);
  const col = {};
  for (const [k, names] of Object.entries(HEADERS)) {
    const i = head.findIndex(h => names.includes(h));
    if (i >= 0) col[k] = i;
  }
  if (col.code == null) return { error: "Липсва колона „Апартамент“. Първият ред трябва да съдържа заглавията на колоните." };
  if (col.status == null && col.price == null && col.visible == null) return { error: "Няма колони за промяна. Добавете поне една от „Статус“, „Цена“ или „Цена на сайта“." };

  const byKey = new Map();
  for (const a of apts) {
    byKey.set(key(a.code), a);
    byKey.set(key(a.label), a);
    byKey.set(key(a.label).replace(/[а-я]/g, ch => LAT[ch] || ch), a);
  }

  const changes = [], problems = [], seen = new Set();
  let unchanged = 0;
  rows.slice(1).forEach((r, i) => {
    const line = i + 2, raw = r[col.code];
    if (String(raw == null ? "" : raw).trim() === "") return;
    const a = byKey.get(key(raw)) || byKey.get(key(raw).replace(/[а-я]/g, ch => LAT[ch] || ch));
    if (!a) return problems.push(`Ред ${line}: няма апартамент „${raw}“ в тази сграда.`);
    if (seen.has(a.code)) return problems.push(`Ред ${line}: апартамент ${a.label} се среща повече от веднъж.`);
    seen.add(a.code);

    const patch = { code: a.code }, diff = [];
    if (col.status != null && norm(r[col.status]) !== "") {
      const st = STATUS_IN[norm(r[col.status])];
      if (!st) problems.push(`Ред ${line}: непознат статус „${r[col.status]}“. Използвайте Свободен, Резервиран или Продаден.`);
      else if (st !== a.status) { patch.status = st; diff.push(`${STATUS_OUT[a.status]} → ${STATUS_OUT[st]}`); }
    }
    if (col.price != null) {
      const p = parsePrice(r[col.price]);
      if (p.error) problems.push(`Ред ${line}: цената „${r[col.price]}“ не е число.`);
      else if (!p.empty && p.value !== (a.price == null ? null : Math.round(a.price))) {
        patch.price = p.value;
        diff.push(`цена ${a.price == null ? "няма" : fmt(a.price)} → ${fmt(p.value)}`);
      }
    }
    if (col.visible != null) {
      const v = parseVisible(r[col.visible]);
      if (v === null) problems.push(`Ред ${line}: „${r[col.visible]}“ в „Цена на сайта“ трябва да е „да“ или „не“.`);
      else if (v !== undefined && v !== a.price_visible) { patch.price_visible = v; diff.push(v ? "цената се показва" : "цена по запитване"); }
    }
    if (diff.length) changes.push({ label: a.label, floor: a.floor, patch, diff });
    else unchanged++;
  });
  return { changes, problems, unchanged };
}

const fmt = n => new Intl.NumberFormat("bg-BG").format(Math.round(n)) + " €";

export function downloadCsv(apts, buildingName) {
  const ROOMS = { 1: "Едностаен", 2: "Двустаен", 3: "Тристаен", 4: "Четиристаен" };
  const esc = v => { const s = String(v == null ? "" : v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const multi = new Set(apts.map(a => a.sec)).size > 1;
  const lines = [["Апартамент", ...(multi ? ["Вход"] : []), "Етаж", "Тип", "Обща площ", "Цена", "Цена на сайта", "Статус"]];
  for (const a of apts) lines.push([a.label, ...(multi ? [a.secName] : []), a.floor, ROOMS[a.rooms] || a.rooms, String(a.gross_area).replace(".", ","),
    a.price == null ? "" : Math.round(a.price), a.price_visible ? "да" : "не", STATUS_OUT[a.status]]);
  const csv = "\uFEFF" + lines.map(r => r.map(esc).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const el = document.createElement("a");
  el.href = url; el.download = `${buildingName.replace(/[„“"]/g, "").replace(/\s+/g, "-")}-апартаменти.csv`;
  document.body.appendChild(el); el.click(); el.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
