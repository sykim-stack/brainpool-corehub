import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { opportunityForMeaning } from '../lib/corehub/matching.mjs'

const migrationUrl = new URL(
  '../supabase/migrations/20261005150000_corehub_auth_idempotent_processing.sql',
  import.meta.url,
)
const sql = await readFile(migrationUrl, 'utf8')
const deviceMigrationUrl = new URL(
  '../supabase/migrations/20261026_corehub_device_principal_and_registry.sql',
  import.meta.url,
)
const deviceSql = await readFile(deviceMigrationUrl, 'utf8')

test('all derived meanings use one consumer-neutral proposal action', () => {
  const cases = [
    ['goal.achieved', 'celebrate.achievement'],
    ['new.relationship.forming', 'suggest.translation.help'],
    ['seed.at.risk', 'nudge.seed.owner'],
  ]

  for (const [meaningType, expectedOpportunityType] of cases) {
    const proposal = opportunityForMeaning(meaningType)
    assert.equal(proposal.opportunity_type, expectedOpportunityType)
    assert.equal(proposal.action_type, 'proposal')
    assert.equal(Object.hasOwn(proposal, 'payload'), false)
  }
})

test('database RPC persists references and derived meaning, not authored wording', () => {
  assert.match(sql, /'proposal',\s*v_proposal_payload/)
  assert.match(sql, /'meaning_type',\s*v_meaning_type/)
  assert.match(sql, /'confidence',\s*v_confidence/)
  assert.match(sql, /'fact_ids',\s*to_jsonb\(array\[v_first_fact_id, v_second_fact_id\]\)/)
  assert.match(sql, /'message_id',\s*refs\.message_id/)
  assert.match(sql, /'message_source',\s*refs\.message_source/)
  assert.match(sql, /'references',\s*coalesce\(v_message_refs, '\[\]'::jsonb\)/)
  assert.doesNotMatch(sql, /trigger\.hajunai|suggest\.corering/)
  assert.doesNotMatch(sql, /씨앗이 기다리고 있어요|번역 도움이 필요하신가요|씨앗이 열매가 됐어요/)
  assert.doesNotMatch(sql, /\bv_message\b|\bv_action_type\b/)
})

test('connection, meaning, and opportunity layers have database dedupe constraints', () => {
  assert.match(sql, /create unique index if not exists connections_dedupe_key_uidx/)
  assert.match(sql, /create unique index if not exists meanings_source_connection_uidx/)
  assert.match(sql, /create unique index if not exists opportunities_meaning_type_uidx/)
  assert.match(sql, /on conflict \(dedupe_key\).*?do nothing/s)
  assert.match(sql, /on conflict \(source_connection_id\).*?do nothing/s)
  assert.match(sql, /on conflict \(source_meaning_id, opportunity_type\).*?do nothing/s)
})

test('device migration preserves authenticated-owner derivation RPC', () => {
  assert.doesNotMatch(
    deviceSql,
    /drop function if exists corehub\.process_fact_event\([\s\S]*?uuid, text, text, text, uuid, timestamptz, jsonb\)/,
  )
  assert.match(deviceSql, /return corehub\.process_fact_event\(/)
  assert.match(deviceSql, /Device principal: retain the Fact for traceability/)
  assert.match(deviceSql, /create or replace function corehub\.process_device_fact_event\(/)
})
