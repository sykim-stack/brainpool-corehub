-- DRAFT ONLY — DO NOT APPLY TO PRODUCTION
-- Target confirmed by read-only metadata: grlfocvlfatuvphkyivd
-- Canonical House table already exists as corenull.houses.
-- corenull.houses.owner_id is already uuid -> auth.users(id).
-- This draft does not alter House ownership columns and does not backfill data.
-- Apply only after the project is explicitly confirmed as disposable staging.

begin;

-- Existing canonical House ownership contract: no owner_id ALTER is needed.
-- Expected precondition:
-- corenull.houses.owner_id uuid references auth.users(id)
-- corenull.houses.owner_key text remains legacy/correlation data.

alter table public.corenull_owner_identities
  add column if not exists auth_user_id uuid null
    references auth.users(id) on delete restrict,
  add column if not exists linked_at timestamptz null,
  add column if not exists link_method text null,
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists corenull_owner_identities_provider_sub_uidx
  on public.corenull_owner_identities (provider, provider_sub);

create unique index if not exists corenull_owner_identities_provider_auth_uidx
  on public.corenull_owner_identities (provider, auth_user_id)
  where auth_user_id is not null;

create index if not exists corenull_owner_identities_owner_key_idx
  on public.corenull_owner_identities (owner_key);

comment on column public.corenull_owner_identities.auth_user_id is
  'Verified auth.users.id; NULL means legacy provider-to-owner_key mapping is not linked.';
comment on column public.corenull_owner_identities.owner_key is
  'Legacy CoreNull Identity Platform key; never treated as Auth UID.';

-- Do not backfill existing identity rows or corenull.houses rows.
-- Do not update corenull.houses.owner_id.
-- Do not add RLS policies until the CoreNull API/service boundary is approved.

commit;

-- Required pre-apply checks:
-- 1) explicitly confirm this project is disposable staging;
-- 2) verify corenull.houses.owner_id FK still targets auth.users(id);
-- 3) check duplicate (provider, provider_sub) rows before creating the unique index;
-- 4) check duplicate non-null (provider, auth_user_id) mappings;
-- 5) snapshot row counts and NULL/non-NULL ownership counts;
-- 6) run linked/unlinked House and identity conflict tests;
-- 7) record migration result and rollback plan.
