begin;

-- New records are keyed by the verified Supabase Auth user ID. Existing rows
-- remain NULL and are deliberately not auto-linked to any user.
alter table corehub.facts
  add column if not exists owner_id uuid,
  add column if not exists idempotency_key text,
  alter column owner_key drop not null;

alter table corehub.connections
  add column if not exists owner_id uuid,
  add column if not exists dedupe_key text;

alter table corehub.meanings
  add column if not exists owner_id uuid,
  add column if not exists source_connection_id uuid;

alter table corehub.opportunities
  add column if not exists target_owner_id uuid,
  alter column target_owner_key drop not null;

alter table corehub.learning_logs
  add column if not exists owner_id uuid;

alter table corehub.meanings
  add constraint meanings_source_connection_id_fkey
  foreign key (source_connection_id)
  references corehub.connections(id)
  on delete cascade;

create unique index if not exists facts_owner_source_idempotency_uidx
  on corehub.facts (owner_id, source, idempotency_key)
  where owner_id is not null and idempotency_key is not null;

create index if not exists facts_owner_house_time_idx
  on corehub.facts (owner_id, house_id, occurred_at desc);

create unique index if not exists connections_dedupe_key_uidx
  on corehub.connections (dedupe_key)
  where dedupe_key is not null;

create unique index if not exists meanings_source_connection_uidx
  on corehub.meanings (source_connection_id)
  where source_connection_id is not null;

create index if not exists meanings_owner_time_idx
  on corehub.meanings (owner_id, house_id, detected_at desc);

create unique index if not exists opportunities_meaning_type_uidx
  on corehub.opportunities (source_meaning_id, opportunity_type)
  where source_meaning_id is not null;

create index if not exists opportunities_owner_created_idx
  on corehub.opportunities (target_owner_id, created_at desc);

create unique index if not exists learning_logs_opportunity_owner_outcome_uidx
  on corehub.learning_logs (opportunity_id, owner_id, outcome)
  where owner_id is not null and outcome is not null;

comment on column corehub.facts.owner_id is
  'Verified Supabase Auth UID; NULL legacy rows are not auto-linked.';
comment on column corehub.opportunities.target_owner_id is
  'Verified Supabase Auth UID; NULL legacy rows are not auto-linked.';
comment on column corehub.facts.idempotency_key is
  'Stable source event key, scoped to owner_id and source.';

-- Defense in depth for direct PostgREST access. The server API still verifies
-- the JWT and derives owner_id; no client-supplied owner ID is trusted.
alter table corehub.facts enable row level security;
alter table corehub.connections enable row level security;
alter table corehub.meanings enable row level security;
alter table corehub.opportunities enable row level security;
alter table corehub.learning_logs enable row level security;

grant usage on schema corehub to authenticated;
grant select on corehub.facts, corehub.connections, corehub.meanings,
  corehub.opportunities, corehub.learning_logs to authenticated;
revoke insert, update, delete on corehub.facts, corehub.connections,
  corehub.meanings, corehub.opportunities, corehub.learning_logs
  from anon, authenticated;
grant usage on schema corehub to service_role;
grant select on corehub.facts, corehub.opportunities to service_role;
grant update on corehub.opportunities to service_role;
grant insert on corehub.learning_logs to service_role;

drop policy if exists corehub_facts_select_own on corehub.facts;
create policy corehub_facts_select_own on corehub.facts
  for select to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists corehub_connections_select_own on corehub.connections;
create policy corehub_connections_select_own on corehub.connections
  for select to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists corehub_meanings_select_own on corehub.meanings;
create policy corehub_meanings_select_own on corehub.meanings
  for select to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists corehub_opportunities_select_own on corehub.opportunities;
create policy corehub_opportunities_select_own on corehub.opportunities
  for select to authenticated
  using (target_owner_id = (select auth.uid()));

drop policy if exists corehub_learning_logs_select_own on corehub.learning_logs;
create policy corehub_learning_logs_select_own on corehub.learning_logs
  for select to authenticated
  using (owner_id = (select auth.uid()));

-- One RPC runs in one PostgreSQL transaction. A failure rolls back the Fact
-- and every derived row; retrying the same key either replays the result or
-- safely completes an unprocessed event. Advisory locking serializes related
-- events for one user/house so concurrent seed/fruit arrivals cannot miss each
-- other.
create or replace function corehub.process_fact_event(
  p_owner_id uuid,
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
  v_inserted boolean := false;
  v_duplicate boolean := false;
  v_first_fact_id uuid;
  v_second_fact_id uuid;
  v_connection_id uuid;
  v_meaning_id uuid;
  v_opportunity_id uuid;
  v_connection_type text;
  v_meaning_type text;
  v_confidence double precision;
  v_strength double precision;
  v_opportunity_type text;
  v_action_type text;
  v_priority text;
  v_message text;
  v_expires interval;
  v_dedupe_key text;
  v_ids_key text;
begin
  if p_owner_id is null then
    raise exception 'owner_id_required' using errcode = '22023';
  end if;
  if p_source is null or btrim(p_source) = '' or
     p_fact_type is null or btrim(p_fact_type) = '' or
     p_idempotency_key is null or btrim(p_idempotency_key) = '' or
     p_occurred_at is null then
    raise exception 'required_event_field_missing' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_owner_id::text || ':' || coalesce(p_house_id::text, 'no-house'), 0)
  );

  insert into corehub.facts (
    source, fact_type, owner_id, owner_key, house_id, occurred_at,
    payload, processed, idempotency_key
  ) values (
    p_source, p_fact_type, p_owner_id, null, p_house_id, p_occurred_at,
    coalesce(p_payload, '{}'::jsonb), false, p_idempotency_key
  )
  on conflict (owner_id, source, idempotency_key)
    where owner_id is not null and idempotency_key is not null
  do nothing
  returning id into v_fact_id;

  if v_fact_id is not null then
    v_inserted := true;
  else
    select * into v_existing
    from corehub.facts
    where owner_id = p_owner_id
      and source = p_source
      and idempotency_key = p_idempotency_key
    for update;

    if not found then
      raise exception 'idempotency_record_not_found' using errcode = '40001';
    end if;
    if v_existing.fact_type is distinct from p_fact_type or
       v_existing.house_id is distinct from p_house_id or
       v_existing.occurred_at is distinct from p_occurred_at or
       v_existing.payload is distinct from coalesce(p_payload, '{}'::jsonb) then
      raise exception 'idempotency_key_reused_with_different_event' using errcode = '22023';
    end if;

    v_fact_id := v_existing.id;
    v_duplicate := true;
    if v_existing.processed is true then
      return jsonb_build_object(
        'fact_id', v_fact_id,
        'duplicate', true,
        'connection_id', null,
        'meaning_id', null,
        'opportunity_id', null
      );
    end if;
  end if;

  -- Seed completion: require the same stable source seed_id and causal order.
  if p_fact_type in ('space.seed.created', 'space.fruit.created') then
    select seed.id, fruit.id into v_first_fact_id, v_second_fact_id
    from corehub.facts seed
    join corehub.facts fruit
      on fruit.owner_id = seed.owner_id
     and fruit.house_id is not distinct from seed.house_id
     and fruit.fact_type = 'space.fruit.created'
     and nullif(btrim(fruit.payload ->> 'seed_id'), '') =
         nullif(btrim(seed.payload ->> 'seed_id'), '')
     and fruit.occurred_at >= seed.occurred_at
    where seed.owner_id = p_owner_id
      and seed.house_id is not distinct from p_house_id
      and seed.fact_type = 'space.seed.created'
      and nullif(btrim(seed.payload ->> 'seed_id'), '') is not null
      and (seed.id = v_fact_id or fruit.id = v_fact_id)
    order by fruit.occurred_at desc, seed.occurred_at desc
    limit 1;

    if v_first_fact_id is not null then
      v_connection_type := 'seed.to.fruit.achieved';
      v_strength := 0.95;
      v_meaning_type := 'goal.achieved';
      v_confidence := 0.95;
      v_opportunity_type := 'celebrate.achievement';
      v_action_type := 'trigger.hajunai.celebrate';
      v_priority := 'high';
      v_message := '씨앗이 열매가 됐어요 🍎';
      v_expires := interval '72 hours';
    end if;
  end if;

  -- Cross-language relation: both facts must cite the same stable conversation.
  if v_first_fact_id is null and
     p_fact_type in ('language.translated', 'relation.chat.sent') then
    select translated.id, chat.id into v_first_fact_id, v_second_fact_id
    from corehub.facts translated
    join corehub.facts chat
      on chat.owner_id = translated.owner_id
     and chat.house_id is not distinct from translated.house_id
     and chat.fact_type = 'relation.chat.sent'
     and nullif(btrim(chat.payload ->> 'conversation_id'), '') =
         nullif(btrim(translated.payload ->> 'conversation_id'), '')
     and chat.occurred_at >= translated.occurred_at
    where translated.owner_id = p_owner_id
      and translated.house_id is not distinct from p_house_id
      and translated.fact_type = 'language.translated'
      and nullif(btrim(translated.payload ->> 'conversation_id'), '') is not null
      and (translated.id = v_fact_id or chat.id = v_fact_id)
    order by chat.occurred_at desc, translated.occurred_at desc
    limit 1;

    if v_first_fact_id is not null then
      v_connection_type := 'cross.language.relationship';
      v_strength := 0.8;
      v_meaning_type := 'new.relationship.forming';
      v_confidence := 0.8;
      v_opportunity_type := 'suggest.translation.help';
      v_action_type := 'suggest.corering';
      v_priority := 'medium';
      v_message := '번역 도움이 필요하신가요?';
      v_expires := interval '48 hours';
    end if;
  end if;

  -- Do not infer abandonment from absence. The source emits an explicit due
  -- event only after its own lifecycle rule says a seed is overdue.
  if v_first_fact_id is null and p_fact_type = 'space.seed.abandonment_due' then
    select seed.id, due.id into v_first_fact_id, v_second_fact_id
    from corehub.facts seed
    join corehub.facts due
      on due.owner_id = seed.owner_id
     and due.house_id is not distinct from seed.house_id
     and due.fact_type = 'space.seed.abandonment_due'
     and nullif(btrim(due.payload ->> 'seed_id'), '') =
         nullif(btrim(seed.payload ->> 'seed_id'), '')
     and due.occurred_at >= seed.occurred_at
    where seed.owner_id = p_owner_id
      and seed.house_id is not distinct from p_house_id
      and seed.fact_type = 'space.seed.created'
      and nullif(btrim(seed.payload ->> 'seed_id'), '') is not null
      and due.id = v_fact_id
    order by due.occurred_at desc, seed.occurred_at desc
    limit 1;

    if v_first_fact_id is not null then
      v_connection_type := 'seed.abandonment.risk';
      v_strength := 0.7;
      v_meaning_type := 'seed.at.risk';
      v_confidence := 0.72;
      v_opportunity_type := 'nudge.seed.owner';
      v_action_type := 'trigger.hajunai.nudge';
      v_priority := 'high';
      v_message := '씨앗이 기다리고 있어요';
      v_expires := interval '24 hours';
    end if;
  end if;

  if v_first_fact_id is not null then
    select string_agg(id::text, ':' order by id::text)
      into v_ids_key
    from unnest(array[v_first_fact_id, v_second_fact_id]) as ids(id);
    v_dedupe_key := v_connection_type || ':' || v_ids_key;

    insert into corehub.connections (
      fact_ids, connection_type, strength, owner_key, house_id, owner_id, dedupe_key
    ) values (
      array[v_first_fact_id, v_second_fact_id], v_connection_type, v_strength,
      null, p_house_id, p_owner_id, v_dedupe_key
    )
    on conflict (dedupe_key) where dedupe_key is not null do nothing
    returning id into v_connection_id;

    if v_connection_id is null then
      select id into v_connection_id
      from corehub.connections where dedupe_key = v_dedupe_key;
    end if;

    insert into corehub.meanings (
      meaning_type, confidence, source_fact_ids, connection_ids,
      owner_key, house_id, owner_id, source_connection_id
    ) values (
      v_meaning_type, v_confidence, array[v_first_fact_id, v_second_fact_id],
      array[v_connection_id], null, p_house_id, p_owner_id, v_connection_id
    )
    on conflict (source_connection_id)
      where source_connection_id is not null do nothing
    returning id into v_meaning_id;

    if v_meaning_id is null then
      select id into v_meaning_id
      from corehub.meanings where source_connection_id = v_connection_id;
    end if;

    insert into corehub.opportunities (
      opportunity_type, source_meaning_id, target_owner_key, target_owner_id,
      priority, action_type, payload, is_consumed, expires_at
    ) values (
      v_opportunity_type, v_meaning_id, null, p_owner_id,
      v_priority, v_action_type, jsonb_build_object('message', v_message),
      false, now() + v_expires
    )
    on conflict (source_meaning_id, opportunity_type)
      where source_meaning_id is not null do nothing
    returning id into v_opportunity_id;

    if v_opportunity_id is null then
      select id into v_opportunity_id
      from corehub.opportunities
      where source_meaning_id = v_meaning_id
        and opportunity_type = v_opportunity_type;
    end if;
  end if;

  update corehub.facts set processed = true where id = v_fact_id;

  return jsonb_build_object(
    'fact_id', v_fact_id,
    'duplicate', v_duplicate and not v_inserted,
    'connection_id', v_connection_id,
    'meaning_id', v_meaning_id,
    'opportunity_id', v_opportunity_id
  );
end;
$$;

revoke all on function corehub.process_fact_event(
  uuid, text, text, text, uuid, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function corehub.process_fact_event(
  uuid, text, text, text, uuid, timestamptz, jsonb
) to service_role;

commit;
