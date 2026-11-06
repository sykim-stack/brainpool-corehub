-- CoreRing P4 assertion replay ledger — DRAFT ONLY
--
-- This migration is intentionally not applied by this task.
-- It creates only the server-owned replay ledger and its atomic consume RPC.
-- It does not connect the RPC to a resource route or enable the new issuer.
--
-- Contract consumed by:
--   lib/corehub/core-ring-p4-adapter.mjs
-- RPC:
--   corehub.corehub_consume_corering_p4_jti(text, text, timestamptz) -> boolean
--
-- Security properties:
--   * raw assertions, cookies, owner_key, provider_sub and device_id are not stored;
--   * (issuer, jti) is the atomic replay key;
--   * anon/authenticated cannot read or execute the ledger/RPC;
--   * service_role is the only API role granted execute permission.

begin;

create schema if not exists corehub;

create table if not exists corehub.corering_p4_assertion_replays (
  issuer text not null,
  jti text not null,
  first_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint corering_p4_assertion_replays_pk primary key (issuer, jti),
  constraint corering_p4_assertion_replays_issuer_length
    check (length(issuer) between 1 and 512),
  constraint corering_p4_assertion_replays_jti_length
    check (length(jti) between 1 and 512),
  constraint corering_p4_assertion_replays_expiry_after_first_seen
    check (expires_at >= first_seen_at)
);

comment on table corehub.corering_p4_assertion_replays is
  'Server-owned one-time consume ledger for CoreRing P4 assertions; stores no raw token.';
comment on column corehub.corering_p4_assertion_replays.issuer is
  'Exact configured assertion issuer; part of the replay namespace.';
comment on column corehub.corering_p4_assertion_replays.jti is
  'Opaque assertion identifier; part of the atomic replay key.';
comment on column corehub.corering_p4_assertion_replays.expires_at is
  'Assertion expiry used for bounded retention and cleanup.';

create index if not exists corering_p4_assertion_replays_expires_at_idx
  on corehub.corering_p4_assertion_replays (expires_at);

-- The function returns true only for the first valid consume. A duplicate
-- (issuer, jti), invalid input, or already-expired assertion returns false.
-- A concurrent caller is serialized by the primary-key conflict path.
create or replace function corehub.corehub_consume_corering_p4_jti(
  p_issuer text,
  p_jti text,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_issuer is null
     or length(p_issuer) < 1
     or length(p_issuer) > 512
     or p_jti is null
     or length(p_jti) < 1
     or length(p_jti) > 512
     or p_expires_at is null
     or p_expires_at <= clock_timestamp() then
    return false;
  end if;

  insert into corehub.corering_p4_assertion_replays (
    issuer,
    jti,
    expires_at
  ) values (
    p_issuer,
    p_jti,
    p_expires_at
  )
  on conflict (issuer, jti) do nothing;

  return found;
end;
$$;

comment on function corehub.corehub_consume_corering_p4_jti(text, text, timestamptz) is
  'Atomically consumes one CoreRing P4 assertion jti; true only for first non-expired consume.';

-- RLS is enabled as defense in depth. The API roles receive neither table
-- privileges nor a permissive policy. service_role bypasses RLS by design.
alter table corehub.corering_p4_assertion_replays enable row level security;
drop policy if exists deny_direct_client_access
  on corehub.corering_p4_assertion_replays;
create policy deny_direct_client_access
  on corehub.corering_p4_assertion_replays
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

revoke all privileges on table corehub.corering_p4_assertion_replays
  from public, anon, authenticated;
revoke all privileges on function corehub.corehub_consume_corering_p4_jti(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function corehub.corehub_consume_corering_p4_jti(text, text, timestamptz)
  to service_role;

commit;

-- Operational follow-up, intentionally not part of this draft's apply step:
--   delete from corehub.corering_p4_assertion_replays
--   where expires_at < now() - interval '5 minutes';
-- Cleanup must run server-side with an approved operational mechanism and
-- must not be exposed as an anonymous/authenticated RPC.
