const STEPS = [
  { t: "Основа: repo, Vercel, Supabase", done: true },
  { t: "База данни: сгради, етажи, апартаменти, запитвания", done: true },
  { t: "Widget, свързан с базата", done: true },
  { t: "Вход и таблица с апартаменти за строителя" },
  { t: "Редактор за очертаване на етажи и апартаменти" },
  { t: "Запитвания към HubSpot, имейл и webhook" },
  { t: "Синхронизация на статусите от HubSpot" },
  { t: "Статистика и месечен отчет" }
];

export default function Home() {
  return (
    <main>
      <h1>Админ панел</h1>
      <p>Тук строителят ще управлява сградите, апартаментите и запитванията си.</p>
      <ol>
        {STEPS.map(s => <li key={s.t} className={s.done ? "done" : ""}>{s.t}</li>)}
      </ol>
    </main>
  );
}
