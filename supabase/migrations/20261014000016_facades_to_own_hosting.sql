-- Фасадите на демо сградите: от Higgsfield PNG (~1,8 MB) към собствени WebP (~180 KB) в widget/media/facades/.
-- Приложено директно с UPDATE на 13.10.2026; тук е за история.
update public.buildings
set facade = jsonb_set(facade, '{image_url}', to_jsonb('https://apt-picker-engine.vercel.app/media/facades/' || slug || '.webp'))
where slug in ('bor','gradini','horizont','spirala','terakota','terasi')
  and facade->>'image_url' ilike '%cloudfront.net%';
