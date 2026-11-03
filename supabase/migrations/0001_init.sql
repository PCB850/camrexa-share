-- CAMREXA — initial schema (Supabase / Postgres 15+)
--
-- Design rules
--   * Statewide-ready: every building hangs off state -> county -> city.
--   * Public (anon) can read ONLY public.building_teasers (name, city, county,
--     year built, units, risk band) plus the county/city lists.
--   * Every full row is readable only by a signed-in user holding a live
--     entitlement for that building (building, county, or statewide scope),
--     or by an admin (profiles.role = 'admin').
--   * Writes go through the service role (loader script, Stripe webhook).
--     No insert/update/delete is granted to anon or authenticated.
--   * Every fact keeps its provenance in public.sources (url + as_of),
--     linkable to any record by (record_table, record_id, field_path).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Geography
-- ---------------------------------------------------------------------------
create table public.counties (
  id          uuid primary key default gen_random_uuid(),
  state       char(2) not null default 'FL',
  name        text not null,
  slug        text not null,
  fips        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (state, name),
  unique (state, slug)
);

create table public.cities (
  id          uuid primary key default gen_random_uuid(),
  county_id   uuid not null references public.counties(id) on delete restrict,
  state       char(2) not null default 'FL',
  name        text not null,
  slug        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (county_id, name)
);
create index cities_county_idx on public.cities(county_id);
create index cities_state_slug_idx on public.cities(state, slug);

-- ---------------------------------------------------------------------------
-- Associations and buildings
-- ---------------------------------------------------------------------------
create table public.associations (
  id                     uuid primary key default gen_random_uuid(),
  slug                   text not null unique,
  legal_name             text,
  state                  char(2) not null default 'FL',
  dbpr_project_numbers   text[] not null default '{}',   -- DBPR condo project numbers
  sunbiz_id              text,                            -- FL Division of Corporations document number
  management_company     text,
  management_contact     text,
  website                text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index associations_dbpr_idx on public.associations using gin (dbpr_project_numbers);
create index associations_sunbiz_idx on public.associations(sunbiz_id);

create table public.buildings (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique,
  name                text not null,
  association_id      uuid references public.associations(id) on delete set null,
  state               char(2) not null default 'FL',
  county_id           uuid references public.counties(id) on delete restrict,
  city_id             uuid references public.cities(id) on delete restrict,
  address             text,
  lat                 numeric(9,6),
  lng                 numeric(9,6),
  year_built          integer,
  units               integer,
  floors              integer,
  buildings_count     integer,
  unit_mix            jsonb,          -- e.g. {"1BR": 120, "2BR": 80} or prose
  elevators           text,
  construction_notes  text,
  flood_zone          text,
  amenities           jsonb,
  risk_band           text not null default 'UNKNOWN'
                      check (risk_band in ('STRONG', 'WATCH', 'HIGH RISK', 'UNKNOWN')),
  health_summary      text,
  conflicts           text[] not null default '{}',  -- plain notes on sources that disagree
  raw_profile         jsonb,          -- last loaded profile JSON, kept for audit
  is_published        boolean not null default true,  -- false hides it from the teaser view
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index buildings_county_idx on public.buildings(county_id);
create index buildings_city_idx on public.buildings(city_id);
create index buildings_state_idx on public.buildings(state);
create index buildings_association_idx on public.buildings(association_id);
create index buildings_risk_idx on public.buildings(risk_band);

-- ---------------------------------------------------------------------------
-- Fees and rules (one row per building)
-- ---------------------------------------------------------------------------
create table public.fees (
  building_id               uuid primary key references public.buildings(id) on delete cascade,
  dues_by_unit_type         jsonb,     -- {"1BR 846sf": "$2,344.66/qtr", ...} or prose
  dues_frequency            text,      -- monthly | quarterly | annual | prose
  dues_cover                text[] not null default '{}',
  dues_exclude              text[] not null default '{}',
  insurance_assessment      text,      -- separate insurance assessment, if any
  cdd_fee                   text,      -- Community Development District fee
  reserves_pct_of_budget    numeric(6,2),
  reserves_note             text,
  recent_dues_change        text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create table public.rules (
  building_id          uuid primary key references public.buildings(id) on delete cascade,
  pets_owners          text,
  pets_renters         text,
  parking              text,
  parking_fees         text,
  golf_carts_trailers  text,
  short_term_rentals   text,
  rental_minimum_stay  text,
  renter_min_age       text,
  rental_program       text,
  registration_fees    text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Structural / financial health (many rows per building)
-- ---------------------------------------------------------------------------
create table public.sirs_filings (           -- Structural Integrity Reserve Study
  id             uuid primary key default gen_random_uuid(),
  building_id    uuid not null references public.buildings(id) on delete cascade,
  status         text,
  completed_on   date,
  completed_text text,                       -- date as found when not a clean date
  engineer       text,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index sirs_building_idx on public.sirs_filings(building_id);

create table public.milestone_inspections (
  id             uuid primary key default gen_random_uuid(),
  building_id    uuid not null references public.buildings(id) on delete cascade,
  phase          text,                       -- phase 1 / phase 2
  status         text,
  due_on         date,
  due_text       text,
  completed_on   date,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index milestone_building_idx on public.milestone_inspections(building_id);

create table public.special_assessments (
  id             uuid primary key default gen_random_uuid(),
  building_id    uuid not null references public.buildings(id) on delete cascade,
  amount         numeric(14,2),
  amount_text    text,
  per_unit       text,
  approved_on    date,
  approved_text  text,
  purpose        text,
  schedule       text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index special_assessments_building_idx on public.special_assessments(building_id);

create table public.loans (
  id             uuid primary key default gen_random_uuid(),
  building_id    uuid not null references public.buildings(id) on delete cascade,
  lender         text,
  amount         numeric(14,2),
  description    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index loans_building_idx on public.loans(building_id);

create table public.litigation (
  id             uuid primary key default gen_random_uuid(),
  building_id    uuid not null references public.buildings(id) on delete cascade,
  case_number    text,
  court          text,
  status         text,
  description    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index litigation_building_idx on public.litigation(building_id);

create table public.insurance (
  id             uuid primary key default gen_random_uuid(),
  building_id    uuid not null references public.buildings(id) on delete cascade,
  carrier        text,
  coverage       text,                       -- wind / flood / property / GL ...
  premium        numeric(14,2),
  issues         text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index insurance_building_idx on public.insurance(building_id);

create table public.sales_stats (
  id                 uuid primary key default gen_random_uuid(),
  building_id        uuid not null references public.buildings(id) on delete cascade,
  period_end         date,
  period_end_text    text,
  median_sale        numeric(14,2),
  median_sale_text   text,
  sales_count        integer,
  price_range        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index sales_stats_building_idx on public.sales_stats(building_id, period_end desc);

-- ---------------------------------------------------------------------------
-- Documents (files live in the private Storage bucket 'building-docs',
-- path convention: <building-slug>/<file>.pdf)
-- ---------------------------------------------------------------------------
create table public.documents (
  id              uuid primary key default gen_random_uuid(),
  building_id     uuid not null references public.buildings(id) on delete cascade,
  doc_type        text not null default 'other'
                  check (doc_type in ('sirs', 'milestone', 'budget', 'financials', 'insurance',
                                      'rules', 'declaration', 'minutes', 'other')),
  title           text,
  storage_bucket  text not null default 'building-docs',
  storage_path    text not null,
  source_url      text,
  as_of           date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (storage_bucket, storage_path)
);
create index documents_building_idx on public.documents(building_id, doc_type);

-- ---------------------------------------------------------------------------
-- Sources: one row per fact. record_table/record_id point at any row above;
-- field_path is the profile path ("fees.dues_cover", "health.special_assessments[0].amount").
-- ---------------------------------------------------------------------------
create table public.sources (
  id            uuid primary key default gen_random_uuid(),
  building_id   uuid references public.buildings(id) on delete cascade,
  record_table  text not null,
  record_id     uuid,
  field_path    text not null,
  value         jsonb,
  url           text,
  as_of         date,
  as_of_text    text,
  origin        text not null default 'manual',   -- 'profile_loader' | 'manual' | ...
  created_at    timestamptz not null default now()
);
create index sources_building_idx on public.sources(building_id, field_path);
create index sources_record_idx on public.sources(record_table, record_id);

-- ---------------------------------------------------------------------------
-- Users, purchases, entitlements
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        text not null default 'user' check (role in ('user', 'admin')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.purchases (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid references auth.users(id) on delete set null,
  email                  text,
  plan                   text not null check (plan in ('building', 'statewide')),
  building_id            uuid references public.buildings(id) on delete set null,
  state                  char(2),
  stripe_session_id      text not null unique,
  stripe_payment_intent  text,
  stripe_customer_id     text,
  amount_cents           integer,
  currency               text default 'usd',
  status                 text not null default 'paid' check (status in ('pending', 'paid', 'refunded')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index purchases_user_idx on public.purchases(user_id);
create index purchases_email_idx on public.purchases(lower(email));
create index purchases_pi_idx on public.purchases(stripe_payment_intent);

create table public.entitlements (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users(id) on delete cascade,
  email        text,                       -- lets a guest checkout claim access by signing in with that email
  scope        text not null check (scope in ('building', 'county', 'state')),
  building_id  uuid references public.buildings(id) on delete cascade,
  county_id    uuid references public.counties(id) on delete cascade,
  state        char(2),
  purchase_id  uuid unique references public.purchases(id) on delete set null,
  granted_at   timestamptz not null default now(),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  check (user_id is not null or email is not null),
  check (
    (scope = 'building' and building_id is not null) or
    (scope = 'county'   and county_id   is not null) or
    (scope = 'state'    and state       is not null)
  )
);
create index entitlements_user_idx on public.entitlements(user_id);
create index entitlements_email_idx on public.entitlements(lower(email));
create index entitlements_building_idx on public.entitlements(building_id);

-- updated_at triggers
do $$
declare t text;
begin
  foreach t in array array['counties','cities','associations','buildings','fees','rules',
    'sirs_filings','milestone_inspections','special_assessments','loans','litigation',
    'insurance','sales_stats','documents','profiles','purchases']
  loop
    execute format('create trigger %I before update on public.%I
                    for each row execute function public.set_updated_at()', t || '_updated_at', t);
  end loop;
end $$;

-- Create a profile row for every new auth user.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Access functions (security definer so policies can read entitlements/profiles)
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;

-- Email match relies on Supabase only issuing JWTs for verified emails
-- (magic link / OTP sign-in). Keep "Confirm email" ON in Auth settings.
create or replace function public.has_building_access(bid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_admin() or exists (
    select 1
    from public.entitlements e
    join public.buildings b on b.id = bid
    where e.revoked_at is null
      and (e.expires_at is null or e.expires_at > now())
      and (
        (auth.uid() is not null and e.user_id = auth.uid())
        or (e.email is not null and e.email <> ''
            and lower(e.email) = lower(coalesce(auth.jwt() ->> 'email', '')))
      )
      and (
        (e.scope = 'building' and e.building_id = b.id)
        or (e.scope = 'county' and e.county_id = b.county_id)
        or (e.scope = 'state'  and e.state = b.state)
      )
  );
$$;

create or replace function public.has_building_access_by_slug(bslug text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select public.has_building_access(b.id) from public.buildings b where b.slug = bslug),
    false);
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- Start from nothing: Supabase grants broad table privileges to anon and
-- authenticated by default. Take them all back and grant only SELECT.
revoke all on all tables in schema public from anon, authenticated;
revoke execute on function public.is_admin(), public.has_building_access(uuid),
  public.has_building_access_by_slug(text) from public, anon;
grant execute on function public.is_admin(), public.has_building_access(uuid),
  public.has_building_access_by_slug(text) to authenticated, service_role;

alter table public.counties               enable row level security;
alter table public.cities                 enable row level security;
alter table public.associations           enable row level security;
alter table public.buildings              enable row level security;
alter table public.fees                   enable row level security;
alter table public.rules                  enable row level security;
alter table public.sirs_filings           enable row level security;
alter table public.milestone_inspections  enable row level security;
alter table public.special_assessments    enable row level security;
alter table public.loans                  enable row level security;
alter table public.litigation             enable row level security;
alter table public.insurance              enable row level security;
alter table public.sales_stats            enable row level security;
alter table public.documents              enable row level security;
alter table public.sources                enable row level security;
alter table public.profiles               enable row level security;
alter table public.purchases              enable row level security;
alter table public.entitlements           enable row level security;

-- Geography lists are not sensitive.
grant select on public.counties, public.cities to anon, authenticated;
create policy counties_public_read on public.counties for select to anon, authenticated using (true);
create policy cities_public_read   on public.cities   for select to anon, authenticated using (true);

-- Full building data: authenticated + entitled (or admin) only. anon gets no grant at all.
grant select on public.buildings, public.associations, public.fees, public.rules,
  public.sirs_filings, public.milestone_inspections, public.special_assessments,
  public.loans, public.litigation, public.insurance, public.sales_stats,
  public.documents, public.sources
  to authenticated;

create policy buildings_entitled_read on public.buildings
  for select to authenticated using (public.has_building_access(id));

create policy associations_entitled_read on public.associations
  for select to authenticated using (
    public.is_admin() or exists (
      select 1 from public.buildings b
      where b.association_id = associations.id and public.has_building_access(b.id)
    )
  );

do $$
declare t text;
begin
  foreach t in array array['fees','rules','sirs_filings','milestone_inspections',
    'special_assessments','loans','litigation','insurance','sales_stats','documents','sources']
  loop
    execute format('create policy %I on public.%I for select to authenticated
                    using (public.has_building_access(building_id))', t || '_entitled_read', t);
  end loop;
end $$;

-- Users see their own profile, purchases and entitlements.
grant select on public.profiles, public.purchases, public.entitlements to authenticated;

create policy profiles_own_read on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());

create policy purchases_own_read on public.purchases
  for select to authenticated using (
    user_id = auth.uid()
    or (email is not null and lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')))
    or public.is_admin()
  );

create policy entitlements_own_read on public.entitlements
  for select to authenticated using (
    user_id = auth.uid()
    or (email is not null and lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')))
    or public.is_admin()
  );

-- ---------------------------------------------------------------------------
-- Public teaser view. Runs with the view owner's rights (security_invoker =
-- false) so anon can read these six columns without any access to the base
-- tables. Add nothing sensitive here: this is the whole public surface.
-- ---------------------------------------------------------------------------
create view public.building_teasers
  with (security_invoker = false) as
  select
    b.slug,
    b.name,
    ci.name    as city,
    co.name    as county,
    b.state,
    b.year_built,
    b.units,
    b.risk_band
  from public.buildings b
  left join public.cities   ci on ci.id = b.city_id
  left join public.counties co on co.id = b.county_id
  where b.is_published;

revoke all on public.building_teasers from anon, authenticated;
grant select on public.building_teasers to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private bucket for SIRS / budget / milestone PDFs.
-- Path convention: <building-slug>/<file>.pdf
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('building-docs', 'building-docs', false)
on conflict (id) do nothing;

create policy building_docs_entitled_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'building-docs'
    and public.has_building_access_by_slug((storage.foldername(name))[1])
  );
