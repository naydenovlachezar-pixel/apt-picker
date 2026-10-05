-- Клиенти (строители, агенции) и техните потребители
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,60}$'),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.org_members (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('owner','editor','viewer')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index org_members_user_idx on public.org_members(user_id);

-- Сгради
create table public.buildings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,60}$'),   -- data-building в кода за вграждане
  name text not null,
  short_name text,
  district text,
  stage text,
  ready_text text,
  description text,
  published boolean not null default false,
  facade jsonb not null default '{}'::jsonb,     -- { image_url, w, h }
  settings jsonb not null default '{}'::jsonb,   -- тема, показване на цени, дестинации за запитвания
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index buildings_org_idx on public.buildings(org_id);

-- Типови разпределения (геометрия на апартаментите в плана)
create table public.layouts (
  id uuid primary key default gen_random_uuid(),
  building_id uuid not null references public.buildings(id) on delete cascade,
  key text not null,
  name text,
  plan jsonb not null default '{}'::jsonb,       -- { units: {A: {poly, tag, walls, rl}}, extras, balconies, viewBox }
  image_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (building_id, key)
);

-- Етажи: контур върху фасадата и кое разпределение ползват
create table public.floors (
  id uuid primary key default gen_random_uuid(),
  building_id uuid not null references public.buildings(id) on delete cascade,
  number int not null,
  label text,
  layout_id uuid references public.layouts(id) on delete set null,
  facade_polygon jsonb,                           -- { t: [[x,y]...], b: [[x,y]...] } в пиксели на рендера
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (building_id, number)
);

-- Апартаменти
create type public.apartment_status as enum ('free','reserved','sold');

create table public.apartments (
  id uuid primary key default gen_random_uuid(),
  building_id uuid not null references public.buildings(id) on delete cascade,
  floor_id uuid not null references public.floors(id) on delete cascade,
  unit_key text not null,                         -- ключ в разпределението, напр. A
  code text not null,                             -- стабилен код, напр. 5A
  label text not null,                            -- показвано име, напр. 5А
  rooms int not null check (rooms between 1 and 10),
  net_area numeric(8,2),
  gross_area numeric(8,2) not null,
  outdoor_area numeric(8,2) not null default 0,
  outdoor_kind text not null default 'terrace' check (outdoor_kind in ('terrace','garden','balcony')),
  exposure text,
  price numeric(12,2),
  currency text not null default 'EUR',
  price_visible boolean not null default true,
  status public.apartment_status not null default 'free',
  pdf_url text,
  hubspot_deal_id text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (building_id, code)
);
create index apartments_building_idx on public.apartments(building_id);
create index apartments_floor_idx on public.apartments(floor_id);
create index apartments_status_idx on public.apartments(building_id, status);

-- История на статусите (кой, кога, откъде)
create table public.status_history (
  id bigint generated always as identity primary key,
  apartment_id uuid not null references public.apartments(id) on delete cascade,
  old_status public.apartment_status,
  new_status public.apartment_status not null,
  source text not null default 'admin' check (source in ('admin','import','hubspot','api','seed')),
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now()
);
create index status_history_apartment_idx on public.status_history(apartment_id, changed_at desc);

-- Запитвания
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  building_id uuid not null references public.buildings(id) on delete cascade,
  apartment_id uuid references public.apartments(id) on delete set null,
  name text not null,
  phone text not null,
  email text,
  message text,
  consent boolean not null default false,
  consent_text text,
  page_uri text,
  placement text,
  utm jsonb,
  stage text not null default 'new' check (stage in ('new','viewing','reserved','won','lost')),
  delivery jsonb not null default '{}'::jsonb,    -- резултат от изпращане към HubSpot, имейл, webhook
  created_at timestamptz not null default now()
);
create index leads_building_idx on public.leads(building_id, created_at desc);
create index leads_apartment_idx on public.leads(apartment_id);

-- Събития за статистика
create table public.events (
  id bigint generated always as identity primary key,
  building_id uuid not null references public.buildings(id) on delete cascade,
  apartment_id uuid references public.apartments(id) on delete set null,
  floor_number int,
  type text not null check (type in ('view','floor_open','apartment_open','inquiry_open','inquiry_sent','pdf_open')),
  session_id text,
  page_uri text,
  created_at timestamptz not null default now()
);
create index events_building_idx on public.events(building_id, created_at desc);

-- updated_at автоматично
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;

create trigger buildings_touch before update on public.buildings for each row execute function public.touch_updated_at();
create trigger layouts_touch before update on public.layouts for each row execute function public.touch_updated_at();
create trigger floors_touch before update on public.floors for each row execute function public.touch_updated_at();
create trigger apartments_touch before update on public.apartments for each row execute function public.touch_updated_at();

-- Всяка смяна на статус се записва в историята
create or replace function public.log_status_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.status_history (apartment_id, old_status, new_status, source, changed_by)
    values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status,
            coalesce(nullif(current_setting('app.status_source', true), ''), 'admin'), auth.uid());
  end if;
  return new;
end $$;

create trigger apartments_status_log after insert or update of status on public.apartments
for each row execute function public.log_status_change();
