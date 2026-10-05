import test from 'node:test'
import assert from 'node:assert/strict'
import {
  matchFactConnection,
  meaningForConnection,
  opportunityForMeaning,
} from '../lib/corehub/matching.mjs'
import { authenticateUser, getBearerToken } from '../lib/corehub/auth.mjs'

const ownerA = 'auth-user-a'
const ownerB = 'auth-user-b'
const houseA = 'house-a'
const at = (minute) => new Date(Date.UTC(2026, 9, 5, 0, minute)).toISOString()
const fact = (id, fact_type, payload, minute, overrides = {}) => ({
  id,
  fact_type,
  payload,
  occurred_at: at(minute),
  owner_id: ownerA,
  house_id: houseA,
  ...overrides,
})

test('seed achievement cites only the exact causal seed and fruit facts', () => {
  const seed = fact('seed-fact', 'space.seed.created', { seed_id: 'seed-42' }, 1)
  const unrelated = fact('unrelated', 'space.room.visited', { room_id: 'room-8' }, 2)
  const fruit = fact('fruit-fact', 'space.fruit.created', { seed_id: 'seed-42' }, 3)

  assert.deepEqual(matchFactConnection(fruit, [seed, unrelated, fruit]), {
    connection_type: 'seed.to.fruit.achieved',
    strength: 0.95,
    fact_ids: ['seed-fact', 'fruit-fact'],
  })
})

test('same event type without a shared stable seed_id is not linked', () => {
  const seed = fact('seed-fact', 'space.seed.created', { room_id: 'room-1' }, 1)
  const fruit = fact('fruit-fact', 'space.fruit.created', { room_id: 'room-1' }, 2)
  assert.equal(matchFactConnection(fruit, [seed, fruit]), null)
})

test('facts from another owner or house are never mixed', () => {
  const seed = fact('seed-fact', 'space.seed.created', { seed_id: 'seed-42' }, 1)
  const otherOwnerFruit = fact('fruit-a', 'space.fruit.created', { seed_id: 'seed-42' }, 2, { owner_id: ownerB })
  const otherHouseFruit = fact('fruit-b', 'space.fruit.created', { seed_id: 'seed-42' }, 2, { house_id: 'house-b' })
  assert.equal(matchFactConnection(otherOwnerFruit, [seed, otherOwnerFruit]), null)
  assert.equal(matchFactConnection(otherHouseFruit, [seed, otherHouseFruit]), null)
})

test('fruit cannot precede its seed in event time', () => {
  const seed = fact('seed-fact', 'space.seed.created', { seed_id: 'seed-42' }, 3)
  const fruit = fact('fruit-fact', 'space.fruit.created', { seed_id: 'seed-42' }, 2)
  assert.equal(matchFactConnection(fruit, [seed, fruit]), null)
})

test('translation and chat link only within the same conversation', () => {
  const translation = fact('translation', 'language.translated', { conversation_id: 'thread-1' }, 1)
  const unrelatedTranslation = fact('other-translation', 'language.translated', { conversation_id: 'thread-2' }, 1)
  const chat = fact('chat', 'relation.chat.sent', { conversation_id: 'thread-1' }, 2)

  assert.deepEqual(matchFactConnection(chat, [translation, unrelatedTranslation, chat]), {
    connection_type: 'cross.language.relationship',
    strength: 0.8,
    fact_ids: ['translation', 'chat'],
  })
})

test('absence of a visit is not treated as abandonment without an explicit due event', () => {
  const seed = fact('seed', 'space.seed.created', { seed_id: 'seed-42' }, 1)
  const unrelated = fact('visit', 'space.room.visited', { room_id: 'room-1' }, 900)
  assert.equal(matchFactConnection(unrelated, [seed, unrelated]), null)
})

test('abandonment requires an explicit due event for the same seed', () => {
  const seed = fact('seed', 'space.seed.created', { seed_id: 'seed-42' }, 1)
  const due = fact('due', 'space.seed.abandonment_due', { seed_id: 'seed-42' }, 2)
  assert.deepEqual(matchFactConnection(due, [seed, due]), {
    connection_type: 'seed.abandonment.risk',
    strength: 0.7,
    fact_ids: ['seed', 'due'],
  })
})

test('meaning and opportunity mappings preserve the detected evidence type', () => {
  assert.deepEqual(meaningForConnection('seed.to.fruit.achieved'), {
    meaning_type: 'goal.achieved', confidence: 0.95,
  })
  assert.equal(meaningForConnection('unknown'), null)
  assert.equal(opportunityForMeaning('goal.achieved').opportunity_type, 'celebrate.achievement')
  assert.equal(opportunityForMeaning('unknown'), null)
})

test('only a syntactically valid Bearer token is accepted', () => {
  assert.equal(getBearerToken(new Request('https://example.test', {
    headers: { Authorization: 'Bearer signed.jwt.token' },
  })), 'signed.jwt.token')
  assert.equal(getBearerToken(new Request('https://example.test', {
    headers: { Authorization: 'Basic signed.jwt.token' },
  })), null)
})

test('Supabase Auth user ID comes from verified token, not request data', async () => {
  let receivedToken = null
  const result = await authenticateUser(
    new Request('https://example.test', { headers: { Authorization: 'Bearer token-1' } }),
    { auth: { getUser: async (token) => {
      receivedToken = token
      return { data: { user: { id: ownerA } }, error: null }
    } } },
  )
  assert.equal(receivedToken, 'token-1')
  assert.deepEqual(result, { ok: true, userId: ownerA })
})

test('missing or invalid token fails closed; Auth outage is retryable 503', async () => {
  const neverCall = { auth: { getUser: async () => { throw new Error('must not be called') } } }
  assert.equal((await authenticateUser(new Request('https://example.test'), neverCall)).status, 401)

  const invalid = await authenticateUser(
    new Request('https://example.test', { headers: { Authorization: 'Bearer expired' } }),
    { auth: { getUser: async () => ({ data: { user: null }, error: { status: 401 } }) } },
  )
  assert.deepEqual(invalid, { ok: false, status: 401, error: 'invalid_access_token' })

  const outage = await authenticateUser(
    new Request('https://example.test', { headers: { Authorization: 'Bearer token' } }),
    { auth: { getUser: async () => ({ data: null, error: { status: 500 } }) } },
  )
  assert.deepEqual(outage, { ok: false, status: 503, error: 'authentication_service_unavailable' })
})
