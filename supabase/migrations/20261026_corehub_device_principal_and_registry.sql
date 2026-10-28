-- DRAFT ONLY — DO NOT APPLY TO PRODUCTION
-- Choice B (2026-10-26): ADR-002 dual-principal Fact + PR #2 device_registry/nonce/message RPC stubs
-- Depends on: PR #2 migration 20261005150000_corehub_auth_idempotent_processing.sql
-- Target: disposable staging only. Confirm project ref before apply.
-- Live may already have device_registry / device_nonces — probe information_schema first.
-- Date: 2026-10-26

begin;

alter table corehub.facts
  add column if not exists device_id text;

comment on column corehub.facts.device_id is
  'Anonymous/device principal from verified worker HMAC; never client body. NULL when owner_id from Auth.';

alter table corehub.connections
  add column if not exists device_id text;

alter table corehub.meanings
  add column if not exists device_id text;

alter table corehub.opportunities
  add column if not exists target_device_id text;

alter table corehub.learning_logs
  add column if not exists device_id text;

create unique index if not exists facts_device_source_idempotency_uidx
  on corehub.facts (device_id, source, idempotency_key)
  where device_id is not null and idempotency_key is not null;

create index if not exists facts_device_time_idx
  on corehub.facts (device_id, occurred_at desc)
  where device_id is not null;

create index if not exists connections_device_idx
  on corehub.connections (device_id)
  where device_id is not null;

create index if not exists opportunities_target_device_idx
  on corehub.opportunities (target_device_id, created_at desc)
  where target_device_id is not null;

alter table corehub.facts
  drop constraint if exists facts_owner_or_device_chk;

alter table corehub.facts
  add constraint facts_owner_or_device_chk
  check (owner_id is not null or device_id is not null) not valid;

create table if not exists corehub.device_registry (
  device_id text primary key,
  source_core text not null,
  key_version text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint device_registry_source_core_chk
    check (source_core in ('CoreRing', 'CoreNull', 'corenull', 'CoreHub')),
  constraint device_registry_device_id_chk
    check (device_id ~ '^[A-Za-z0-9._:-]{8,200}$')
);

comment on table corehub.device_registry is
  'HMAC worker devices. secret lives in server env keyed by key_version — never store secret here.';

create table if not exists corehub.device_nonces (
  device_id text not null references corehub.device_registry (device_id) on delete cascade,
  nonce text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (device_id, nonce),
  constraint device_nonces_nonce_chk
    check (nonce ~ '^[A-Za-z0-9._~:-]{16,200}$')
);

create index if not exists device_nonces_expires_idx
  on corehub.device_nonces (expires_at);

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
  if p_device_id is null or p_nonce is null or p_expires_at is null then
    return false;
  end if;

  delete from corehub.device_nonces
  where device_id = p_device_id
    and expires_at < now();

  begin
    insert into corehub.device_nonces (device_id, nonce, expires_at)
    values (p_device_id, p_nonce, p_expires_at);
    return true;
  exception
    when unique_violation then
      return false;
  end;
end;
$$;

revoke all on function corehub.claim_device_nonce(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function corehub.claim_device_nonce(text, text, timestamptz)
  to service_role;

drop function if exists corehub.process_fact_event(
  uuid, text, text, text, uuid, timestamptz, jsonb
);

drop function if exists corehub.process_fact_event(
  uuid, text, text, text, text, uuid, timestamptz, jsonb
);

create or replace function corehub.process_fact_event(
  p_owner_id uuid,
  p_device_id text,
  p_source text,
  p_fact_type text,
  p_idempotency_key text,
  p_house_id uuid,
  p_occurred_at timestamptz,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, corehub
as $$
declare
  v_fact_id uuid;
  v_existing corehub.facts%rowtype;
  v_device text;
  v_duplicate boolean := false;
begin
  v_device := nullif(btrim(coalesce(p_device_id, '')), '');

  if p_owner_id is null and v_device is null then
    raise exception 'principal_required' using errcode = '22023';
  end if;

  if p_source is null or btrim(p_source) = '' or
     p_fact_type is null or btrim(p_fact_type) = '' or
     p_idempotency_key is null or btrim(p_idempotency_key) = '' or
     p_occurred_at is null then
    raise exception 'required_event_field_missing' using errcode = '22023';
  end if;

  if p_owner_id is null and p_house_id is not null then
    raise exception 'house_not_supported_for_device_principal' using errcode = '22023';
  end if;

  if p_owner_id is not null then
    insert into corehub.facts (
      source, fact_type, owner_id, owner_key, device_id, house_id,
      occurred_at, payload, processed, idempotency_key
    ) values (
      p_source, p_fact_type, p_owner_id, null, v_device, p_house_id,
      p_occurred_at, coalesce(p_payload, '{}'::jsonb), false, p_idempotency_key
    )
    on conflict (owner_id, source, idempotency_key)
      where owner_id is not null and idempotency_key is not null
    do nothing
    returning id into v_fact_id;

    if v_fact_id is null then
      select * into v_existing from corehub.facts
      where owner_id = p_owner_id and source = p_source
        and idempotency_key = p_idempotency_key
      for update;
      if not found then
        raise exception 'idempotency_record_not_found' using errcode = '40001';
      end if;
      if v_existing.fact_type is distinct from p_fact_type
         or v_existing.payload is distinct from coalesce(p_payload, '{}'::jsonb) then
        raise exception 'idempotency_key_reused_with_different_event' using errcode = '22023';
      end if;
      v_fact_id := v_existing.id;
      v_duplicate := true;
    end if;
  else
    insert into corehub.facts (
      source, fact_type, owner_id, owner_key, device_id, house_id,
      occurred_at, payload, processed, idempotency_key
    ) values (
      p_source, p_fact_type, null, null, v_device, null,
      p_occurred_at, coalesce(p_payload, '{}'::jsonb), false, p_idempotency_key
    )
    on conflict (device_id, source, idempotency_key)
      where device_id is not null and idempotency_key is not null
    do nothing
    returning id into v_fact_id;

    if v_fact_id is null then
      select * into v_existing from corehub.facts
      where device_id = v_device and source = p_source
        and idempotency_key = p_idempotency_key
      for update;
      if not found then
        raise exception 'idempotency_record_not_found' using errcode = '40001';
      end if;
      if v_existing.fact_type is distinct from p_fact_type
         or v_existing.payload is distinct from coalesce(p_payload, '{}'::jsonb) then
        raise exception 'idempotency_key_reused_with_different_event' using errcode = '22023';
      end if;
      v_fact_id := v_existing.id;
      v_duplicate := true;
    end if;
  end if;

  if not v_duplicate then
    update corehub.facts set processed = true where id = v_fact_id;
  elsif v_existing.processed is not true then
    update corehub.facts set processed = true where id = v_fact_id;
  end if;

  return jsonb_build_object(
    'fact_id', v_fact_id,
    'duplicate', v_duplicate,
    'connection_id', null,
    'meaning_id', null,
    'opportunity_id', null
  );
end;
$$;

revoke all on function corehub.process_fact_event(
  uuid, text, text, text, text, uuid, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function corehub.process_fact_event(
  uuid, text, text, text, text, uuid, timestamptz, jsonb
) to service_role;

create or replace function corehub.process_device_fact_event(
  p_device_id text,
  p_source text,
  p_event_type text,
  p_event_id text,
  p_source_record_id text,
  p_source_revision bigint,
  p_occurred_at timestamptz,
  p_payload jsonb,
  p_payload_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, corehub
as $$
declare
  v_fact_id uuid;
  v_existing corehub.facts%rowtype;
  v_duplicate boolean := false;
  v_payload jsonb;
begin
  if p_device_id is null or btrim(p_device_id) = '' then
    raise exception 'principal_required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from corehub.device_registry d
    where d.device_id = p_device_id and d.enabled is true
  ) then
    raise exception 'worker_device_scope_denied' using errcode = '42501';
  end if;

  v_payload := coalesce(p_payload, '{}'::jsonb)
    || jsonb_build_object(
         'event_id', p_event_id,
         'source_record_id', p_source_record_id,
         'source_revision', p_source_revision,
         'payload_sha256', p_payload_sha256
       );

  insert into corehub.facts (
    source, fact_type, owner_id, device_id, house_id,
    occurred_at, payload, processed, idempotency_key
  ) values (
    p_source, p_event_type, null, p_device_id, null,
    p_occurred_at, v_payload, false, p_event_id
  )
  on conflict (device_id, source, idempotency_key)
    where device_id is not null and idempotency_key is not null
  do nothing
  returning id into v_fact_id;

  if v_fact_id is null then
    select * into v_existing from corehub.facts
    where device_id = p_device_id and source = p_source
      and idempotency_key = p_event_id
    for update;
    if not found then
      raise exception 'idempotency_record_not_found' using errcode = '40001';
    end if;
    if v_existing.fact_type is distinct from p_event_type then
      raise exception 'idempotency_key_reused_with_different_event' using errcode = '22023';
    end if;
    v_fact_id := v_existing.id;
    v_duplicate := true;
  end if;

  if not v_duplicate then
    update corehub.facts set processed = true where id = v_fact_id;
  end if;

  return jsonb_build_object(
    'fact_id', v_fact_id,
    'duplicate', v_duplicate
  );
end;
$$;

revoke all on function corehub.process_device_fact_event(
  text, text, text, text, text, bigint, timestamptz, jsonb, text
) from public, anon, authenticated;
grant execute on function corehub.process_device_fact_event(
  text, text, text, text, text, bigint, timestamptz, jsonb, text
) to service_role;

commit;
