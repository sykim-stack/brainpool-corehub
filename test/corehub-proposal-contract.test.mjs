import test from 'node:test'
import assert from 'node:assert/strict'
import {
  connectionIdentity,
  deterministicUuid,
  isHajunAiSentenceFact,
  messageReferences,
  opportunityIdentity,
  selectConnectionCandidates,
} from '../lib/corehub/proposal-contract.mjs'

const fact = (id, fact_type, occurred_at, payload = {}) => ({
  id,
  fact_type,
  occurred_at,
  payload,
})

test('same fact combination produces the same connection identity regardless of order', () => {
  const a = connectionIdentity('owner-a', 'cross.language', ['fact-1', 'fact-2'])
  const b = connectionIdentity('owner-a', 'cross.language', ['fact-2', 'fact-1', 'fact-1'])
  assert.equal(a, b)
})

test('different owner, type, or fact combination produces a different identity', () => {
  const base = connectionIdentity('owner-a', 'cross.language', ['fact-1', 'fact-2'])
  assert.notEqual(base, connectionIdentity('owner-b', 'cross.language', ['fact-1', 'fact-2']))
  assert.notEqual(base, connectionIdentity('owner-a', 'seed.risk', ['fact-1', 'fact-2']))
  assert.notEqual(base, connectionIdentity('owner-a', 'cross.language', ['fact-1', 'fact-3']))
})

test('seed risk is tied to the seed fact, not every later unrelated Fact', () => {
  const seed = fact('seed-1', 'space.seed.created', '2026-11-01T00:00:00Z')
  const chat = fact('chat-1', 'relation.chat.sent', '2026-11-02T00:00:00Z')
  const unrelated = fact('other-1', 'language.emotion.detected', '2026-11-03T00:00:00Z')
  const first = selectConnectionCandidates([chat, seed])
  const second = selectConnectionCandidates([unrelated, chat, seed])
  assert.deepEqual(first.find((x) => x.connection_type === 'seed.abandonment.risk')?.facts.map((x) => x.id), ['seed-1'])
  assert.deepEqual(second.find((x) => x.connection_type === 'seed.abandonment.risk')?.facts.map((x) => x.id), ['seed-1'])
})

test('fruit after seed suppresses seed risk and produces achievement pair', () => {
  const seed = fact('seed-1', 'space.seed.created', '2026-11-01T00:00:00Z')
  const fruit = fact('fruit-1', 'space.fruit.created', '2026-11-02T00:00:00Z')
  const candidates = selectConnectionCandidates([fruit, seed])
  assert.equal(candidates.some((x) => x.connection_type === 'seed.abandonment.risk'), false)
  assert.deepEqual(candidates.find((x) => x.connection_type === 'seed.to.fruit.achieved')?.facts.map((x) => x.id).sort(), ['fruit-1', 'seed-1'])
})

test('cross-language relationship uses one stable chat/message pair', () => {
  const chat = fact('chat-1', 'relation.chat.sent', '2026-11-01T00:00:00Z')
  const message = fact('message-1', 'space.message.created', '2026-11-02T00:00:00Z')
  const candidates = selectConnectionCandidates([message, chat])
  assert.deepEqual(candidates.find((x) => x.connection_type === 'cross.language.relationship')?.facts.map((x) => x.id).sort(), ['chat-1', 'message-1'])
})

test('HajunAI sentence is accepted only as a non-empty string', () => {
  assert.equal(isHajunAiSentenceFact({ source: 'HajunAI', payload: { sentence: '그대로 전달' } }), true)
  assert.equal(isHajunAiSentenceFact({ source: 'HajunAI', payload: { sentence: '  ' } }), false)
  assert.equal(isHajunAiSentenceFact({ source: 'CoreNull', payload: { sentence: 'text' } }), false)
})

test('message references preserve source and id without rewriting them', () => {
  const refs = messageReferences([
    fact('a', 'space.message.created', '2026-11-01', { message_id: 'M-1', message_source: 'CoreNull' }),
    fact('b', 'space.message.created', '2026-11-02', { message_id: 'M-1', message_source: 'CoreNull' }),
    fact('c', 'space.message.created', '2026-11-03', { message_id: 'M-2', message_source: 'CoreRing' }),
  ])
  assert.deepEqual(refs, [
    { message_id: 'M-1', message_source: 'CoreNull' },
    { message_id: 'M-2', message_source: 'CoreRing' },
  ])
})

test('deterministic UUIDs have UUID version 8 and RFC variant bits', () => {
  const value = deterministicUuid('test', ['a'])
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(opportunityIdentity('meaning', 'm-1'), opportunityIdentity('meaning', 'm-1'))
})
