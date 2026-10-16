-- DRAFT ONLY — DO NOT APPLY TO PRODUCTION
-- Purpose: staging-only Auth UID ↔ House ownership contract.
-- Canonical table: public.corenull_houses.
-- Legacy owner_key is preserved. Existing rows remain owner_id = NULL.
-- Apply only after ADR approval and staging project confirmation.

begin;

alter table public.corenull_houses
  add column if not exists owner_id uuid null
  references auth.users(id) on delete restrict;

create index if not exists corenull_houses_owner_id_idx
  on public.corenull_houses (owner_id)
  where owner_id is not null;

comment on column public.corenull_houses.owner_id is
  'Verified Supabase Auth UID. NULL means legacy/unlinked House; no automatic backfill.';
comment on column public.corenull_houses.owner_key is
  'Legacy CoreNull owner identifier preserved for compatibility; never treated as Auth UID.';

create table if not exists public.corenull_owner_identities (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_sub text not null,
  owner_key uuid not null,
  auth_user_id uuid null references auth.users(id) on delete restrict,
  linked_at timestamptz null,
  link_method text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint corenull_owner_identities_provider_sub_ck
    check (btrim(provider) <> '' and btrim(provider_sub) <> ''),
  constraint corenull_owner_identities_link_method_ck
    check (link_method is null or link_method in ('new_signup', 'explicit_link', 'manual_review'))
);

create unique index if not exists corenull_owner_identities_provider_sub_uidx
  on public.corenull_owner_identities (provider, provider_sub);

create unique index if not exists corenull_owner_identities_provider_auth_uidx
  on public.corenull_owner_identities (provider, auth_user_id)
  where auth_user_id is not null;

create index if not exists corenull_owner_identities_owner_key_idx
  on public.corenull_owner_identities (owner_key);

comment on column public.corenull_owner_identities.auth_user_id is
  'Verified auth.users.id; NULL means legacy provider-to-owner_key mapping is not linked.';

-- Deliberately no UPDATE/backfill statement appears here.
-- Deliberately no RLS policy is added until the staging API/service-role boundary
-- and owner/member read model are approved.

commit;

-- Required pre-approval checks:
-- 1) confirm this is a disposable/staging Supabase project;
-- 2) confirm auth.users is the same project used by CoreNull;
-- 3) update CoreNull generated types and server routes;
-- 4) update CoreHub ownership query to public.corenull_houses;
-- 5) test linked and unlinked House behavior before any production rollout.
