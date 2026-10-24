-- CoreHub R5 reference DB draft
-- 상태: staging 설계 초안. 운영/공유 Supabase에 실행하지 않음.
-- 목적: CoreNull outbox의 HMAC device event를 수신한 뒤 provenance와
--       Message snapshot을 보존하기 위한 최소 reference schema.
-- 보안: HMAC secret, Bearer token, refresh token은 이 schema에 저장하지 않는다.
-- 적용 전 필수: 별도 staging project/ref, R5 ADR, RLS/grant review, rollback review.

begin;

create schema if not exists corehub;

-- ---------------------------------------------------------------------------
-- 1. HMAC device registry
-- ---------------------------------------------------------------------------
-- secret 원문은 Secret Manager/worker runtime에만 존재한다.
-- key_version은 runtime secret rotation을 선택하는 metadata일 뿐이다.
create table if not exists corehub.device_registry (
  device_id text primary key,
  source_core text not null,
  key_version text not null,
  enabled boolean not null default true,
  allowed_event_types text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz null,
  constraint device_registry_device_id_ck
    check (btrim(device_id) <> ''),
  constraint device_registry_source_core_ck
    check (source_core ~ '^[A-Za-z][A-Za-z0-9._-]{0,63}$')
);

create index if not exists device_registry_source_enabled_idx
  on corehub.device_registry (source_core, enabled);

comment on table corehub.device_registry is
  'R5 worker device metadata. HMAC secrets are never stored here.';
comment on column corehub.device_registry.key_version is
  'External secret-manager key version selected by the HMAC verifier.';

-- ---------------------------------------------------------------------------
-- 2. HMAC nonce replay protection
-- ---------------------------------------------------------------------------
create table if not exists corehub.device_nonces (
  device_id text not null references corehub.device_registry(device_id),
  nonce text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (device_id, nonce),
  constraint device_nonces_nonce_ck
    check (btrim(nonce) <> ''),
  constraint device_nonces_expiry_ck
    check (expires_at > created_at)
);

create index if not exists device_nonces_expiry_idx
  on corehub.device_nonces (expires_at);

-- Atomic nonce claim. Caller must verify the HMAC before calling this function.
-- An expired nonce may be reclaimed only after the old row is removed under the
-- device advisory lock. A replayed live nonce returns false.
create or replace function corehub.claim_device_nonce(
  p_device_id text,
  p_nonce text,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, corehub
as $$
begin
  if p_device_id is null or btrim(p_device_id) = '' or
     p_nonce is null or btrim(p_nonce) = '' or
     p_expires_at is null or p_expires_at <= clock_timestamp() then
    raise exception 'invalid_nonce_claim' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('r5:nonce:' || p_device_id, 0)
  );

  delete from corehub.device_nonces
   where device_id = p_device_id
     and nonce = p_nonce
     and expires_at <= clock_timestamp();

  insert into corehub.device_nonces (device_id, nonce, expires_at)
  values (p_device_id, p_nonce, p_expires_at)
  on conflict (device_id, nonce) do nothing;

  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Immutable source ingress events
-- ---------------------------------------------------------------------------
create table if not exists corehub.source_events (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null,
  owner_id uuid null,
  subject_device_id text null references corehub.device_registry(device_id),
  source text not null,
  event_type text not null,
  event_id text not null,
  source_record_id text not null,
  source_revision bigint not null,
  occurred_at timestamptz not null,
  payload jsonb not null,
  payload_sha256 text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz null,
  constraint source_events_subject_ck check (
    (subject_type = 'user' and owner_id is not null and subject_device_id is null)
    or
    (subject_type = 'device' and owner_id is null and subject_device_id is not null)
  ),
  constraint source_events_subject_type_ck
    check (subject_type in ('user', 'device')),
  constraint source_events_source_ck
    check (source ~ '^[A-Za-z][A-Za-z0-9._-]{0,63}$'),
  constraint source_events_event_type_ck
    check (event_type ~ '^[A-Za-z][A-Za-z0-9._-]{0,127}$'),
  constraint source_events_record_ck
    check (btrim(source_record_id) <> ''),
  constraint source_events_revision_ck
    check (source_revision >= 1),
  constraint source_events_hash_ck
    check (payload_sha256 ~ '^[A-Fa-f0-9]{64}$')
);

create unique index if not exists source_events_user_event_uidx
  on corehub.source_events (owner_id, source, event_id)
  where subject_type = 'user';

create unique index if not exists source_events_device_event_uidx
  on corehub.source_events (subject_device_id, source, event_id)
  where subject_type = 'device';

create unique index if not exists source_events_device_revision_uidx
  on corehub.source_events (
    subject_device_id, source, event_type, source_record_id, source_revision
  )
  where subject_type = 'device';

create index if not exists source_events_device_time_idx
  on corehub.source_events (subject_device_id, occurred_at desc)
  where subject_type = 'device';

comment on table corehub.source_events is
  'Immutable accepted ingress events. It is not an approval or promotion table.';
comment on column corehub.source_events.payload is
  'Source snapshot only; no access token, HMAC secret, SQL, or command.';

-- ---------------------------------------------------------------------------
-- 4. CoreNull Message mirror
-- ---------------------------------------------------------------------------
create table if not exists corehub.message_mirror (
  id uuid primary key default gen_random_uuid(),
  source_core text not null,
  source_table text not null default 'messages',
  source_record_id text not null,
  source_revision bigint not null,
  source_event_id text not null,
  subject_device_id text null references corehub.device_registry(device_id),
  snapshot_payload jsonb not null,
  source_fingerprint text not null,
  captured_at timestamptz not null default now(),
  constraint message_mirror_revision_ck check (source_revision >= 1),
  constraint message_mirror_fingerprint_ck
    check (source_fingerprint ~ '^[A-Fa-f0-9]{64}$')
);

create unique index if not exists message_mirror_source_revision_uidx
  on corehub.message_mirror (
    source_core, source_table, source_record_id, source_revision
  );

create unique index if not exists message_mirror_event_uidx
  on corehub.message_mirror (source_event_id);

create index if not exists message_mirror_device_time_idx
  on corehub.message_mirror (subject_device_id, captured_at desc);

comment on table corehub.message_mirror is
  'Reference snapshot with provenance; not the official CoreNull source.';

-- ---------------------------------------------------------------------------
-- 5. Quarantine
-- ---------------------------------------------------------------------------
create table if not exists corehub.consumer_quarantine (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  subject_type text not null,
  subject_device_id text null,
  event_id text null,
  source_record_id text null,
  source_revision bigint null,
  reason_code text not null,
  http_status integer null,
  payload_sha256 text null,
  safe_payload jsonb null,
  retryable boolean not null default false,
  status text not null default 'open',
  first_seen_at timestamptz not null default now(),
  resolved_at timestamptz null,
  resolution_note text null,
  constraint quarantine_subject_type_ck
    check (subject_type in ('user', 'device', 'unknown')),
  constraint quarantine_status_ck
    check (status in ('open', 'reviewed', 'released', 'discarded')),
  constraint quarantine_hash_ck
    check (payload_sha256 is null or payload_sha256 ~ '^[A-Fa-f0-9]{64}$')
);

create index if not exists consumer_quarantine_open_idx
  on corehub.consumer_quarantine (status, first_seen_at)
  where status = 'open';

create index if not exists consumer_quarantine_event_idx
  on corehub.consumer_quarantine (source, event_id);

comment on column corehub.consumer_quarantine.safe_payload is
  'Optional redacted diagnostic payload. Never store tokens, secrets, or raw auth headers.';

-- ---------------------------------------------------------------------------
-- 6. Append-only consumer audit
-- ---------------------------------------------------------------------------
create table if not exists corehub.consumer_audit (
  id uuid primary key default gen_random_uuid(),
  trace_id text not null,
  source text not null,
  subject_type text not null,
  subject_device_id text null,
  owner_id uuid null,
  event_id text null,
  source_record_id text null,
  source_revision bigint null,
  result text not null,
  reason_code text null,
  http_status integer null,
  latency_ms integer null,
  created_at timestamptz not null default now(),
  constraint consumer_audit_subject_type_ck
    check (subject_type in ('user', 'device', 'unknown')),
  constraint consumer_audit_result_ck
    check (result in (
      'accepted', 'duplicate', 'conflict', 'quarantined', 'retry', 'rejected'
    ))
);

create index if not exists consumer_audit_event_time_idx
  on corehub.consumer_audit (event_id, created_at desc);

create index if not exists consumer_audit_result_time_idx
  on corehub.consumer_audit (result, created_at desc);

-- ---------------------------------------------------------------------------
-- 7. RLS and grants
-- ---------------------------------------------------------------------------
-- Direct client access is denied. API/RPC/worker use service_role or an
-- explicitly reviewed security-definer function. No authenticated client may
-- insert a device, nonce, ingress event, mirror, quarantine, or audit row.
alter table corehub.device_registry enable row level security;
alter table corehub.device_nonces enable row level security;
alter table corehub.source_events enable row level security;
alter table corehub.message_mirror enable row level security;
alter table corehub.consumer_quarantine enable row level security;
alter table corehub.consumer_audit enable row level security;

revoke all on table
  corehub.device_registry,
  corehub.device_nonces,
  corehub.source_events,
  corehub.message_mirror,
  corehub.consumer_quarantine,
  corehub.consumer_audit
from anon, authenticated;

revoke all on function corehub.claim_device_nonce(text, text, timestamptz)
from public, anon, authenticated;
grant execute on function corehub.claim_device_nonce(text, text, timestamptz)
to service_role;

grant select, insert, update on corehub.device_registry to service_role;
grant select, insert, delete on corehub.device_nonces to service_role;
grant select, insert, update on corehub.source_events to service_role;
grant select, insert, update on corehub.message_mirror to service_role;
grant select, insert, update on corehub.consumer_quarantine to service_role;
grant select, insert on corehub.consumer_audit to service_role;

commit;

-- Post-apply staging checks (run separately, read-only):
-- 1. Verify no table contains secret/token columns or values.
-- 2. Verify anon/authenticated INSERT/UPDATE/DELETE is denied.
-- 3. Verify claim_device_nonce returns true once and false on live replay.
-- 4. Verify expired nonce cleanup is serialized per device.
-- 5. Verify duplicate source event has one row and changed hash is quarantined.
-- 6. Verify duplicate message mirror has one row per source revision.
-- 7. Verify rollback/drop plan before any disposable staging apply.
