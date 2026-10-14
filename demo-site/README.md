# Демо сайт „Линия Девелопмънт“

Сайт на измислен строител, който показва widget-а вграден в реален сайт: https://liniya-demo.vercel.app

- Vercel проект `liniya-demo` (екип ln-aydenov). **Не е свързан с това репо** – deploy-ва се ръчно (Vercel → проект → Deployments, или чрез Claude/Vercel API) с единствения файл `index.html`. Ако се свърже с репото, Vercel ще публикува корена на репото върху демото и ще го счупи.
- Видео и картинки за хирото и фасадите са в `widget/media/` и се сервират от `apt-picker-engine.vercel.app/media/...`.
- Vercel Web Analytics е включен (скриптът `/_vercel/insights/script.js`).
- Лични линкове: `?crm=1&ref=<компания>` записват посещенията в `public.demo_visits` през `track_demo_visit`. Виждат се в админ панела → „Строители“ → „Посещения на демото“.
- `?crm=1` показва бутона „CRM демо“ (симулация в браузъра на посетителя).
