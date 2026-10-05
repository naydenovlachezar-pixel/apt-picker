# Решения

- **Източник на истина:** Supabase. HubSpot се синхронизира с нея, така че продуктът работи и за строители без HubSpot.
- **Хостинг:** Vercel. `widget/` и `api/` в един проект, админ панелът в отделен.
- **Регион на базата:** Frankfurt (eu-central-1), заради GDPR и близостта до България.
- **Вграждане:** iframe през `embed.js`, за да е изолиран от CSS и JavaScript на сайта домакин.
- **Ключове във Vercel:** `SUPABASE_URL` и `SUPABASE_PUBLISHABLE_KEY` са обикновени променливи (публични по предназначение). `SUPABASE_SERVICE_ROLE_KEY` и `HUBSPOT_PRIVATE_APP_TOKEN` са secret.
