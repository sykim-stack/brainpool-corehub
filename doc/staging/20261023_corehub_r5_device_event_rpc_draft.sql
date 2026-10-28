-- CoreHub R5 Stage A device event RPC draft
-- 상태: staging 설계 초안. 실행하지 않음.
-- 목적: HMAC verifier가 확정한 device_id를 이용해 source_events와
--       message_mirror만 원자적으로 기록한다.
-- 주의: 기존 legacy corehub.facts를 사용하지 않는다.
--       HMAC 검증 자체는 API/worker layer에서 수행하고, 이 RPC는
--       service_role 전용으로 호출되어야 한다.

begin;

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
  v_device corehub.device_registry%rowtype;
  v_event_id uuid;
  v_existing corehub.source_events%rowtype;
  v_mirror_id uuid;
  v_existing_mirror corehub.message_mirror%rowtype;
  v_inserted boolean := false;
  v_duplicate boolean := false;
  v_is_message_created boolean := false;
begin
  if p_device_id is null or btrim(p_device_id) = '' then
    raise exception 'device_id_required' using errcode = '22023';
  end if;
  if p_source is null or btrim(p_source) = '' or
     p_event_type is null or btrim(p_event_type) = '' or
     p_event_id is null or btrim(p_event_id) = '' or
     p_source_record_id is null or btrim(p_source_record_id) = '' or
     p_source_revision is null or p_source_revision < 1 or
     p_occurred_at is null or p_payload is null or
     p_payload_sha256 is null or
     p_payload_sha256 !~ '^[A-Fa-f0-9]{64}$' then
    raise exception 'required_device_event_field_missing' using errcode = '22023';
  end if;

  select * into v_device
  from corehub.device_registry
  where device_id = p_device_id
  for share;

  if not found or v_device.enabled is not true then
    raise exception 'device_not_registered_or_disabled' using errcode = '42501';
  end if;
  if v_device.source_core is distinct from p_source then
    raise exception 'device_source_not_allowed' using errcode = '42501';
  end if;
  if cardinality(v_device.allowed_event_types) is null or
     not (p_event_type = any(v_device.allowed_event_types)) then
    raise exception 'device_event_type_not_allowed' using errcode = '42501';
  end if;

  v_is_message_created :=
    p_source = 'CoreNull' and p_event_type = 'space.message.created';

  if not v_is_message_created then
    raise exception 'device_event_type_not_supported_in_stage_a' using errcode = '22023';
  end if;

  -- Advisory lock serializes duplicate/conflict checks for one device event.
  perform pg_advisory_xact_lock(
    hashtextextended('r5:device-event:' || p_device_id || ':' || p_source || ':' || p_event_id, 0)
  );

  insert into corehub.source_events (
    subject_type,
    owner_id,
    subject_device_id,
    source,
    event_type,
    event_id,
    source_record_id,
    source_revision,
    occurred_at,
    payload,
    payload_sha256
  ) values (
    'device',
    null,
    p_device_id,
    p_source,
    p_event_type,
    p_event_id,
    p_source_record_id,
    p_source_revision,
    p_occurred_at,
    p_payload,
    lower(p_payload_sha256)
  )
  on conflict (subject_device_id, source, event_id)
    where subject_device_id is not null
  do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select * into v_existing
    from corehub.source_events
    where subject_type = 'device'
      and subject_device_id = p_device_id
      and source = p_source
      and event_id = p_event_id
    for update;

    if not found then
      raise exception 'device_event_idempotency_record_not_found' using errcode = '40001';
    end if;

    if v_existing.event_type is distinct from p_event_type or
       v_existing.source_record_id is distinct from p_source_record_id or
       v_existing.source_revision is distinct from p_source_revision or
       v_existing.occurred_at is distinct from p_occurred_at or
       v_existing.payload_sha256 is distinct from lower(p_payload_sha256) or
       v_existing.payload is distinct from p_payload then
      raise exception 'device_event_id_reused_with_different_payload' using errcode = '22023';
    end if;

    v_event_id := v_existing.id;
    v_duplicate := true;
  else
    v_inserted := true;
  end if;

  -- Stage A only mirrors a created Message. No user-owned Fact, Connection,
  -- Meaning, or Opportunity is created by this device RPC.
  insert into corehub.message_mirror (
    source_core,
    source_table,
    source_record_id,
    source_revision,
    source_event_id,
    subject_device_id,
    snapshot_payload,
    source_fingerprint
  ) values (
    p_source,
    'messages',
    p_source_record_id,
    p_source_revision,
    p_event_id,
    p_device_id,
    p_payload,
    lower(p_payload_sha256)
  )
  on conflict (source_core, source_table, source_record_id, source_revision)
    do nothing
  returning id into v_mirror_id;

  if v_mirror_id is null then
    select * into v_existing_mirror
    from corehub.message_mirror
    where source_core = p_source
      and source_table = 'messages'
      and source_record_id = p_source_record_id
      and source_revision = p_source_revision
    for update;

    if not found or
       v_existing_mirror.source_fingerprint is distinct from lower(p_payload_sha256) or
       v_existing_mirror.snapshot_payload is distinct from p_payload then
      raise exception 'message_mirror_revision_conflict' using errcode = '22023';
    end if;

    v_mirror_id := v_existing_mirror.id;
  end if;

  update corehub.source_events
  set processed_at = coalesce(processed_at, clock_timestamp())
  where id = v_event_id;

  return jsonb_build_object(
    'event_id', v_event_id,
    'mirror_id', v_mirror_id,
    'duplicate', v_duplicate and not v_inserted,
    'subject_type', 'device',
    'device_id', p_device_id,
    'derived_processing', false
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

-- Staging test cases, to be executed only after explicit approval:
-- 1. Unregistered/disabled device -> 403-equivalent RPC error.
-- 2. Device source/event allowlist mismatch -> rejected.
-- 3. First accepted event -> one source_events and one message_mirror row.
-- 4. Same device/source/event_id and identical body -> duplicate result.
-- 5. Same device/source/event_id and changed payload/hash -> conflict, no overwrite.
-- 6. Same source_record_id/revision and changed payload -> mirror conflict.
-- 7. Device event never creates user-owned facts/connections/meanings/opportunities.
-- 8. Concurrent same-event calls -> one ingress row and one mirror row.
-- 9. No top-level house_id enters this RPC; payload house_id is non-authoritative.
